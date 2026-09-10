import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, type AuthContext } from "@/lib/rbac";
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

/**
 * ★ cwi-statusrole2-20260910 T1（MD §2）：預設列表 base scope — 單一真相源。
 * 列表 query（無 assigned filter）同 ?counts=1 計數 query 必共用呢個 function，
 * 唔准各寫一次 scope（§2 三計數不變式嘅實作要求）。
 * - STAFF：clinic（clinicParam 有 = 收窄該店）∪ 我係 assignee 嘅線（MD A.3 / I-2 —
 *   跨店指派俾我嘅線永遠喺 scope 內 → 跨店 assignee 天然計入 mine 計數）。
 * - ADMIN/SUPERVISOR：clinicParam（冇 = 全店）。
 */
function buildScope(
  ctx: Pick<AuthContext, "staff" | "clinicIds">,
  clinicParam: string | null,
): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  if (ctx.staff.role === "STAFF") {
    w.OR = [{ clinicId: clinicParam ?? { in: ctx.clinicIds } }, { assigneeId: ctx.staff.id }];
  } else if (clinicParam) {
    w.clinicId = clinicParam;
  }
  return w;
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  const statusParam = url.searchParams.get("status");
  const assignedParam = url.searchParams.get("assigned");
  const countsParam = url.searchParams.get("counts") === "1";
  if (assignedParam && !["unassigned", "mine", "routed"].includes(assignedParam)) {
    return NextResponse.json({ error: "invalid assigned (unassigned|mine|routed)" }, { status: 400 });
  }

  // STAFF 砌別店 clinicId → 403（RBAC 鐵律，E2E 要實測呢條；所有 branch 適用）
  if (clinicParam && ctx.staff.role === "STAFF" && !ctx.clinicIds.includes(clinicParam)) {
    return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
  }

  const where: Record<string, unknown> = {};
  if (assignedParam) {
    // ★ cwi-inboxfix-20260905（MD I-2 鐵律）：嚴格 scope — 唔經 buildScope 嘅 assignee OR 支路。
    // unassigned：clinic 限定 + assigneeId:null（外店線絕對漏唔入嚟）。
    // mine：assigneeId=自己（跨店指派俾自己嘅線保留；STAFF 唔限 clinic — 同 A.3 assignee 支路一致）。
    if (assignedParam === "unassigned") {
      where.assigneeId = null;
      if (ctx.staff.role === "STAFF") {
        where.clinicId = clinicParam ?? { in: ctx.clinicIds };
      } else if (clinicParam) {
        where.clinicId = clinicParam;
      }
    } else if (assignedParam === "routed") {
      // ★ cwi-routing-20260906（MD §4.3）：「派俾我」= routedStaffId=我 ∨ routedGroupId∈我嘅組，且未指派。
      // ★ cwi-auditfix-20260908（B-1）：STAFF 唔再限 clinicIds — 路由本身已限組服務店（R-4），
      //   被 route 嘅組成員即使唔綁該店都要見到 + 開得到（同 assigned=mine 一樣嘅單線授權語義）。
      const myGroups = await prisma.skillGroupMember.findMany({
        where: { staffId: ctx.staff.id },
        select: { groupId: true },
      });
      where.assigneeId = null;
      const orBranches: Record<string, unknown>[] = [{ routedStaffId: ctx.staff.id }];
      if (myGroups.length > 0) orBranches.push({ routedGroupId: { in: myGroups.map((g) => g.groupId) } });
      where.OR = orBranches;
      // STAFF：無 clinic 限制（B-1）；ADMIN/SUPERVISOR：clinicParam 收窄（tab 語義照舊）
      if (ctx.staff.role !== "STAFF" && clinicParam) {
        where.clinicId = clinicParam;
      }
    } else {
      where.assigneeId = ctx.staff.id;
      if (ctx.staff.role === "ADMIN" && clinicParam) where.clinicId = clinicParam;
    }
  } else {
    // 預設列表（無 assigned filter）：base scope 同計數 query 共用 buildScope（MD §2 不變式）。
    Object.assign(where, buildScope(ctx, clinicParam));
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
  const [contacts, staff, clinics, skillGroups, pendingBookings] = await Promise.all([
    prisma.contact.findMany({ select: { id: true, waId: true, profileName: true, labels: true } }),
    prisma.staffUser.findMany({ select: { id: true, name: true } }),
    // cwi-multiclinic-20260903（MD A.3）：clinicName — 跨店線 UI 標店名 badge 用
    // （全 row 都有值：本店/ADMIN 線一樣有，前端自己決定顯唔顯示）
    prisma.clinic.findMany({ select: { id: true, name: true, code: true } }),
    // ★ cwi-routing-20260906（MD §4.3）：路由 badge 組名 — 組數極少（出廠 4），全量 fetch
    prisma.skillGroup.findMany({ select: { id: true, name: true, code: true } }),
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
  const groupMap = new Map(skillGroups.map((g) => [g.id, g]));
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

  // ★ cwi-statusrole2-20260910 T1（MD §2）：三計數不變式 —
  // 每個計數 = buildScope（同預設列表共用）∧ 計數 predicate ∧ status≠RESOLVED，
  // 所以計數永遠同預設列表嘅 filter 結果一致（§2 formula）：
  //   unassigned = assigneeId:null；mine = assigneeId:me（STAFF 跨店線經 base OR 支路計入）；
  //   routed = unassigned ∧ (routedStaffId=me ∨ routedGroupId∈myGroups)（同 buildScope 同源 —
  //   取代舊 B-1 專屬 no-clinic query；MD v2 C-4 修訂口徑）。
  let counts: { all: number; unassigned: number; mine: number; routed: number; pending: number; resolved: number } | null = null;
  if (countsParam) {
    const scope = buildScope(ctx, clinicParam);
    const notResolved = { status: { not: "RESOLVED" as const } };
    const myGroupsForCount = await prisma.skillGroupMember.findMany({
      where: { staffId: ctx.staff.id },
      select: { groupId: true },
    });
    const myGroupIds = myGroupsForCount.map((g) => g.groupId);
    const routedOR: Record<string, unknown>[] = [{ routedStaffId: ctx.staff.id }];
    if (myGroupIds.length > 0) routedOR.push({ routedGroupId: { in: myGroupIds } });
    const [all, unassigned, mine, routed, pending, resolved] = await Promise.all([
      // all = 工作隊列總數（排除 RESOLVED — 「已解決」係右側細字連結嘅獨立入口）
      prisma.conversation.count({ where: { ...scope, ...notResolved } }),
      // unassigned（公海）= 未指派 ∧ !RESOLVED
      prisma.conversation.count({ where: { ...scope, ...notResolved, assigneeId: null } }),
      // mine（我負責）= assigneeId=我 ∧ !RESOLVED（跨店 assignee 經 base OR 支路計入）
      prisma.conversation.count({ where: { ...scope, ...notResolved, assigneeId: ctx.staff.id } }),
      // routed（派俾我）= 未指派 ∧ 路由 predicate ∧ !RESOLVED（AND 組合 — 保留 buildScope clinic 支路）
      prisma.conversation.count({ where: { AND: [scope, notResolved, { assigneeId: null, OR: routedOR }] } }),
      // PENDING：§1.2 migration 後恒 0 — 欄位保留（舊 link 兼容；enum 保留）
      prisma.conversation.count({ where: { ...scope, status: "PENDING" } }),
      // resolved：API 兼容保留（UI 已無已解決膠囊；「睇已解決 →」連結無數字）
      prisma.conversation.count({ where: { ...scope, status: "RESOLVED" } }),
    ]);
    counts = { all, unassigned, mine, routed, pending, resolved };
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
        // ★ cwi-routing-20260906（MD §4.3）：路由 badge — 🎯 組名 / 🎯 單人名 / ⚠ 已升級
        routedGroupId: cv.routedGroupId,
        routedStaffId: cv.routedStaffId,
        routedRuleId: cv.routedRuleId,
        routedAt: cv.routedAt,
        escalatedAt: cv.escalatedAt,
        routedGroupName: cv.routedGroupId ? (groupMap.get(cv.routedGroupId)?.name ?? null) : null,
        routedStaffName: cv.routedStaffId ? (staffMap.get(cv.routedStaffId) ?? null) : null,
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
