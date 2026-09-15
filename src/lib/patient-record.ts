/**
 * 病人記錄 — 對話 ↔ 病人配對（followup-v2 P2）
 *
 * 🔴 原始電話唔過界：waId 只喺 server 端算 phoneHashes（P0 多號 E.164），
 *    對 workforce 回嘅 phoneHashes[] 做 hasSome 配對 — hash 對 hash，raw 永唔出。
 *
 * 配對順序：
 *  1. 已釘住 → conv.pinnedPatientApricotId（patient-pin 流建立，信任）
 *  2. 未釘住 → #3 appointments clinic 模式（≤38 日窗：-30..+7）phoneHashes[] hasSome
 *     — 取最新 date 行嘅 patientApricotId（同一天多筆 = 同一病人）。
 *
 * 限制（已知）：配對只 cover 預約索引窗內有行嘅病人；walk-in 無預約嘅病人要人手釘住。
 *   鐵律（§6）：wa-inbox 唔直接打 Apricot — 全部經 workforce external API。
 */
import { phoneHashes } from "@/lib/phone-hash";
import { hkDateOffset } from "@/lib/availability";
import { fetchAppointmentsByClinic, WorkforceApiError } from "@/lib/workforce/client";

export interface ResolvedPatient {
  patientApricotId: string;
  source: "pinned" | "paired";
}

export async function resolveConversationPatient(params: {
  pinnedPatientApricotId: string | null;
  waId: string;
  clinicCode: string;
}): Promise<ResolvedPatient | null> {
  if (params.pinnedPatientApricotId) {
    return { patientApricotId: params.pinnedPatientApricotId, source: "pinned" };
  }
  const H = phoneHashes(params.waId);
  if (!H.length) return null; // waId 無合法電話格式 → 配唔到（唔 throw）
  const set = new Set(H);
  try {
    const res = await fetchAppointmentsByClinic(params.clinicCode, hkDateOffset(-30), hkDateOffset(7));
    let best: { date: string; cpId: string } | null = null;
    for (const a of res.appointments) {
      const hit = (a.phoneHashes ?? []).some((h) => set.has(h));
      if (!hit) continue;
      if (!best || a.date > best.date) best = { date: a.date, cpId: a.patientApricotId };
    }
    return best ? { patientApricotId: best.cpId, source: "paired" } : null;
  } catch (e) {
    // clinic 唔存在 / workforce 離線 = 配對唔到（degraded 由上游欄位反映）— 唔當整單失敗
    if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) return null;
    throw e;
  }
}
