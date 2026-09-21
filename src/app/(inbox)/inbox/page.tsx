import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { resolveSessionScope } from "@/lib/rbac";
import { getServerSession } from "@/lib/session-server";
import {
  loadCounts,
  loadConversationRows,
  loadFollowupDue,
  resolveListScope,
  toConversationDTOs,
  type ScopeCtx,
} from "@/lib/inbox/conversation-list";
import { InboxClient } from "@/components/inbox/inbox-client";

/**
 * /inbox — 共用收件箱（MD §6.4 三欄）。
 *
 * ★ cwi-final S1-2（裁決 11）：首屏對話資料改走單一來源 loader
 * （src/lib/inbox/conversation-list.ts — 同 /api/conversations 同一 scope / 分頁 / 計數 / DTO）。
 * 舊版各自 scope / take 200 / contact 全表 findMany / 各自 map 全部刪除（L-1 / audit3 P1-08）。
 *
 * - initialNextCursor 有值 → client mount 後由第二頁自動追（唔重拉第一頁）
 * - myGroupIds = resolveListScope（**所有角色** — 舊版 STAFF-only 已廢）
 * - STAFF 硬性只回自己店（clinicScope fail-closed — 經 baseScope 單一來源）
 */
export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Phase 3：/bookings 卡「開對話」深連結 → ?conv=<id>
  const sp = await searchParams;
  const convParam = typeof sp.conv === "string" ? sp.conv : "";

  // cwi-hub-a-20260914（Part A）：scope 解析（單一來源）— 首屏必須包含，headless 無 client refetch 機會
  const { scopeType, scopedClinicIds } = await resolveSessionScope(session);

  // ★ S1-2（裁決 11）：scope / 分頁 / 計數 / DTO 全部同 /api/conversations 共用
  const scopeCtx: ScopeCtx = {
    staff: { id: session.staffId, email: session.email, name: session.name, role: session.role },
    scopeType,
    scopedClinicIds,
  };
  const s = await resolveListScope(scopeCtx, null);
  const followupDue = await loadFollowupDue(s);
  const [{ rows, nextCursor }, counts, clinics, staff] = await Promise.all([
    loadConversationRows(s, followupDue),
    loadCounts(s, followupDue),
    // 店 tabs（clinic 集合 — STAFF / 受限 = scopedSet；ALL / SUPERVISOR = 全店）
    s.scopedSet
      ? prisma.clinic.findMany({ where: { id: { in: s.scopedSet } }, orderBy: { code: "asc" } })
      : prisma.clinic.findMany({ orderBy: { code: "asc" } }),
    // staffMap 唔限 clinic scope（三態 chip 需要全店 staff 名；同 API 對齊）
    prisma.staffUser.findMany({ where: { active: true }, select: { id: true, name: true, role: true, clinicId: true } }),
  ]);
  // providerslot-20260830 T3：hold 卡 — STAFF 限本頁 rows 嘅店（fail-closed，同現行行為）
  const initialConversations = await toConversationDTOs(
    rows,
    followupDue,
    session.role === "STAFF" ? [...new Set(rows.map((r) => r.clinicId))] : undefined,
    session.staffId, // ★ cwi-final S1-12：myUnread（per-staff 未讀）
  );

  return (
    <InboxClient
      slotClaimEnabled={process.env.ALLOW_SLOT_CLAIM === "1"} // ★ cwi-final S0-12：G2 閘（SSR 注入）
      user={{
        staffId: session.staffId,
        name: session.name,
        email: session.email,
        role: session.role,
        clinicId: session.clinicId,
        // cwi-hub-a-20260914：店集合（STAFF 用已解析 scope 集合 — 舊 session fallback 已喺 resolveSessionScope 內處理）
        clinicIds: session.role === "STAFF" ? scopedClinicIds : [],
        // ★ cwi-final S1-2（裁決 11）：「派俾我 N」膠囊 — resolveListScope 單一來源（所有角色）
        myGroupIds: s.myGroupIds,
      }}
      initialClinics={clinics}
      initialConversations={initialConversations}
      initialStaff={staff}
      initialSelectedConvId={convParam || null}
      initialCounts={counts}
      initialNextCursor={nextCursor}
    />
  );
}
