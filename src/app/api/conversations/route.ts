import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { CAPSULE_KEYS, matchCapsule } from "@/lib/inbox/capsule";
import {
  decodeCursor,
  loadCounts,
  loadConversationRows,
  loadFollowupCapsuleRows,
  loadFollowupDue,
  resolveListScope,
  toConversationDTOs,
  type ListMode,
} from "@/lib/inbox/conversation-list";

/**
 * GET /api/conversations?clinicId=&mode=&status=&assigned=&cursor=&after=&contactId=&ids=&counts=1
 * 隊列列表（MD §6.4 隊列欄）— ★ cwi-final S1-2：scope / 分頁 / 計數 / DTO 全部走
 * src/lib/inbox/conversation-list.ts 單一來源（同 SSR /inbox/page.tsx 共用）。
 *
 * 回應一律 object：`{ items, nextCursor, scopeClinicIds, myGroupIds, counts? }`
 * （舊 array 回應取消 — 所有 caller 已遷移讀 .items）。
 *
 * - clinicId：ADMIN 可以指定（tab 切換）；STAFF / 受限 ADMIN 砌外範圍 → 403（assertClinicAccess）
 * - mode=resolved：只 RESOLVED 嘅 keyset 分頁（client「睇已解決」獨立 view）
 * - ★ legacy status= 兼容（T248 舊 link）：RESOLVED → mode=resolved；
 *   OPEN / PENDING → rows 用 {status}（PENDING 恆 0 rows → items=[] 200）；未知值 400
 * - ★ cwi-inboxfix-20260905（MD §1.1 I-1/I-2）：assigned=unassigned|mine|routed|followup
 *   - 本頁內 filter（matchCapsule — 同 client / counts 同一 predicate，計數不變式）
 *   - followup 走獨立分支 loadFollowupCapsuleRows（★ S2-3：包含 RESOLVED — 同 count 同 predicate）
 * - ★ Realtime P0 (R3)：after=<ISO> — delta refetch（lastMessageAt >= after；cap 200、nextCursor=null）
 * - 排序：urgent 優先（Phase 2 鐵律：急症排頂），其餘 lastMessageAt desc（keyset 加 id desc tie-break）
 * - counts=1 → 順帶 { all, unassigned, mine, routed, pending, resolved, followup }
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  const statusParam = url.searchParams.get("status");
  const assignedParam = url.searchParams.get("assigned");
  const modeParam = url.searchParams.get("mode");
  if (assignedParam && !CAPSULE_KEYS.includes(assignedParam as (typeof CAPSULE_KEYS)[number])) {
    return NextResponse.json({ error: "invalid assigned (all|unassigned|mine|routed|followup)" }, { status: 400 });
  }

  // ★ 範圍 guard（RBAC 鐵律，E2E T350 實測）：STAFF / 受限 ADMIN 砌外範圍 clinicId → 403（所有 branch 適用）
  if (clinicParam) assertClinicAccess(ctx, clinicParam);

  // ★ legacy status= 兼容：RESOLVED → resolved 模式；OPEN/PENDING → active rows 限 {status}；未知 400
  let mode: ListMode = modeParam === "resolved" ? "resolved" : "active";
  let legacyStatus: "OPEN" | "PENDING" | null = null;
  if (statusParam) {
    if (statusParam === "RESOLVED") mode = "resolved";
    else if (statusParam === "OPEN" || statusParam === "PENDING") legacyStatus = statusParam;
    else return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  const afterRaw = url.searchParams.get("after");
  const after = afterRaw ? new Date(afterRaw) : null;
  if (after && Number.isNaN(after.getTime())) return NextResponse.json({ error: "invalid after" }, { status: 400 });
  const contactId = url.searchParams.get("contactId");
  const ids = url.searchParams.get("ids")?.split(",").filter(Boolean).slice(0, 50) ?? null;

  const s = await resolveListScope(ctx, clinicParam);
  const followupDue = await loadFollowupDue(s);
  // ★ 裁決 3：assigned=followup 獨立分支（含 RESOLVED；定點查詢唔走呢支路）
  const { rows: loaded, nextCursor } =
    assignedParam === "followup" && !after && !contactId && !ids
      ? await loadFollowupCapsuleRows(s, followupDue)
      : await loadConversationRows(s, followupDue, { mode, cursor, after, contactId, ids, legacyStatus });
  let rows = loaded;
  if (assignedParam && assignedParam !== "all") {
    // 本頁內膠囊 filter — 同 client / counts 同一 predicate（capsule.ts 單一來源）
    const cx = {
      meId: s.meId,
      myGroupIds: s.myGroupIds,
      scopeClinicIds: s.scopedSet,
      activeClinicId: s.clinicParam ?? ("all" as const),
    };
    rows = rows.filter((r) => matchCapsule(assignedParam as (typeof CAPSULE_KEYS)[number], r, cx, new Set(followupDue.keys())));
  }
  const items = await toConversationDTOs(rows, followupDue, clinicParam ?? s.scopedSet ?? undefined, s.meId);
  // ★ 一律回 object（舊 array 回應取消 — caller 已全部遷移 .items）
  const body: Record<string, unknown> = {
    items,
    nextCursor,
    scopeClinicIds: s.scopedSet,
    myGroupIds: s.myGroupIds,
  };
  if (url.searchParams.get("counts") === "1") body.counts = await loadCounts(s, followupDue);
  return NextResponse.json(body);
});
