import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { RbacError, type AuthContext } from "@/lib/rbac";
import { publishNotify, publishStaffNotify } from "@/lib/notify";

/**
 * 轉交 / 派單核心（MD §3.1）— Send Lock 體系嘅唯一 assign 入口。
 *
 * 單一 $transaction（五步，MD §3.1）：
 *   1) 驗證 toStaffId 屬同店 active（route 層已 assertClinicAccess + 權限檢查）
 *   2) conversation.update（assigneeId + assignedAt；updateMany 樂觀鎖防並發轉交 race）
 *   3) 自動生成 INTERNAL note（轉交原因永遠留喺 thread — 重用 Message 表 = 同病人訊息
 *      同等保護：at-rest 加密 / log redaction / per-clinic RBAC / retention）
 *   4) AuditLog（TRANSFER / UNASSIGN / AUTO_CLAIM；metadata only — 零訊息原文）
 *   5) touch lastMessageAt（★ 唔加 unreadCount — 病人冇新嘢）
 * transaction 提交後 → socket conversation:assigned（room clinic:{id}，payload 零內文）
 *   + ★ H2：notify:mention 定向發畀被派者（自動 note 已帶 mentions=[toStaffId] — 轉交 = 必有通知）。
 *
 * 權限模型（assertCanAssign，route 層調；cwi-h6-20260830 多店矩陣，MD §3）：
 *   | 動作 | actor | target |
 *   | CLAIM（搶俾自己） | ADMIN ∨ conv.clinicId ∈ actor.clinicIds | = actor 自己 |
 *   | ASSIGN（指派） | 對條線有 access（§0：ADMIN ∨ 店集合 ∨ 單線授權） | 任何 active STAFF/ADMIN（可外店） |
 *   | RELEASE（放手） | 現任 assignee ∨ ADMIN | — |
 *   | ❌ 外店 self-claim | conv.clinicId ∉ actor.clinicIds 且非 ADMIN | 403 CROSS_CLINIC_CLAIM_FORBIDDEN |
 *   接手（takeover：舊 assignee → 新 assignee 換人）必帶三副作用：INTERNAL 備註留痕 +
 *   原負責人 StaffNotice（零 PII）+ audit takeover:true；樂觀鎖 assignVersion 輸家收 409。
 *
 * 調用方：
 *   - POST /api/conversations/[id]/assign（人手轉交 / 接手 / 放返隊列）
 *   - /api/messages/send + /api/conversations/[id]/flows（unassigned 首發 AUTO_CLAIM）
 *   - H3：ai.worker 分類完成後 pickAssignee → by="SYSTEM"（只准 unassigned 對話）
 */

/** lib 層 API 錯誤（api-error.toResponse 識別 → 對應 HTTP status）。 */
export class AssignError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AssignError";
  }
}

export type AssignBy = "STAFF" | "AUTO_CLAIM" | "SYSTEM" | "AUTO_RELEASE";

export interface AssignConversationOptions {
  conversationId: string;
  /** null = 放返隊列（unassign） */
  toStaffId: string | null;
  /** 動作來源：STAFF = 人手（route 已驗權限）/ AUTO_CLAIM = 首發自動 / SYSTEM = H3 自動派單 */
  by: AssignBy;
  /** 操作者 staffId（STAFF / AUTO_CLAIM 必填；SYSTEM = null — 無 staff 參與） */
  byStaffId?: string | null;
  /** 轉交留言（1..2000；null = 用自動文案） */
  note?: string;
  /**
   * ★ Realtime P0 (R5, cwi-rt-20260823-a1)：client 端持有的 assignVersion（樂觀鎖）。
   * 人手 assign/接手/放返傳入 → updateMany({where:{id, assignVersion:v}}) count=0 → 409 ASSIGN_CONFLICT。
   * AUTO_CLAIM / SYSTEM 唔傳（null/undefined）→ 保留舊 assigneeId lock 語義（防並發轉交 race）。
   */
  expectedAssignVersion?: number | null;
}

export type AssignAuditAction = "TRANSFER" | "UNASSIGN" | "AUTO_CLAIM";

export interface AssignResult {
  conversationId: string;
  clinicId: string;
  fromStaffId: string | null;
  assigneeId: string | null;
  assignedAt: Date;
  /** ★ Realtime P0 (R5)：成功後嘅新版本號（read 時 +1 — updateMany 已 commit）→ socket/UI 同步 */
  assignVersion: number;
  /** 自動 INTERNAL note 嘅 Message id（thread 內「轉交原因」） */
  noteMessageId: string;
  auditAction: AssignAuditAction;
}

/**
 * 權限檢查（cwi-h6-20260830 多店矩陣，MD §3；取代 h5 §2.2）：
 *   - ADMIN → 任何動作（force reassign / claim / release）
 *   - CLAIM（toStaffId = 自己）：conv.clinicId ∈ actor.clinicIds；
 *     外店 self-claim → 403 CROSS_CLINIC_CLAIM_FORBIDDEN
 *   - ASSIGN（toStaffId = 其他人）：actor 對條線有 access（§0：店集合 ∨ 單線授權 assignee==自己）；
 *     target = 任何 active STAFF/ADMIN（可完全外店 — transaction 內只驗 active）
 *   - RELEASE（toStaffId = null）：現任 assignee ∨ ADMIN
 */
export function assertCanAssign(
  ctx: Pick<AuthContext, "staff" | "clinicIds">,
  conv: { clinicId: string; assigneeId: string | null },
  toStaffId: string | null
): void {
  if (ctx.staff.role === "ADMIN") return;

  const inMyClinic = ctx.clinicIds.includes(conv.clinicId);
  // §0 access：店集合 ∨ 單線授權（我係現任 assignee）
  const hasLineAccess = inMyClinic || conv.assigneeId === ctx.staff.id;

  if (toStaffId === null) {
    // RELEASE：現任 assignee ∨ ADMIN（ADMIN 已 return）
    if (ctx.staff.id !== conv.assigneeId) {
      throw new RbacError(403, "only the current assignee or an admin can release");
    }
    return;
  }

  if (toStaffId === ctx.staff.id) {
    // CLAIM / 接手（自己）：必須對條線有 access
    if (!hasLineAccess) {
      // 外店 self-claim（店集合冇呢間店 且 我唔係現任 assignee）— 明確錯誤碼（E2E T96）
      throw new RbacError(403, "CROSS_CLINIC_CLAIM_FORBIDDEN");
    }
    return;
  }

  // ASSIGN（派其他人）：actor 對條線有 access（店集合 ∨ 單線授權）；target 任何 active（tx 內驗）
  if (!hasLineAccess) {
    throw new RbacError(403, "no access to this conversation");
  }
}

export async function assignConversation(opts: AssignConversationOptions): Promise<AssignResult> {
  const { conversationId, toStaffId, by, note } = opts;
  const byStaffId = opts.byStaffId ?? null;
  // STAFF / AUTO_CLAIM 必有人；SYSTEM / AUTO_RELEASE = 系統動作（無 staff 參與）
  if (by !== "SYSTEM" && by !== "AUTO_RELEASE" && !byStaffId) {
    throw new AssignError(400, "ASSIGN_BAD_INPUT", "byStaffId is required for STAFF/AUTO_CLAIM");
  }

  const result = await prisma.$transaction(async (tx) => {
    const conv = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new AssignError(404, "NOT_FOUND", "conversation not found");

    // 1) toStaffId 必須係 active staff（cwi-h6-20260830 放寬：唔再限同店 — 跨店由
    //    assertCanAssign + assertConversationAccess 判；MD §3（h5 §2.1）：!target || !active 先擋）
    let toName: string | null = null;
    let byName: string | null = null;
    let fromName: string | null = null;
    const [target, byUser, fromUser] = await Promise.all([
      toStaffId ? tx.staffUser.findUnique({ where: { id: toStaffId } }) : Promise.resolve(null),
      byStaffId ? tx.staffUser.findUnique({ where: { id: byStaffId }, select: { name: true } }) : Promise.resolve(null),
      conv.assigneeId
        ? tx.staffUser.findUnique({ where: { id: conv.assigneeId }, select: { name: true } })
        : Promise.resolve(null),
    ]);
    if (toStaffId) {
      if (!target || !target.active) {
        throw new AssignError(400, "ASSIGNEE_INVALID", "assignee must be an active staff");
      }
      toName = target.name;
    }
    byName = byUser?.name ?? null;
    fromName = fromUser?.name ?? null;
    // cwi-h6-20260830（h5 §2.3）：takeover = 換人接手（舊 owner 非空 → 新 owner 唔同）
    const isTakeover = !!conv.assigneeId && !!toStaffId && toStaffId !== conv.assigneeId;

    // SYSTEM（H3 自動派單）只准操作 unassigned 對話（避免蓋過人手分配）
    if (by === "SYSTEM" && conv.assigneeId) {
      throw new AssignError(409, "ALREADY_ASSIGNED", "conversation already has an assignee");
    }

    const now = new Date();

    // 2) 原子更新（樂觀鎖）
    // ★ Realtime P0 (R5, cwi-rt-20260823-a1)：client 帶 version → where 用 assignVersion:v —
    //   UI 陳舊（另一 staff 喺你先 assign/接手咗 → version 已 +1）→ count=0 → 409 ASSIGN_CONFLICT
    //   （UI 顯示「啱啱俾 {name} 接咗手」+ refetch，唔覆寫對方）。
    //   無 version（AUTO_CLAIM / SYSTEM / 舊 client）→ 保留舊 assigneeId lock（防並發轉交 race）。
    //   不變式：所有 assigneeId 變動（呢度 + PATCH /api/conversations/[id]）都 assignVersion+1。
    const where: Prisma.ConversationWhereInput =
      opts.expectedAssignVersion != null
        ? { id: conv.id, assignVersion: opts.expectedAssignVersion }
        : { id: conv.id, assigneeId: conv.assigneeId };
    const res = await tx.conversation.updateMany({
      where,
      data: {
        assigneeId: toStaffId,
        assignedAt: now,
        // cwi-h6-20260830（h5 §1 寫入點 1）：assign 成功 → 新負責人嘅動作時點；release → null
        assigneeLastActionAt: toStaffId ? now : null,
        assignVersion: { increment: 1 },
      },
    });
    if (res.count !== 1) {
      if (opts.expectedAssignVersion != null) {
        throw new AssignError(409, "ASSIGN_CONFLICT", "conversation assignee changed concurrently, please retry");
      }
      throw new AssignError(409, "CONFLICT", "conversation assignee changed concurrently, please retry");
    }

    // 3) 自動 INTERNAL note（轉交原因永遠留喺 thread — MD §3.1 步 3）
    const noteText =
      by === "AUTO_CLAIM"
        ? `${byName ?? "Staff"} 接手咗（首次發送自動 claim）`
        : by === "AUTO_RELEASE"
          ? "系統自動放手（超時未回覆 — auto-release）"
          : toStaffId
            ? toStaffId === byStaffId
              ? note ??
                  (isTakeover
                    ? `${byName ?? "Staff"} 接手咗呢條線（原負責人：${fromName ?? "?"}）`
                    : `${byName ?? "Staff"} 接手咗`)
              : note ?? `已轉交畀 ${toName ?? "Staff"}`
            : note ?? `${byName ?? "Staff"} 放咗返隊列`;
    const noteMsg = await tx.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "INTERNAL",
        type: "note",
        body: noteText,
        status: "SENT",
        waMessageId: null, // INTERNAL 永唔出 Graph API — 冇 wamid
        sentByStaffId: byStaffId,
        mentions: toStaffId ? [toStaffId] : [],
        waTimestamp: now,
      } satisfies Prisma.MessageCreateInput,
    });

    // 5) touch lastMessageAt（★ 唔加 unreadCount — MD §4.1）
    await tx.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

    // 4) AuditLog（metadata only — 零訊息原文；meta = from/to staffId 供轉交風暴週報）
    const auditAction: AssignAuditAction = by === "AUTO_CLAIM" ? "AUTO_CLAIM" : toStaffId ? "TRANSFER" : "UNASSIGN";
    await tx.auditLog.create({
      data: {
        staffId: byStaffId,
        action: auditAction,
        entity: "Conversation",
        entityId: conv.id,
        // cwi-h6-20260830（h5 §2.3 副作用 3）：takeover 必帶 takeover:true；by 記來源（人手/自動）
        meta: { fromStaffId: conv.assigneeId, toStaffId, ...(isTakeover ? { takeover: true } : {}), by },
      },
    });

    // 4b) cwi-h6-20260830（h5 §2.3 副作用 2）：takeover → 原負責人 StaffNotice（零 PII：
    //     只 staff 名 + 對話 id，唔帶任何病人資料）；commit-then-emit 鐵律：create 喺 tx 內。
    if (isTakeover) {
      await tx.staffNotice.create({
        data: {
          clinicId: conv.clinicId,
          conversationId: conv.id,
          kind: "SYSTEM",
          title: `呢條線已經俾 ${byName ?? "Staff"} 接手（你原先係負責人）`,
          meta: { actorStaffId: byStaffId, fromStaffId: conv.assigneeId, toStaffId, reason: "takeover" },
        },
      });
    }

    log.info(
      { conversationId: conv.id, clinicId: conv.clinicId, byStaffId, toStaffId, action: auditAction },
      "assign: conversation reassigned"
    );

    return {
      conversationId: conv.id,
      clinicId: conv.clinicId,
      fromStaffId: conv.assigneeId,
      assigneeId: toStaffId,
      assignedAt: now,
      assignVersion: conv.assignVersion + 1, // increment 已 commit（read +1 = 新值）
      noteMessageId: noteMsg.id,
      auditAction,
    };
  });

  // 5b) socket：clinic room 全店 UI 更新負責人 chip（transaction 提交之後先 emit）
  publishNotify(result.clinicId, "conversation:assigned", {
    conversationId: result.conversationId,
    clinicId: result.clinicId,
    assigneeId: result.assigneeId,
    byStaffId,
    // ★ R5：新版本號 — 其他 client 即時同步（之後嘅 assign 用呢個 version 先唔會 409）
    assignVersion: result.assignVersion,
  });

  // ★ H2：mention 通知 — 被派者（唔係自己）收 notify:mention（bell badge / 黃點；MD §5：轉交 = 必有通知）
  if (result.assigneeId && result.assigneeId !== byStaffId) {
    publishStaffNotify(result.assigneeId, result.clinicId, "notify:mention", {
      conversationId: result.conversationId,
      clinicId: result.clinicId,
      messageId: result.noteMessageId,
      fromStaffId: byStaffId,
    });
  }

  // ★ cwi-h6-20260830（h5 §2.3 副作用 2 實時軌）：takeover → 原負責人定向 socket（零 PII）。
  //   原負責人可能完全唔喺 conv.clinicId 嘅 room（外店單線授權）— 定向 send 保證佢收到。
  if (result.fromStaffId && result.fromStaffId !== result.assigneeId && result.assigneeId) {
    // notice:new 畀店 room（ StaffNotice row 已喺 tx 內落 — 店鐘聲）
    publishNotify(result.clinicId, "notice:new", { conversationId: result.conversationId, kind: "SYSTEM" });
    publishStaffNotify(result.fromStaffId, result.clinicId, "notify:takeover", {
      conversationId: result.conversationId,
      clinicId: result.clinicId,
      actorStaffId: byStaffId,
    });
  }

  return result;
}
