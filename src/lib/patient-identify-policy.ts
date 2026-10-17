/**
 * ★ cwi-patient-identify-20261017：新客／舊客判定規則（純函數 — unit 測試用；I/O 喺 patient-identify.ts）
 *   EXISTING = 任何 Apricot 帳號有病人檔（已登記未到診都算舊客 — 擁有人拍板）
 *   NEW      = 全部帳號搜過都冇
 *   UNKNOWN  = 有帳號查唔到 — 唔當新客，10 分鐘後再試
 */
export type PatientStatus = "EXISTING" | "NEW" | "UNKNOWN";

export const FRESH_MS = 24 * 60 * 60 * 1000;
export const RETRY_UNKNOWN_MS = 10 * 60 * 1000;

/** 未判定 → 查；已判定 24h 內唔重查；UNKNOWN 10 分鐘後再試 */
export function needsIdentify(c: { patientStatus: string | null; patientCheckedAt: Date | null }, now = Date.now()): boolean {
  if (!c.patientCheckedAt) return true;
  const age = now - c.patientCheckedAt.getTime();
  return c.patientStatus === "UNKNOWN" ? age > RETRY_UNKNOWN_MS : age > FRESH_MS;
}

/** workforce identify status → 判定（PARTIAL = 有帳號失敗又冇搵到 → 唔當新客） */
export function mapIdentifyStatus(s: "FOUND" | "NOT_FOUND" | "PARTIAL"): PatientStatus {
  return s === "FOUND" ? "EXISTING" : s === "NOT_FOUND" ? "NEW" : "UNKNOWN";
}
