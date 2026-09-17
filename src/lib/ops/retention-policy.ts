/**
 * ★ cwi-followup-v3-20260916（MD §6 A-2）：保留期政策一致性檢查。
 *
 * 老細拍板 2026-09-16（docs/decisions/retention.md）：**對話 24 個月、媒體 12 個月**。
 * 政策數字（本檔常數）= privacy 頁文案同源；實際刪除數字 = env（RETENTION_CONV_MONTHS 等）。
 *
 * 鐵律：**env 必須明確寫入**（唔靠 code default — default 唔計數）且與政策一致。
 * 違反 → `retentionPolicyMismatches()` 回非空 → server/worker startup 拒絕啟動（T432）。
 *
 * 改政策流程：老細改拍板 → 改本檔常數 + privacy 頁文案 + docs/decisions/retention.md + env（一齊改，startup 檢查兜底）。
 */

/** 對話（Message + 聯動行）保留期（月）— 同 privacy 頁文案同源 */
export const POLICY_RETENTION_MONTHS = 24;
/** 媒體檔保留期（月） */
export const POLICY_RETENTION_MEDIA_MONTHS = 12;

function envIntStrict(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 回傳所有唔一致（空 = 通過）。
 * - 未明確寫 env → 唔一致（MD §6 A-2：唔靠 code default）
 * - 寫咗但 ≠ 政策 → 唔一致
 */
export function retentionPolicyMismatches(): string[] {
  const out: string[] = [];
  const conv = envIntStrict("RETENTION_CONV_MONTHS");
  if (conv === null) {
    out.push("RETENTION_CONV_MONTHS 未明確寫入 env（MD §6 A-2：唔靠 code default）");
  } else if (conv !== POLICY_RETENTION_MONTHS) {
    out.push(`RETENTION_CONV_MONTHS=${conv} ≠ 政策 ${POLICY_RETENTION_MONTHS} 個月`);
  }
  const media = envIntStrict("RETENTION_MEDIA_MONTHS");
  if (media === null) {
    out.push("RETENTION_MEDIA_MONTHS 未明確寫入 env（MD §6 A-2：唔靠 code default）");
  } else if (media !== POLICY_RETENTION_MEDIA_MONTHS) {
    out.push(`RETENTION_MEDIA_MONTHS=${media} ≠ 政策 ${POLICY_RETENTION_MEDIA_MONTHS} 個月`);
  }
  return out;
}
