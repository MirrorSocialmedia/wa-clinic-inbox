/**
 * ★ cwi-final S1-2（L-1／L-3／L-6／N-1／audit3 P1-08 / P2-33）：inbox 對話列表 單一來源 loader。
 *
 * API（/api/conversations）同 SSR（/inbox/page.tsx）共用呢度 — scope / 分頁 / 計數 / DTO
 * 全部只寫一次（舊狀：兩處各自 scope、各自 take 200、各自 contact 全表 findMany）。
 *
 * - keyset 分頁：排序 (urgent desc, lastMessageAt desc, id desc)；cursor = base64url{u,t,id}。
 *   「排序鍵會變」下安全：lastMessageAt 只會變大（GREATEST）、urgent false→true 只向上跳 —
 *   行跳入已載入區 = realtime 已補；跳出已載入區 = 下一頁再出現 → client 按 id 去重。
 * - 膠囊 predicate：client 同 server 共用純函數 capsule.ts（matchCapsule）；
 *   計數不變式（MD §2／I-2）= counts[k] === items.filter(matchCapsule(k)).length。
 * - ★ S2-3 口徑：followup（待跟進）唔排除 RESOLVED — list / count 同一 predicate。
 * - ★ cwi-final B6 裁決 3：assigned=followup 走獨立分支（loadFollowupCapsuleRows）—
 *   active 模式默认排除 RESOLVED，followup 必須包含 → count 同 list 不變式成立。
 * - ★ cwi-final B6 裁決 9：toConversationDTOs lookups 改 page-scoped（只查本頁 id）—
 *   contact/staff/clinic/group 唔再全表；bookings 先查、staffIds 併入 booking.handledByStaffId。
 */
import type { Prisma, Conversation } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { scopedClinicSet, myGroupIds as loadMyGroupIds, type AuthContext } from "@/lib/rbac";
import { latestHoldsByConversation } from "@/lib/flows/hold-sweep";
import { LIST_PAGE_SIZE, RESOLVED_TAIL } from "./list-constants";
import type { CapsuleKey } from "./capsule";
import type { BookingInfo, ConversationItem, HoldInfo, WindowState } from "@/components/inbox/types";

export type { CapsuleKey } from "./capsule";

const WINDOW_MS = 24 * 3600 * 1000;

export type ScopeCtx = Pick<AuthContext, "staff" | "scopeType" | "scopedClinicIds">;

export interface ListScope {
  /** null = 全店（ALL scope / SUPERVISOR） */
  scopedSet: string[] | null;
  /** ★ 所有角色都查（唔再只限 STAFF — client myGroupIds 同源） */
  myGroupIds: string[];
  meId: string;
  clinicParam: string | null;
}

export async function resolveListScope(ctx: ScopeCtx, clinicParam: string | null): Promise<ListScope> {
  return {
    scopedSet: scopedClinicSet(ctx),
    myGroupIds: [...(await loadMyGroupIds(ctx.staff.id))], // rbac（60s cache）
    meId: ctx.staff.id,
    clinicParam,
  };
}

/** 「派俾我」唯一 predicate（items / counts / client 三處同源 — L-3） */
export function routedPredicate(s: ListScope): Prisma.ConversationWhereInput {
  const or: Prisma.ConversationWhereInput[] = [{ routedStaffId: s.meId }];
  if (s.myGroupIds.length > 0) or.push({ routedGroupId: { in: s.myGroupIds } });
  return { assigneeId: null, OR: or };
}

/** 店範圍（公海用 — 公海永遠唔含外店線，I-2 鐵律） */
export function clinicPredicate(s: ListScope): Prisma.ConversationWhereInput {
  if (s.scopedSet === null) return s.clinicParam ? { clinicId: s.clinicParam } : {};
  return { clinicId: s.clinicParam ?? { in: s.scopedSet } };
}

/**
 * base scope = 店範圍 ∪ 我係 assignee ∪ 派俾我（未指派）。
 * ★ 一律用 AND 組合（唔准 spread — 兩個 OR spread 會互相覆蓋 = 越權）。
 */
export function baseScope(s: ListScope): Prisma.ConversationWhereInput {
  if (s.scopedSet === null) return s.clinicParam ? { clinicId: s.clinicParam } : {};
  return { OR: [clinicPredicate(s), { assigneeId: s.meId }, routedPredicate(s)] };
}

export function capsulePredicate(key: CapsuleKey, s: ListScope, followupConvIds: string[]): Prisma.ConversationWhereInput {
  switch (key) {
    case "all":
      return {};
    case "unassigned":
      return { AND: [{ assigneeId: null }, clinicPredicate(s)] };
    case "mine":
      return { assigneeId: s.meId };
    case "routed":
      return routedPredicate(s);
    case "followup":
      return { id: { in: followupConvIds } };
  }
}

/** 待跟進集合：conversationId → 最舊 SUGGESTED dueAt（ms）。
 * 受限角色限自己店集合（I-2）；ALL scope 唔限。list / count 同一個 Map → 不變式成立。 */
export async function loadFollowupDue(s: ListScope): Promise<Map<string, number>> {
  const rows = await prisma.followupTask.findMany({
    where: {
      status: "SUGGESTED",
      conversationId: { not: null },
      ...(s.scopedSet ? { clinicId: { in: s.scopedSet } } : {}),
    },
    select: { conversationId: true, dueAt: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) {
    const id = r.conversationId as string;
    const t = r.dueAt.getTime();
    const prev = m.get(id);
    if (prev === undefined || t < prev) m.set(id, t);
  }
  return m;
}

// ── cursor ──────────────────────────────────────────────────────────────
export interface ListCursor {
  u: 0 | 1; // urgent
  t: string; // lastMessageAt ISO
  id: string;
}
export function encodeCursor(c: Pick<Conversation, "urgent" | "lastMessageAt" | "id">): string {
  return Buffer.from(JSON.stringify({ u: c.urgent ? 1 : 0, t: c.lastMessageAt.toISOString(), id: c.id })).toString("base64url");
}
export function decodeCursor(raw: string | null): ListCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ListCursor;
    if ((c.u !== 0 && c.u !== 1) || typeof c.id !== "string" || Number.isNaN(new Date(c.t).getTime())) return null;
    return c;
  } catch {
    return null;
  }
}
/** 排序 (urgent desc, lastMessageAt desc, id desc) 嘅「喺 cursor 之後」 */
function afterCursor(c: ListCursor, withUrgent: boolean): Prisma.ConversationWhereInput {
  const t = new Date(c.t);
  if (!withUrgent) return { OR: [{ lastMessageAt: { lt: t } }, { lastMessageAt: t, id: { lt: c.id } }] };
  const u = c.u === 1;
  const or: Prisma.ConversationWhereInput[] = [];
  if (u) or.push({ urgent: false });
  or.push({ urgent: u, lastMessageAt: { lt: t } });
  or.push({ urgent: u, lastMessageAt: t, id: { lt: c.id } });
  return { OR: or };
}

export type ListMode = "active" | "resolved";

export interface LoadListOpts {
  mode?: ListMode; // active（預設）= 非 RESOLVED；resolved = 只 RESOLVED（「睇已解決」獨立 view）
  cursor?: ListCursor | null;
  after?: Date | null; // delta（S1-12 之後改 updatedAt）
  contactId?: string | null; // 搜尋結果開對話（S1-3）
  ids?: string[] | null; // 單條補載（S1-3）
  /** ★ cwi-final B6 裁決 2：legacy status= 兼容 — OPEN/PENDING 用 {status} 取代
   *  {status:{not:"RESOLVED"}}（PENDING 恆 0 rows）；設定時首頁唔夾 RESOLVED tail。 */
  legacyStatus?: "OPEN" | "PENDING" | null;
}

export interface LoadListResult {
  rows: Conversation[];
  nextCursor: string | null;
}

export async function loadConversationRows(
  s: ListScope,
  followupDue: Map<string, number>,
  o: LoadListOpts = {},
): Promise<LoadListResult> {
  const base = baseScope(s);

  // ① 定點查詢（delta / contact / ids）：唔分頁，上限 LIST_PAGE_SIZE
  if (o.after || o.contactId || o.ids) {
    const extra: Prisma.ConversationWhereInput[] = [];
    if (o.after) extra.push({ lastMessageAt: { gte: o.after } });
    if (o.contactId) extra.push({ contactId: o.contactId });
    if (o.ids) extra.push({ id: { in: o.ids } });
    const rows = await prisma.conversation.findMany({
      where: { AND: [base, ...extra] },
      orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }, { id: "desc" }],
      take: LIST_PAGE_SIZE,
    });
    if (rows.length === LIST_PAGE_SIZE) log.warn({ me: s.meId, after: !!o.after }, "inbox list: 定點查詢到上限 — client 要 full refetch");
    return { rows, nextCursor: null };
  }

  // ② resolved 模式：只 RESOLVED，keyset（lastMessageAt desc, id desc）
  if (o.mode === "resolved") {
    const rows = await prisma.conversation.findMany({
      where: { AND: [base, { status: "RESOLVED" }, ...(o.cursor ? [afterCursor(o.cursor, false)] : [])] },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: LIST_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, LIST_PAGE_SIZE);
    return { rows: page, nextCursor: rows.length > LIST_PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null };
  }

  // ③ active 模式（預設）：非 RESOLVED keyset 分頁；
  //    第一頁（冇 cursor）另外夾 RESOLVED 尾 + 有未處理建議嘅 RESOLVED（S2-3：待跟進包含已解決）
  const statusWhere: Prisma.ConversationWhereInput = o.legacyStatus ? { status: o.legacyStatus } : { status: { not: "RESOLVED" } };
  const active = await prisma.conversation.findMany({
    where: { AND: [base, statusWhere, ...(o.cursor ? [afterCursor(o.cursor, true)] : [])] },
    orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }, { id: "desc" }],
    take: LIST_PAGE_SIZE + 1,
  });
  const page = active.slice(0, LIST_PAGE_SIZE);
  const nextCursor = active.length > LIST_PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null;
  if (o.cursor || o.legacyStatus) return { rows: page, nextCursor };

  const followupIds = [...followupDue.keys()];
  const [resolvedTail, resolvedWithSugg] = await Promise.all([
    prisma.conversation.findMany({
      where: { AND: [base, { status: "RESOLVED" }] },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: RESOLVED_TAIL,
    }),
    followupIds.length
      ? prisma.conversation.findMany({ where: { AND: [base, { status: "RESOLVED" }, { id: { in: followupIds } }] } })
      : Promise.resolve([] as Conversation[]),
  ]);
  const byId = new Map<string, Conversation>();
  for (const c of [...page, ...resolvedWithSugg, ...resolvedTail]) byId.set(c.id, c);
  return { rows: [...byId.values()], nextCursor };
}

/** ★ cwi-final B6 裁決 3：assigned=followup 獨立分支 — 包含 RESOLVED（active 模式默认排除）。
 * 取 LIST_PAGE_SIZE 後按 最舊建議先 + urgent 優先 排序（同舊 route 口徑）；nextCursor = null。
 * count（loadCounts.followup）同 list 同一 predicate（base ∧ id ∈ followupDue）→ 不變式成立。 */
export async function loadFollowupCapsuleRows(s: ListScope, followupDue: Map<string, number>): Promise<LoadListResult> {
  const ids = [...followupDue.keys()];
  const rows = ids.length
    ? await prisma.conversation.findMany({
        where: { AND: [baseScope(s), { id: { in: ids } }] },
        orderBy: { lastMessageAt: "desc" },
        take: LIST_PAGE_SIZE,
      })
    : [];
  rows.sort(
    (a, b) =>
      (followupDue.get(a.id) ?? Infinity) - (followupDue.get(b.id) ?? Infinity) || Number(b.urgent) - Number(a.urgent),
  );
  return { rows, nextCursor: null };
}

export interface ListCounts {
  all: number;
  unassigned: number;
  mine: number;
  routed: number;
  /** §1.2 migration 後恒 0 — 欄位保留（舊 link 兼容；enum 保留） */
  pending: number;
  resolved: number;
  /** ★ S2-3：待跟進唔排除 RESOLVED（同 list 同一 predicate） */
  followup: number;
}

export async function loadCounts(s: ListScope, followupDue: Map<string, number>): Promise<ListCounts> {
  const base = baseScope(s);
  const notResolved: Prisma.ConversationWhereInput = { status: { not: "RESOLVED" } };
  const fids = [...followupDue.keys()];
  const c = (extra: Prisma.ConversationWhereInput[]) => prisma.conversation.count({ where: { AND: [base, ...extra] } });
  const [all, unassigned, mine, routed, resolved, followup] = await Promise.all([
    c([notResolved]),
    c([notResolved, capsulePredicate("unassigned", s, fids)]),
    c([notResolved, capsulePredicate("mine", s, fids)]),
    c([notResolved, capsulePredicate("routed", s, fids)]),
    c([{ status: "RESOLVED" }]),
    c([capsulePredicate("followup", s, fids)]), // ★ S2-3：唔加 notResolved
  ]);
  return { all, unassigned, mine, routed, pending: 0, resolved, followup };
}

/**
 * DTO — API 同 SSR 共用（順手修 audit3 P2-32 pinnedPatient 形狀唔一致 — 一律 API 版
 * `pinnedPatientApricotId: string|null`）。lookups 全部 page-scoped（只查本頁 id）。
 */
/**
 * ★ cwi-final S1-12（audit3 P1-09）：本頁對話 per-staff 未讀 — 一次 raw SQL 查全頁
 * （spec 逐字：Message LEFT JOIN ConversationRead，比該 staff lastReadAt 新嘅 IN 訊息；
 *   HISTORY 匯入唔計；無已讀記錄 → 'epoch' = 全部計）。unreadCount（全店語義）完全分開。
 */
export async function loadMyUnreadByConv(staffId: string, convIds: string[]): Promise<Map<string, number>> {
  if (convIds.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<{ conversationId: string; n: number }[]>(
    `SELECT m."conversationId", count(*)::int AS n
     FROM "Message" m
     LEFT JOIN "ConversationRead" r ON r."conversationId" = m."conversationId" AND r."staffId" = $1
     WHERE m."conversationId" = ANY($2) AND m.direction = 'IN' AND m.channel <> 'HISTORY'
       AND m."createdAt" > COALESCE(r."lastReadAt", 'epoch')
     GROUP BY 1`,
    staffId,
    convIds,
  );
  return new Map(rows.map((r) => [r.conversationId, r.n]));
}

export async function toConversationDTOs(
  rows: Conversation[],
  followupDue: Map<string, number>,
  holdClinicFilter: string | string[] | undefined,
  meId?: string | null,
): Promise<ConversationItem[]> {
  if (rows.length === 0) return [];
  const contactIds = [...new Set(rows.map((r) => r.contactId))];
  const clinicIds = [...new Set(rows.map((r) => r.clinicId))];
  const rowStaffIds = rows.flatMap((r) => [r.assigneeId, r.routedStaffId]).filter((x): x is string => !!x);
  const groupIds = [...new Set(rows.map((r) => r.routedGroupId).filter((x): x is string => !!x))];
  // 裁決 9：bookings 先查（staffIds 要併入 booking.handledByStaffId）
  // ★ cwi-final S1-12：myUnread 一次查全頁（meId 有值先查；SSR/API 都傳）
  const [contacts, clinics, groups, bookings, myUnreadMap] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, waId: true, profileName: true, labels: true },
    }),
    prisma.clinic.findMany({ where: { id: { in: clinicIds } }, select: { id: true, name: true, code: true } }),
    prisma.skillGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true, code: true } }),
    prisma.bookingRequest.findMany({
      where: { conversationId: { in: rows.map((r) => r.id) }, status: { in: ["PENDING", "CONFIRMED"] } },
      orderBy: { createdAt: "desc" },
    }),
    meId
      ? loadMyUnreadByConv(meId, rows.map((r) => r.id))
      : Promise.resolve(new Map<string, number>()),
  ]);
  const staffIds = [...new Set([...rowStaffIds, ...bookings.map((b) => b.handledByStaffId).filter((x): x is string => !!x)])];
  const staff = await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true, active: true } });

  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((s) => [s.id, s.name]));
  const clinicMap = new Map(clinics.map((c) => [c.id, c]));
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  // ★ cwi-final S5-11（F4）：hold 卡按 conversationId 配對（同號多病人唔串卡）；
  //   舊行（conversationId null）fallback phone 配對 — fail-soft → 空 Map
  const holdByConv = await latestHoldsByConversation(
    rows.map((r) => ({ id: r.id, waId: contactMap.get(r.contactId)?.waId ?? null })),
    holdClinicFilter
  ).catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "inbox list: hold lookup failed");
    return new Map();
  });
  // booking-ui（D）：PENDING 優先（新請求）；冇 PENDING 先顯示最新 CONFIRMED（撤銷倒數卡）
  const pendingBookingMap = new Map<string, (typeof bookings)[number]>();
  for (const b of bookings) {
    const existing = pendingBookingMap.get(b.conversationId);
    if (!existing || (existing.status !== "PENDING" && b.status === "PENDING")) {
      pendingBookingMap.set(b.conversationId, b);
    }
  }
  const now = Date.now();

  return rows.map((cv): ConversationItem => {
    const lastIn = cv.lastInboundAt?.getTime() ?? null;
    const remainingMs = lastIn === null ? 0 : Math.max(0, lastIn + WINDOW_MS - now);
    const open = remainingMs > 0;
    return {
      id: cv.id,
      clinicId: cv.clinicId,
      // cwi-multiclinic-20260903（MD A.6.4）：跨店線店名 badge（code + 全名；前端決定顯示）
      clinicName: clinicMap.get(cv.clinicId)?.name ?? null,
      clinicCode: clinicMap.get(cv.clinicId)?.code ?? null,
      contactId: cv.contactId,
      status: cv.status,
      assigneeId: cv.assigneeId,
      assigneeName: cv.assigneeId ? (staffMap.get(cv.assigneeId) ?? null) : null,
      // ★ Realtime P0 (R5)：樂觀鎖版本（client assign 時帶返嚟）
      assignVersion: cv.assignVersion,
      unreadCount: cv.unreadCount,
      // ★ cwi-final S1-12：per-staff 未讀（UI 粗體/badge 用；公海 SLA 仍用 unreadCount）
      myUnread: myUnreadMap.get(cv.id) ?? 0,
      lastInboundAt: cv.lastInboundAt ? cv.lastInboundAt.toISOString() : null,
      lastMessageAt: cv.lastMessageAt.toISOString(),
      intent: cv.intent,
      intentConfidence: cv.intentConfidence,
      urgency: cv.urgency,
      urgent: cv.urgent,
      aiSummary: cv.aiSummary,
      // ★ cwi-routing-20260906（MD §4.3）：路由 badge — 🎯 組名 / 🎯 單人名 / ⚠ 已升級
      routedGroupId: cv.routedGroupId,
      routedStaffId: cv.routedStaffId,
      routedRuleId: cv.routedRuleId,
      routedAt: cv.routedAt,
      escalatedAt: cv.escalatedAt,
      // ★ cwi-statusrole2-20260910（MD §3）：badge「↻ 重新開啟」— 24h 內由 client derive
      reopenedAt: cv.reopenedAt,
      // ★ cwi-followup-p3-20260916（鐵律 5）：badge「跟進回覆」— 24h 內由 client derive
      followupRepliedAt: cv.followupRepliedAt ? cv.followupRepliedAt.toISOString() : null,
      // ★ cwi-followup-v3：「待跟進」膠囊 — 最舊 SUGGESTED 建議 dueAt（null = 冇未處理建議）
      followupDueAt: (() => {
        const ts = followupDue.get(cv.id);
        return ts === undefined ? null : new Date(ts).toISOString();
      })(),
      routedGroupName: cv.routedGroupId ? (groupMap.get(cv.routedGroupId)?.name ?? null) : null,
      routedStaffName: cv.routedStaffId ? (staffMap.get(cv.routedStaffId) ?? null) : null,
      contact: contactMap.get(cv.contactId) ?? null,
      // ★ booking-ui（A）：已釘住舊客（藍掣可見性）— 只回 id（姓名喺 patient-context API）
      // ★ audit3 P2-32：形狀統一 = API 版（SSR 舊版 {patientApricotId} 已廢）
      pinnedPatientApricotId: cv.pinnedPatientApricotId,
      // Phase 3：PENDING 預約卡（綠色卡）/ ★ booking-ui（D）：CONFIRMED 卡 — null = 冇待處理預約
      pendingBooking: (() => {
        const b = pendingBookingMap.get(cv.id);
        if (!b) return null;
        return {
          id: b.id,
          providerName: b.providerName,
          requestedDate: b.requestedDate,
          requestedTime: b.requestedTime,
          // 純收需求變體（workforce 切換 MD §3）：timeOfDay + precheckPassed=null —
          // REST refresh（fetchConversations 全量 replace）必須帶埋，否則 chip 空白。
          timeOfDay: b.timeOfDay,
          precheckPassed: b.precheckPassed,
          status: b.status as "PENDING" | "CONFIRMED",
          createdAt: b.createdAt.toISOString(),
          // ★ booking-ui（D）：主訴（Flow 完成時 AI 摘要快照 — 卡上顯示 + remarks 來源）
          chiefComplaint: b.chiefComplaint,
          // ★ booking-ui（D）：CONFIRMED 態（Apricot 單號 + 發起人 + 5 分鐘撤銷倒數起點）
          apricotApptId: b.apricotApptId,
          visitReasonCode: b.visitReasonCode,
          handledByStaffName: b.handledByStaffId ? (staffMap.get(b.handledByStaffId) ?? null) : null,
          handledAt: b.handledAt ? b.handledAt.toISOString() : null,
          // ★ cwi-final S5-1（F1）：async 寫入狀態機（卡上 spinner / 未知黃 / 失敗 code 顯示）
          writeState: b.writeState,
          writeError: b.writeError,
          writeAttemptAt: b.writeAttemptAt ? b.writeAttemptAt.toISOString() : null,
        };
      })() as BookingInfo | null,
      // ★ cwi-final S5-11（F4）：Flow 硬保留 hold 卡（HELD / IN_APRICOT / COMMITTED）— 按對話配對
      holdEvent: (holdByConv.get(cv.id) ?? null) as HoldInfo | null,
      window: {
        open,
        remainingMs,
        remainingHours: remainingMs / 3600000,
        tone: (!open ? "red" : remainingMs < 6 * 3600 * 1000 ? "yellow" : "green") as WindowState["tone"],
      },
    };
  });
}
