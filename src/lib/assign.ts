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
 * 權限模型（assertCanAssign，route 層調）：
 *   - ADMIN → 任何店（assertClinicAccess 對 ADMIN 恒真）
 *   - 現任 assignee → 可轉交 / 放返隊列
 *   - unassigned → 任何店內 STAFF（claim；assertClinicAccess 保證同店）
 *   - 任何店內 STAFF → 接手（toStaffId = 自己；MD §3.2〔接手〕）
 *   - 其他 STAFF → 403
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

export type AssignBy = "STAFF" | "AUTO_CLAIM" | "SYSTEM";

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
}

export type AssignAuditAction = "TRANSFER" | "UNASSIGN" | "AUTO_CLAIM";

export interface AssignResult {
  conversationId: string;
  clinicId: string;
  fromStaffId: string | null;
  assigneeId: string | null;
  assignedAt: Date;
  /** 自動 INTERNAL note 嘅 Message id（thread 內「轉交原因」） */
  noteMessageId: string;
  auditAction: AssignAuditAction;
}

/**
 * 權限檢查（MD §3.1 + §3.2〔接手〕；§7 驗收項 3）：
 *   - ADMIN → 任何動作（force reassign）
 *   - unassigned → 任何同店 STAFF（claim；assertClinicAccess 已保證同店）
 *   - 現任 assignee → 轉交他人 / 放返隊列
 *   - 任何同店 STAFF → 接手（toStaffId = 自己；MD §3.2 〔接手〕掣，生成「A 接手咗」note + TRANSFER audit）
 *   - 其他 → 403
 */
export function assertCanAssign(
  ctx: Pick<AuthContext, "staff" | "clinicId">,
  conv: { clinicId: string; assigneeId: string | null },
  toStaffId: string | null
): void {
  if (ctx.staff.role === "ADMIN") return;
  if (!conv.assigneeId) return; // unassigned：任何同店 STAFF（claim）
  if (ctx.staff.id === conv.assigneeId) return; // 現任 assignee
  if (toStaffId === ctx.staff.id) return; // 接手（self-claim）：MD §3.2〔接手〕掣 → §7 驗收項 3
  throw new RbacError(403, "only the current assignee, an admin, or self-claim (takeover) is allowed");
}

export async function assignConversation(opts: AssignConversationOptions): Promise<AssignResult> {
  const { conversationId, toStaffId, by, note } = opts;
  const byStaffId = opts.byStaffId ?? null;
  if (by !== "SYSTEM" && !byStaffId) {
    throw new AssignError(400, "ASSIGN_BAD_INPUT", "byStaffId is required for STAFF/AUTO_CLAIM");
  }

  const result = await prisma.$transaction(async (tx) => {
    const conv = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new AssignError(404, "NOT_FOUND", "conversation not found");

    // 1) toStaffId 必須係同店 active staff
    let toName: string | null = null;
    let byName: string | null = null;
    const [target, byUser] = await Promise.all([
      toStaffId ? tx.staffUser.findUnique({ where: { id: toStaffId } }) : Promise.resolve(null),
      byStaffId ? tx.staffUser.findUnique({ where: { id: byStaffId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    if (toStaffId) {
      if (!target || !target.active || target.clinicId !== conv.clinicId) {
        throw new AssignError(400, "ASSIGNEE_INVALID", "assignee must be an active staff of the same clinic");
      }
      toName = target.name;
    }
    byName = byUser?.name ?? null;

    // SYSTEM（H3 自動派單）只准操作 unassigned 對話（避免蓋過人手分配）
    if (by === "SYSTEM" && conv.assigneeId) {
      throw new AssignError(409, "ALREADY_ASSIGNED", "conversation already has an assignee");
    }

    const now = new Date();

    // 2) 原子更新（樂觀鎖：where 帶 read 時嘅 assigneeId — 並發轉交只有一個成功）
    const res = await tx.conversation.updateMany({
      where: { id: conv.id, assigneeId: conv.assigneeId },
      data: { assigneeId: toStaffId, assignedAt: now },
    });
    if (res.count !== 1) {
      throw new AssignError(409, "CONFLICT", "conversation assignee changed concurrently, please retry");
    }

    // 3) 自動 INTERNAL note（轉交原因永遠留喺 thread — MD §3.1 步 3）
    const noteText =
      by === "AUTO_CLAIM"
        ? `${byName ?? "Staff"} 接手咗（首次發送自動 claim）`
        : toStaffId
          ? toStaffId === byStaffId
            ? note ?? `${byName ?? "Staff"} 接手咗`
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
        meta: { fromStaffId: conv.assigneeId, toStaffId },
      },
    });

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

  return result;
}
