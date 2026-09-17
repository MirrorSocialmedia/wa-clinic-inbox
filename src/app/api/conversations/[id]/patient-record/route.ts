import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hkDateOffset } from "@/lib/availability";
import {
  fetchPatientVisits,
  fetchPatientBalance,
  fetchAppointmentsByClinic,
  refreshPatient,
  WorkforceApiError,
} from "@/lib/workforce/client";
import { resolveConversationPatient } from "@/lib/patient-record";

/**
 * GET /api/conversations/[id]/patient-record — 病人記錄面板數據（followup-v2 P2）
 *
 * Query:
 *   summary=1  輕量（header chip 用）— 配對 + visits(limit 1) + balance；唔拉預約
 *   refresh=1  先跑 #8 手動刷新（§2.8）再拉數據；429/503 唔扮成功（refresh 欄回狀態）
 *
 * RBAC：requireAuth + assertConversationAccess（SUPERVISOR 全店唯讀 / STAFF 只可讀
 *   自己範圍 — 現行慣例；本路由 GET-only = 結構性唯讀）。
 *
 * 🔴 鐵律（§6）：
 *   - wa-inbox 唔存臨床全文 — 本路由只回 firstLine（≤60 字）；全文只可經 /note 子路由
 *   - 原始電話唔過界 — 配對全程 hash 對 hash
 *   - 一個 syncedAt 管三個分頁（§3.1b）— balance.syncedAt 優先（該病人索引行最新同步），
 *     無 balance 行（新病人）fallback appointments.syncedAt
 *
 * 降級：workforce 離線/錯誤 → degraded=true + 對應欄空（UI 降級提示，唔 block 其餘）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const is404 = (e: unknown) => e instanceof WorkforceApiError && e.status === 404;

type RefreshOut =
  | { state: "ok"; syncedAt: string }
  | { state: "rate_limited"; retryAfterSec: number }
  | { state: "failed" };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
  if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 500 });

  const q = new URL(req.url).searchParams;
  const summary = q.get("summary") === "1";
  const doRefresh = q.get("refresh") === "1";

  // 1. 配對（pinned → appointments phoneHashes hasSome）
  const resolved = await resolveConversationPatient({
    pinnedPatientApricotId: conv.pinnedPatientApricotId,
    waId: contact.waId,
    clinicCode: clinic.code,
  });

  // 2. 手動刷新（§2.8 — 只喺有病人 + 明示 refresh=1 先跑；429/503 唔扮成功）
  let refresh: RefreshOut | null = null;
  if (resolved && doRefresh) {
    try {
      const r = await refreshPatient(resolved.patientApricotId);
      refresh = { state: "ok", syncedAt: r.syncedAt };
    } catch (e) {
      if (e instanceof WorkforceApiError && e.status === 429) {
        refresh = { state: "rate_limited", retryAfterSec: e.retryAfterSec ?? 60 };
      } else if (e instanceof WorkforceApiError && (e.status === 503 || e.status === 0)) {
        // 保護 4：失敗唔扮無事 — UI 顯示「Apricot 未接通，顯示緊 {syncedAt} 嘅資料」（syncedAt = 本回應舊數據）
        refresh = { state: "failed" };
        log.warn(
          { conversationId: conv.id, clinic: clinic.code, err: e.status === 0 ? "network" : `status=${e.status}` },
          "patient-record: refresh failed（Apricot 斷）"
        );
      } else {
        throw e; // 401/403 等 config 錯 → handle() 兜 500（要人睇）
      }
    }
  }

  // 3. 三條數據一次過拉（§3.1b：一個 syncedAt 管三個分頁）
  const [visitsRes, balanceRes, apptsRes] = await Promise.allSettled([
    resolved ? fetchPatientVisits(resolved.patientApricotId, summary ? 2 : 50) : Promise.resolve(null),
    resolved ? fetchPatientBalance(resolved.patientApricotId) : Promise.resolve(null),
    resolved && !summary ? fetchAppointmentsByClinic(clinic.code, hkDateOffset(-30), hkDateOffset(7)) : Promise.resolve(null),
  ]);
  const degraded = [visitsRes, balanceRes, apptsRes].some((r) => r.status === "rejected" && !is404(r.reason));

  const visitsRaw = visitsRes.status === "fulfilled" ? visitsRes.value?.visits ?? [] : [];
  const balance = balanceRes.status === "fulfilled" ? balanceRes.value : null;
  const apptsAll = apptsRes.status === "fulfilled" ? apptsRes.value : null;
  const appointments =
    resolved && apptsAll
      ? apptsAll.appointments.filter((a) => a.patientApricotId === resolved.patientApricotId)
      : [];

  // 醫生名（#4 只回 providerCode — W 本庫 Provider.apricotId 映返；映唔到回 null → UI 顯示 code）
  const codes = [...new Set(visitsRaw.map((v) => v.providerCode).filter((c): c is string => !!c))];
  const provs = codes.length
    ? await prisma.provider.findMany({ where: { apricotId: { in: codes } }, select: { apricotId: true, name: true } })
    : [];
  const provName = new Map(provs.map((p) => [p.apricotId as string, p.name]));
  const visits = visitsRaw.map((v) => ({
    ...v,
    providerName: v.providerCode ? (provName.get(v.providerCode) ?? null) : null,
  }));

  const patientCode =
    (visitsRes.status === "fulfilled" ? visitsRes.value?.patientCode : null) ??
    balance?.patientCode ??
    appointments[0]?.patientCode ??
    null;

  return NextResponse.json({
    v: 1,
    // §4.6 病人卡 opt-out toggle（MD：手動 toggle）— contact 級，配對有冇都顯示；
    // SUPERVISOR 全店唯讀 → canEdit=false（UI 唔渲染掣）
    contact: {
      id: contact.id,
      profileName: contact.profileName,
      followupOptOut: contact.followupOptOut,
      optOutSource: contact.optOutSource,
      optOutAt: contact.optOutAt,
      // ★ cwi-followup-v3 B-9：稱呼（人手可改 — 系統唔自動估）+ locale（決定 *_en template）
      salutation: contact.salutation,
      locale: contact.locale,
      canEdit: auth.staff.role !== "SUPERVISOR",
    },
    patient: resolved
      ? {
          patientApricotId: resolved.patientApricotId,
          patientCode,
          source: resolved.source,
          // 舊客 = 索引窗內 ≥2 次到診（summary limit 2）；新客 = 1 次（§3.1）
          customerType: visits.length >= 2 ? ("returning" as const) : ("new" as const),
          lastVisitDate: visits[0]?.visitDate ?? null,
        }
      : null,
    visits,
    balance,
    appointments,
    // §3.1b 一個 syncedAt：balance（該病人最新索引行）優先；無行 → appointments 頂層
    syncedAt: balance?.syncedAt ?? apptsAll?.syncedAt ?? null,
    degraded,
    refresh,
  });
});
