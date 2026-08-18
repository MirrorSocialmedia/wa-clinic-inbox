/**
 * AI health probe — /healthz + /admin AI 狀態卡共用（單一事實來源）。
 *
 * 規則（D6：AI 斷線 = graceful degradation，唔算 system fail）：
 * - AI_MOCK=1 → "ok"（mock 永遠喺度，唔打真 endpoint）
 * - real mode：GET {base}/models，3s timeout
 *   - 200 → "ok"
 *   - 連得到但 4xx/5xx → "down"（有問題）
 *   - 連唔到 / timeout → "degraded"（GPU 機離線，已知容忍狀態）
 *   - baseUrl 未設定 → "degraded"
 */
export type AiHealth = "ok" | "down" | "degraded";

const PROBE_TIMEOUT_MS = 3000;

export async function checkAiHealth(): Promise<AiHealth> {
  if (process.env.AI_MOCK === "1") return "ok";

  const base = (process.env.VLLM_BASE_URL ?? process.env.AI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return "degraded"; // 未設定 = 降級

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/models`, { signal: controller.signal });
    if (res.ok) return "ok";
    return "down"; // 連得到但服務端 error
  } catch {
    return "degraded"; // 連唔到 / timeout
  } finally {
    clearTimeout(timer);
  }
}
