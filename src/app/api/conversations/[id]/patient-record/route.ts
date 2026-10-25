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
  fetchAppointmentsByPatient,
  refreshPatient,
  WorkforceApiError,
} from "@/lib/workforce/client";
import { resolveConversationPatient } from "@/lib/patient-record";
import { computeVisitStats } from "@/lib/visit-stats";
import { runDoctorAdviceForPatient } from "@/lib/followup/engine";
import { DEFAULT_ADVICE_KEYWORDS } from "@/lib/followup/advice";

/**
 * GET /api/conversations/[id]/patient-record — 病人記錄面板數據（followup-v2 P2）
 *
 * Query:
 *   summary=1  輕量（header chip 用）— 配對 + visits(limit 1) + balance；唔拉預約
 *   refresh=1  先跑 #8 手動刷新（§2.8）再拉數據；429/503 唔扮成功（refresh 欄回狀態）
 *              ★ cwi-advice-20261024：刷新成功 → 即刻對呢個病人跑「醫生建議跟進」（refresh.adviceCreated）
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

/** 立即更新補幾多個到診日（CWM 上限 12） */
const MANUAL_REFRESH_DEPTH = 10;

const is404 = (e: unknown) => e instanceof WorkforceApiError && e.status === 404;

type RefreshOut =
  | { state: "ok"; syncedAt: string; adviceCreated: number }
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
    identifiedPatientApricotId: contact.identifiedPatientApricotId,
    waId: contact.waId,
    clinicCode: clinic.code,
  });

  // 2. 手動刷新（§2.8 — 只喺有病人 + 明示 refresh=1 先跑；429/503 唔扮成功）
  let refresh: RefreshOut | null = null;
  if (resolved && doRefresh) {
    try {
      // ★ cwi-walkin-20261018：立即更新都補最近 N 個到診日 — 舊版只刷最新一日（例如今日到診冇 note），
      //   更早嘅診症記錄（walk-in）永遠入唔到索引。CWM 帳單用 overview → 補幾多日都係 3 個 Apricot call。
      const r = await refreshPatient(resolved.patientApricotId, auth.staff.id, MANUAL_REFRESH_DEPTH);
      // ★ cwi-advice-20261024：「立即更新」都觸發醫生建議跟進（唔使等 10 分鐘 scan；fail-soft 回 0）
      const adviceCreated = await runDoctorAdviceForPatient(resolved.patientApricotId, auth.staff.id);
      refresh = { state: "ok", syncedAt: r.syncedAt, adviceCreated };
    } catch (e) {
      if (e instanceof WorkforceApiError && e.status === 404) {
        // ★ cwi-flow-quick：workforce 404 = Apricot 冇「已到診」記錄可索引（只有未到診預約／walk-in 冇預約）—
        //   唔係斷線，唔好報「Apricot 未接通」；refresh=null → UI 顯示「尚未同步到病人記錄」，其餘照拉
        refresh = null;
        log.info({ conversationId: conv.id, clinic: clinic.code }, "patient-record: refresh 404（Apricot 未有到診記錄）");
      } else if (e instanceof WorkforceApiError && e.status === 429) {
        refresh = { state: "rate_limited", retryAfterSec: e.retryAfterSec ?? 60 };
      } else if (e instanceof WorkforceApiError && (e.status >= 500 || e.status === 0)) {
        // ★ cwi-flow-quick：workforce 500（刷新途中 Apricot call 出錯）都當刷新失敗 — 唔好成個病人卡 500，
        //   到診／預約／帳單照拉照顯示；log 帶 status 方便分 503（Apricot 斷）同 500（workforce 錯）
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
  // ★ cwi-ux UX-07：visits 一律拉 100（CWM 上限）— 12 個月主診醫生統計要夠行；
  //   summary 回應仍只回前 2 行（customerType 語義不變 + 輕量）。
  const [visitsRes, balanceRes, apptsRes] = await Promise.allSettled([
    resolved ? fetchPatientVisits(resolved.patientApricotId, 100, auth.staff.id) : Promise.resolve(null),
    resolved ? fetchPatientBalance(resolved.patientApricotId) : Promise.resolve(null),
    // ★ cwi-patient-records-20261017：病人全部店嘅預約（唔再限 WhatsApp 號碼嗰間店）；舊版 CWM 冇模式 C → fallback 店模式
    resolved && !summary
      ? fetchAppointmentsByPatient(resolved.patientApricotId, hkDateOffset(-30), hkDateOffset(7)).catch((e) => {
          if (e instanceof WorkforceApiError && e.status === 400) return fetchAppointmentsByClinic(clinic.code, hkDateOffset(-30), hkDateOffset(7));
          throw e;
        })
      : Promise.resolve(null),
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
    // ★ cwi-flow-quick：判定認到嘅編號（索引未有到診／帳單都有編號顯示）
    (resolved && resolved.patientApricotId === contact.identifiedPatientApricotId ? contact.identifiedPatientCode : null) ??
    // ★ cwi-multi-patient：加入咗呢個電話嘅家人（搜尋加入時記低編號）
    (resolved
      ? (await prisma.contactPatientLink.findUnique({
          where: { contactId_patientApricotId: { contactId: contact.id, patientApricotId: resolved.patientApricotId } },
          select: { patientCode: true },
        }))?.patientCode
      : null) ??
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
      // ★ cwi-inbox-r3：ADMIN 專用「刪除病人資料」掣（同 POST /api/admin/contacts/[id]/delete 口徑：ADMIN + scope 內）
      // ★ cwi-patient-identify：新客／舊客判定（null = 未判定）
      patientStatus: contact.patientStatus,
      patientCheckedAt: contact.patientCheckedAt ? contact.patientCheckedAt.toISOString() : null,
      identifiedCount: contact.identifiedCount,
      // ★ cwi-multi-patient-20261018：呢個電話連咗幾多位病人（頂部 chip「＋N」）
      linkedPatientCount: await prisma.contactPatientLink.count({ where: { contactId: contact.id } }),
      canDelete:
        auth.staff.role === "ADMIN" && (auth.scopeType === "ALL" || auth.scopedClinicIds.includes(contact.clinicId)),
    },
    // ★ wa-meta-compliance-20261016（C.1）：病人要求真人 → AI 自動收聲中（staff 可「交返 AI」清旗）
    patientRequestedHuman: {
      active: conv.patientRequestedHuman,
      at: conv.patientRequestedHumanAt ? conv.patientRequestedHumanAt.toISOString() : null,
      canClear: auth.staff.role !== "SUPERVISOR",
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
    visits: summary ? visits.slice(0, 2) : visits,
    // ★ cwi-ux UX-07：近 12 個月到診統計（主診醫生 + 最近到診分店）— 由 visits 算；
    //   無記錄 / workforce 離線 = null（UI 唔顯示 — spec：冇記錄唔顯示）
    visitStats: resolved ? computeVisitStats(visits, hkDateOffset(0)) : null,
    balance,
    appointments,
    // §3.1b 一個 syncedAt：balance（該病人最新索引行）優先；無行 → appointments 頂層
    syncedAt: balance?.syncedAt ?? apptsAll?.syncedAt ?? null,
    degraded,
    refresh,
    // ★ cwi-advice-20261024：診症卡標示 — 觸發字（前端標黃嗰句）+ 呢個病人已入待跟進嘅診症日
    advice: resolved && !summary ? await adviceInfo(resolved.patientApricotId) : null,
  });
});

/** ★ cwi-advice-20261024：啟用中 DOCTOR_ADVICE 規則嘅觸發字／排除字（合併）+ 該病人醫生建議 task（診症日 → 狀態）。 */
async function adviceInfo(patientApricotId: string): Promise<{
  keywords: string[];
  excludeKeywords: string[];
  tasks: { visitDate: string; status: string }[];
} | null> {
  const rules = await prisma.followupRule.findMany({
    where: { enabled: true, trigger: "DOCTOR_ADVICE" },
    select: { id: true, keywords: true, excludeKeywords: true },
  });
  if (!rules.length) return null;
  const keywords = [...new Set(rules.flatMap((r) => (r.keywords.length ? r.keywords : DEFAULT_ADVICE_KEYWORDS)))];
  const excludeKeywords = [...new Set(rules.flatMap((r) => r.excludeKeywords))];
  const rows = await prisma.followupTask.findMany({
    where: { patientApricotId, ruleId: { in: rules.map((r) => r.id) }, subjectKey: { startsWith: "advice:" } },
    orderBy: { createdAt: "desc" },
    select: { subjectKey: true, status: true },
    take: 50,
  });
  const tasks = rows.map((t) => ({ visitDate: (t.subjectKey ?? "").split(":").pop() ?? "", status: t.status }));
  return { keywords, excludeKeywords, tasks };
}
