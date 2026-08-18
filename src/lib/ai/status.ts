/**
 * AI 狀態快照（/admin AI 狀態卡 + GET /api/admin/ai-status 共用 — 單一事實來源）。
 *
 * 內容全部係 metadata（mode/model/probe/breaker/call 計數）— 零 PII。
 * `probe` 經 checkAiHealth：AI_MOCK=1 → "ok"；real mode → GET {base}/models。
 */
import { getAiRuntimeInfo, checkAiHealth, getAiCallStats } from "./index";
import type { AiHealth } from "./index";

export interface AiStatusSnapshot {
  mode: "mock" | "real";
  mockFail: boolean;
  primaryModel: string;
  fallbackModel: string;
  baseUrlConfigured: boolean;
  breaker: { state: "closed" | "open"; openUntilMs: number | null };
  probe: AiHealth;
  stats: {
    totalCalls: number;
    okCalls: number;
    /** 0-1；無數據 = null */
    successRate: number | null;
    lastOkAt: Date | null;
    lastError: string | null;
    updatedAt: Date | null;
  } | null;
}

export async function getAiStatusSnapshot(): Promise<AiStatusSnapshot> {
  const [probe, stats] = await Promise.all([checkAiHealth(), getAiCallStats()]);
  const runtime = getAiRuntimeInfo();
  return {
    mode: runtime.mode,
    mockFail: runtime.mockFail,
    primaryModel: runtime.primaryModel,
    fallbackModel: runtime.fallbackModel,
    baseUrlConfigured: runtime.baseUrlConfigured,
    breaker: runtime.breaker,
    probe,
    stats: stats
      ? {
          totalCalls: stats.totalCalls,
          okCalls: stats.okCalls,
          successRate: stats.totalCalls > 0 ? stats.okCalls / stats.totalCalls : null,
          lastOkAt: stats.lastOkAt,
          lastError: stats.lastError,
          updatedAt: stats.updatedAt,
        }
      : null,
  };
}
