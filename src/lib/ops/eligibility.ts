/**
 * 自動化級別資格計算（Phase E — pure，unit 測到盡；cwi-ai-20260825-t5）。
 *
 * D-7 + 樣本地板：連續 4 週 adoptRate≥0.9 且 complaints+rollbacks=0 且每週 draftCount≥20。
 * last4 = 最近四個完整週嘅 AutomationStat row（升序：最舊 → 最近；
 *   該週冇 row 嘅 caller 傳零值 row — 樣本地板自然擋）。
 * 呢度唔做 DB 讀 — caller（admin automation API）負責撈 + 對齊週界。
 */
import type { AutomationStat } from "@prisma/client";

export const ELIGIBLE_WEEKS = 4;
export const ELIGIBLE_ADOPT_RATE = 0.9;
export const ELIGIBLE_MIN_DRAFTS = 20;

/** isEligible 只需要呢幾個欄（unit 測可以用簡化 row）。 */
export type StatLike = Pick<AutomationStat, "weekStart" | "draftCount" | "adoptedAsIs" | "adoptedEdited" | "autoSent" | "complaints" | "rollbacks">;

/** adoptRate = (asIs + edited + autoSent) / draft；draftCount=0 → null（無樣本）。
 *  ★ Fix D（cwi-fix-20260825-f1）：autoSent 計入分子 — 自動發出且零投訴 = 採用（L1 店 autoSent=0 → 數字不變）。 */
export function adoptRate(s: StatLike): number | null {
  return s.draftCount > 0 ? (s.adoptedAsIs + s.adoptedEdited + s.autoSent) / s.draftCount : null;
}

export interface EligibilityResult {
  eligible: boolean;
  /** 邊週邊條唔過（儀表板 hover 顯示）；空 = 過。 */
  reasons: string[];
}

export function isEligible(last4: StatLike[]): EligibilityResult {
  if (last4.length < ELIGIBLE_WEEKS) {
    return { eligible: false, reasons: ["未夠四週數據"] };
  }
  const reasons: string[] = [];
  for (const s of last4) {
    const r = adoptRate(s);
    const volOk = s.draftCount >= ELIGIBLE_MIN_DRAFTS;
    const rateOk = r !== null && r >= ELIGIBLE_ADOPT_RATE;
    const clean = s.complaints + s.rollbacks === 0;
    if (!volOk) reasons.push(`${s.weekStart}: 樣本 ${s.draftCount} < ${ELIGIBLE_MIN_DRAFTS}`);
    if (!rateOk) reasons.push(`${s.weekStart}: adoptRate ${r === null ? "n/a" : r.toFixed(2)} < ${ELIGIBLE_ADOPT_RATE}`);
    if (!clean) reasons.push(`${s.weekStart}: complaints+rollbacks = ${s.complaints + s.rollbacks}`);
  }
  return { eligible: reasons.length === 0, reasons };
}
