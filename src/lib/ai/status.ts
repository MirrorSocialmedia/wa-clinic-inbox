/**
 * AI 狀態快照（/admin AI 狀態卡 + GET /api/admin/ai-status 共用 — 單一事實來源）。
 *
 * 內容全部係 metadata（mode/model/probe/breaker/call 計數/逐舖 AUTO 統計）— 零 PII。
 * `probe` 經 checkAiHealth：AI_MOCK=1 → "ok"；real mode → GET {base}/models。
 * Phase 2b：stats 加 lastLatencyMs/lastTokens（AiCallStats 實測數據）；
 * clinics = 各舖 aiMode + 近 24h AUTO 自動發數量/成功率（metadata only）。
 */
import prisma from "@/lib/prisma";
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
    /** 最近一次成功 call 實測 latency/tokens（Phase 2b） */
    lastLatencyMs: number | null;
    lastTokens: number | null;
    updatedAt: Date | null;
  } | null;
  /** 逐舖 AI 模式 + 近 24h AUTO 自動發統計（Phase 2b） */
  clinics: {
    id: string;
    code: string;
    name: string;
    aiMode: "DRAFT" | "AUTO";
    /** 近 24h aiAutoSent=true 嘅 OUT 訊息數 */
    autoSent24h: number;
    /** 其中成功（SENT/DELIVERED/READ）數 */
    autoSentOk24h: number;
    /** 0-1；無數據 = null */
    successRate24h: number | null;
  }[];
}

/**
 * 近 24h 逐舖 AUTO 自動發統計（單一事實來源：/api/admin/ai-status + /api/admin/clinics 共用）。
 * total = aiAutoSent=true + direction=OUT + createdAt>=now-24h（raw SQL join — Message 無 clinicId，經 Conversation）；
 * ok = 其中成功（status IN SENT/DELIVERED/READ — 已交 Meta Graph，tick 未回前已算成功）。
 */
export async function autoSent24hByClinic(): Promise<Map<string, { total: number; ok: number }>> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.$queryRaw<Array<{ clinicId: string; total: number; ok: number }>>`
    SELECT c."clinicId" AS "clinicId", COUNT(*)::int AS "total",
           COUNT(*) FILTER (WHERE m."status" IN ('SENT','DELIVERED','READ'))::int AS "ok"
    FROM "Message" m
    JOIN "Conversation" c ON c."id" = m."conversationId"
    WHERE m."aiAutoSent" = true AND m."direction" = 'OUT' AND m."createdAt" >= ${since}
    GROUP BY c."clinicId"
  `;
  return new Map(rows.map((r) => [r.clinicId, r]));
}

export async function getAiStatusSnapshot(): Promise<AiStatusSnapshot> {
  const [probe, stats, clinics, autoByClinic] = await Promise.all([
    checkAiHealth(),
    getAiCallStats(),
    prisma.clinic.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, aiMode: true },
    }),
    autoSent24hByClinic(),
  ]);
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
          lastLatencyMs: stats.lastLatencyMs,
          lastTokens: stats.lastTokens,
          updatedAt: stats.updatedAt,
        }
      : null,
    clinics: clinics.map((c) => {
      const row = autoByClinic.get(c.id);
      const total = row?.total ?? 0;
      const ok = row?.ok ?? 0;
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        aiMode: c.aiMode,
        autoSent24h: total,
        autoSentOk24h: ok,
        successRate24h: total > 0 ? ok / total : null,
      };
    }),
  };
}
