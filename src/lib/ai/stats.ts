/**
 * AI call 統計（AiCallStats singleton row id=1）— admin AI 狀態卡數據源。
 *
 * 只存計數 + 時間 + 錯訊短句（metadata only）— 零 prompt/response 內容。
 * 由 AI worker 每次 call 後 atomic upsert（INSERT ON CONFLICT）；
 * stats 寫失敗唔準影響主 pipeline（try/catch 吞掉 + log warn）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";

export interface AiCallStatsRow {
  totalCalls: number;
  okCalls: number;
  lastOkAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}

/**
 * 記一次 AI call（ok 或 fail）。atomic single-statement upsert。
 * `errMsg` 只准係 server 端錯訊短句（e.g. "vllm 404 : model not found"）—
 * 唔可以包含 prompt / 訊息原文。
 */
export async function recordAiCall(ok: boolean, errMsg?: string): Promise<void> {
  const okInc = ok ? 1 : 0;
  const lastOk = ok ? new Date() : null;
  const errText = ok ? null : (errMsg ?? "unknown error").slice(0, 200);
  try {
    await prisma.$executeRaw`
      INSERT INTO "AiCallStats" (id, "totalCalls", "okCalls", "lastOkAt", "lastError", "updatedAt")
      VALUES (1, 1, ${okInc}, ${lastOk}, ${errText}, now())
      ON CONFLICT (id) DO UPDATE SET
        "totalCalls" = "AiCallStats"."totalCalls" + 1,
        "okCalls" = "AiCallStats"."okCalls" + ${okInc},
        "lastOkAt" = COALESCE(${lastOk}, "AiCallStats"."lastOkAt"),
        "lastError" = COALESCE(${errText}, "AiCallStats"."lastError"),
        "updatedAt" = now()
    `;
  } catch (err) {
    // stats 係观测数据 — 寫失敗唔准影響 AI pipeline / inbox
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ai stats: record failed (ignored)"
    );
  }
}

export async function getAiCallStats(): Promise<AiCallStatsRow | null> {
  const row = await prisma.aiCallStats.findUnique({ where: { id: 1 } });
  return row;
}
