import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { latestHoldsByPhone } from "@/lib/flows/hold-sweep";

/**
 * GET /api/conversations?clinicId=&status=&after=&assigned=&counts=1 — 隊列列表（MD §6.4 隊列欄）。
 * - clinicId：ADMIN 可以指定（tab 切換）；STAFF 忽略（硬性綁自己店，砌別店 → 403 實測）
 * - status：OPEN / PENDING / RESOLVED（filter）
 * - ★ cwi-inboxfix-20260905（MD §1.1 I-1/I-2）：assigned=unassigned|mine
 *   - unassigned（公海）→ assigneeId:null AND 嚴格 store scope：
 *     STAFF = clinicIds（或 clinicParam）；ADMIN = clinicParam（冇 = 全店）。
 *     ⚠️ 鐵律（MD I-2 警告）：公海絕對唔可以經下方 line-35 嘅 OR 支路
 *     （`{clinicId},{assigneeId:self}`）— 否則外店指派俾自己嘅線會混入公海視圖。
 *   - mine → assigneeId = 自己（跨店指派俾自己嘅線保留 — 同 A.3 assignee 支路語義一致）。
 * - ★ cwi-inboxfix-20260905：counts=1 → 同一 route 返 { items, counts:{all,unassigned,mine,pending,resolved} }
 *   （一次 groupBy(assigneeId,status)，唔開五個 request；計數 base scope = 無 assigned filter 嘅列表 scope）
 * - ★ Realtime P0 (R3, cwi-rt-20260823-a1)：after=<ISO/epochMs> — delta refetch，
 *   只回 lastMessageAt >= after 嘅對話（MD 寫 /delta 獨立 route；按 MD 授權「現有 list
 *   route 加 param 就得」— client focus/visibility/3 分鐘 idle 補漏用；重疊容許，client 用 id 去重）
 * - 排序：urgent 優先（Phase 2 鐵律：急症排頂），其餘 lastMessageAt desc
 * - 回傳 contact 資料 + 24h 窗口狀態（UI chip 用）+ AI triage 欄位（intent/urgency/urgent/aiSummary）
 */
export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 3600 * 1000;

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  const statusParam = url.searchParams.get("status");
  const assignedParam = url.searchParams.get("assigned");
  const countsParam = url.searchParams.get("counts") === "1";
  if (assignedParam && !["unassigned", "mine"].includes(assignedParam)) {
    return NextResponse.json({ error: "invalid assigned (unassigned|mine)" }, { status: 400 });
  }

  const where: Record<string, unknown> = {};
  if (assignedParam) {
    // ★ cwi-inboxfix-20260905（MD I-2 鐵律）：嚴格 scope — 唔經 conversationScope 嘅 OR 支路。
    // unassigned：clinic 限定 + assigneeId:null（外店線絕對漏唔入嚟）。
    // mine：assigneeId=自己（跨店指派俾自己嘅線保留；STAFF 唔限 clinic — 同 A.3 assignee 支路一致）。
    if (clinicParam) {
      if (ctx.staff.role === "STAFF" && !ctx.clinicIds.includes(clinicParam)) {
        return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
      }
    }
    if (assignedParam === "unassigned") {
      where.assigneeId = null;
      if (ctx.staff.role === "STAFF") {
        where.clinicId = clinicParam ?? { in: ctx.clinicIds };
      } else if (clinicParam) {
        where.clinicId = clinicParam;
      }
    } else {
      where.assigneeId = ctx.staff.id;
      if (ctx.staff.role === "ADMIN" && clinicParam) where.clinicId = clinicParam;
    }
  } else {
    // 預設列表（無 assigned filter）：現有 scope 語義完全不變（STAFF = clinic ∪ assignee-me OR）。
    if (ctx.staff.role === "STAFF") {
      where.OR = [{ clinicId: { in: ctx.clinicIds } }, { assigneeId: ctx.staff.id }];
    }
    if (clinicParam) {
      // STAFF 砌別店 clinicId → 403（RBAC 鐵律，E2E 要實測呢條）
      if (ctx.staff.role === "STAFF" && !ctx.clinicIds.includes(clinicParam)) {
        return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
      }
      if (ctx.staff.role === "STAFF") {
        // ★ MD A.3：店 tab filter 只限縮 clinic-scope 支路；assignee 支路保留 —
        // 多店 staff 睇自己店 tab 時，指派俾自己嘅外店線仍要見到（A.6.4 badge + §9「見晒覆到」）。
        // 外店未指派線依然唔見（assignee ≠ 自己）。
        where.OR = [{ clinicId: clinicParam }, { assigneeId: ctx.staff.id }];
      } else {
        where.clinicId = clinicParam;
      }
    }
  }
  if (statusParam) {
    if (!["OPEN", "PENDING", "RESOLVED"].includes(statusParam)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    where.status = statusParam;
  }
  // ★ Realtime P0 (R3)：delta refetch — 只回 lastMessageAt >= after 嘅對話。
  // gte（容許重疊）：同毫秒邊界唔會永久漏；client 以 id merge，重複行無害。
  // assign 會 touch lastMessageAt（assign.ts step 5）→ 派生變動亦會入 delta。
  const afterParam = url.searchParams.get("after");
  if (afterParam) {
    const d = new Date(afterParam);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid after" }, { status: 400 });
    }
    where.lastMessageAt = { gte: d };
  }

  const convs = await prisma.conversation.findMany({
    where,
    orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }],
    take: 200,
  });
  const [contacts, staff, clinics, pendingBookings] = await Promise.all([
    prisma.contact.findMany({ select: { id: true, waId: true, profileName: true, labels: true } }),
    prisma.staffUser.findMany({ select: { id: true, name: true } }),
    // cwi-multiclinic-20260903（MD A.3）：clinicName — 跨店線 UI 標店名 badge 用
    // （全 row 都有值：本店/ADMIN 線一樣有，前端自己決定顯唔顯示）
    prisma.clinic.findMany({ select: { id: true, name: true, code: true } }),
    // Phase 3：綠色卡 — 每對話最新 PENDING 預約（staff 一眼見到「有預約等處理」）
    // ★ booking-ui（D）：CONFIRMED 亦要顯示（Apricot 單號 + 撤銷倒數）— PENDING 優先
    prisma.bookingRequest.findMany({
      where: { conversationId: { in: convs.map((c) => c.id) }, status: { in: ["PENDING", "CONFIRMED"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((s) => [s.id, s.name]));
  const clinicMap = new Map(clinics.map((c) => [c.id, c]));
  // providerslot-20260830 T3：hold 卡 — 每個 WA 號最新非終態 hold（join key = Contact.waId）。
  // scope 跟對話一樣（STAFF 自己店 / ADMIN ?clinicId=）；fail-soft → 空 Map。
  const holdClinicFilter: string | string[] | undefined = clinicParam
    ? clinicParam
    : ctx.staff.role === "STAFF"
      ? ctx.clinicIds
      : undefined;
  const holdByPhone = await latestHoldsByPhone(contacts.map((c) => c.waId), holdClinicFilter).catch(() => new Map());
  // ★ booking-ui（D）：PENDING 優先（新請求）；冇 PENDING 先顯示最新 CONFIRMED（撤銷倒數卡）
  const pendingBookingMap = new Map<string, (typeof pendingBookings)[number]>();
  for (const b of pendingBookings) {
    const existing = pendingBookingMap.get(b.conversationId);
    if (!existing || (existing.status !== "PENDING" && b.status === "PENDING")) {
      pendingBookingMap.set(b.conversationId, b);
    }
  }
  const now = Date.now();

  // ★ cwi-inboxfix-20260905（MD §1.1）：counts=1 — 一次 groupBy(assigneeId, status) 推五個計數
  // （唔開五個 request）。base scope = 預設列表 scope（無 assigned filter）：
  // STAFF = clinic ∪ assignee-me OR（clinicParam 時 clinic 支路收窄）；ADMIN = clinicParam（冇 = 全店）。
  // OR scope 內 assignee=null 嘅行只會經 clinic 支路命中 → unassigned 計數天然 = I-2 公海語義
  // （絕唔會經 assignee 支路漏入外店線）。
  let counts: { all: number; unassigned: number; mine: number; pending: number; resolved: number } | null = null;
  if (countsParam) {
    const cWhere: Record<string, unknown> = {};
    if (ctx.staff.role === "STAFF") {
      cWhere.OR = [{ clinicId: clinicParam ?? { in: ctx.clinicIds } }, { assigneeId: ctx.staff.id }];
    } else if (clinicParam) {
      cWhere.clinicId = clinicParam;
    }
    const groups = await prisma.conversation.groupBy({
      by: ["assigneeId", "status"],
      where: cWhere,
      _count: { _all: true },
    });
    let all = 0;
    let unassigned = 0;
    let mine = 0;
    let pending = 0;
    let resolved = 0;
    for (const g of groups) {
      all += g._count._all;
      if (g.assigneeId === null) unassigned += g._count._all;
      if (g.assigneeId === ctx.staff.id) mine += g._count._all;
      if (g.status === "PENDING") pending += g._count._all;
      if (g.status === "RESOLVED") resolved += g._count._all;
    }
    counts = { all, unassigned, mine, pending, resolved };
  }

  const items = convs.map((cv) => {
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
        assigneeName: cv.assigneeId ? staffMap.get(cv.assigneeId) ?? null : null,
        // ★ Realtime P0 (R5)：樂觀鎖版本（client assign 時帶返嚟）
        assignVersion: cv.assignVersion,
        unreadCount: cv.unreadCount,
        lastInboundAt: cv.lastInboundAt,
        lastMessageAt: cv.lastMessageAt,
        intent: cv.intent,
        intentConfidence: cv.intentConfidence,
        urgency: cv.urgency,
        urgent: cv.urgent,
        aiSummary: cv.aiSummary,
        contact: contactMap.get(cv.contactId) ?? null,
        // ★ booking-ui（A）：已釘住舊客（藍掣「幫我喺 Apricot 落單」可見性）— 只回 id（姓名喺 patient-context API）
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
            status: b.status,
            createdAt: b.createdAt,
            // ★ booking-ui（D）：主訴（Flow 完成時 AI 摘要快照 — 卡上顯示 + remarks 來源）
            chiefComplaint: b.chiefComplaint,
            // ★ booking-ui（D）：CONFIRMED 態（Apricot 單號 + 發起人 + 5 分鐘撤銷倒數起點）
            apricotApptId: b.apricotApptId,
            visitReasonCode: b.visitReasonCode,
            handledByStaffName: b.handledByStaffId ? (staffMap.get(b.handledByStaffId) ?? null) : null,
            handledAt: b.handledAt,
          };
        })(),
        // providerslot-20260830 T3：Flow 硬保留 hold 卡（HELD / IN_APRICOT / COMMITTED）
        holdEvent: (() => {
          const ph = contactMap.get(cv.contactId)?.waId;
          if (!ph) return null;
          return holdByPhone.get(ph) ?? null;
        })(),
        window: {
          open,
          remainingMs,
          remainingHours: remainingMs / 3600000,
          tone: !open ? "red" : remainingMs < 6 * 3600 * 1000 ? "yellow" : "green",
        },
      };
    });

  // ★ cwi-inboxfix-20260905：counts=1 → { items, counts }；否則陣列照舊（舊 client 兼容）
  return NextResponse.json(countsParam ? { items, counts } : items);
});
