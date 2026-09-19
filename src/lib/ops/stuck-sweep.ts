/**
 * ★ cwi-final S1-1b（C-1②）— stuck-sweep：commit 後副作用丟失兜底（light cron lane，每 5 分鐘）。
 *
 * 背景：inbound job 喺「tx commit」同「media/AI enqueue」之間 crash → 重試時 claim 已存在
 * → skipped 分支補做（ensureSideEffects）；但如果連 retry 都冇（例如 queue 記錄被清 / worker
 * 長期down），media 會永久 PENDING、AI 會永久無 draft。呢個 sweep 每 5 分鐘兜底：
 *
 *  1. media：`mediaStatus=PENDING AND createdAt < now-10min` → 重 enqueue（jobId=media-<id> 冪等）。
 *     無 payload（DB 唔存 WA mediaId）→ media worker 見唔到 mediaId → SKIPPED（誠實終態）。
 *  2. ai：最近 30 分鐘 `IN + API + text` 且無 AiDraft 且 `aiQueue.getJob("ai-<id>")=null` → 重 enqueue。
 *
 * 冪等：兩邊都靠同 jobId + 前置存在性檢查 — 原 job 仲喺 queue → BullMQ 自動忽略；
 * 已處理（READY / 有 draft）→ 唔會再命中 query。零 PII：log 只計數。
 *
 * 上限 50／輪（保護 DB / queue；积压会跨多轮清 — 每 5 分鐘一輪，足够）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { aiQueue, mediaQueue } from "@/lib/queue";

const PER_ROUND_LIMIT = 50;
const MEDIA_STUCK_MIN = 10; // PENDING 超過 10 分鐘先算 stuck
const AI_WINDOW_MIN = 30; // 最近 30 分鐘嘅 IN text

export interface StuckSweepResult {
  mediaReenqueued: number;
  aiReenqueued: number;
  mediaScanned: number;
  aiScanned: number;
  capped: boolean;
}

export async function runStuckSweep(): Promise<StuckSweepResult> {
  const now = Date.now();
  const mediaCutoff = new Date(now - MEDIA_STUCK_MIN * 60_000);
  const aiCutoff = new Date(now - AI_WINDOW_MIN * 60_000);

  let mediaReenqueued = 0;
  let aiReenqueued = 0;
  let mediaScanned = 0;
  let aiScanned = 0;
  let total = 0;

  // ── 1. media PENDING > 10min ─────────────────────────────────────────
  const mediaRows = await prisma.message.findMany({
    where: { mediaStatus: "PENDING", createdAt: { lt: mediaCutoff } },
    select: { id: true },
    take: PER_ROUND_LIMIT,
  });
  mediaScanned = mediaRows.length;
  for (const m of mediaRows) {
    if (total >= PER_ROUND_LIMIT) break;
    total += 1;
    try {
      // race 保護：重新確認仲係 PENDING（可能 media worker 同時處理緊 / 剛處理完）
      const cur = await prisma.message.findUnique({ where: { id: m.id }, select: { mediaStatus: true, conversationId: true } });
      if (cur?.mediaStatus !== "PENDING") continue;
      const conv = await prisma.conversation.findUnique({ where: { id: cur.conversationId }, select: { clinicId: true } });
      if (!conv) continue;
      // enqueue 永遠喺 tx 外（R-7）；無 payload（只 messageId+clinicId）→ media worker SKIPPED 或 no-op 冪等
      await mediaQueue.add("download", { messageId: m.id, clinicId: conv.clinicId }, { jobId: `media-${m.id}` });
      mediaReenqueued += 1;
    } catch (err) {
      log.warn({ messageId: m.id, err: err instanceof Error ? err.message : String(err) }, "stuck-sweep: media re-enqueue failed");
    }
  }

  // ── 2. 最近 30 分鐘 IN+API+text 無 AiDraft 且 aiQueue 冇 job ──────────
  const aiRows = await prisma.message.findMany({
    where: { direction: "IN", channel: "API", type: "text", createdAt: { gte: aiCutoff } },
    select: { id: true, conversationId: true },
    take: PER_ROUND_LIMIT,
  });
  aiScanned = aiRows.length;
  for (const m of aiRows) {
    if (total >= PER_ROUND_LIMIT) break;
    total += 1;
    try {
      // 已有 draft → 唔使補
      const hasDraft = await prisma.aiDraft.findFirst({ where: { inReplyToMessageId: m.id }, select: { id: true } });
      if (hasDraft) continue;
      // aiQueue 仲有 job（waiting/active/delayed/completed/failed）→ 唔係「丟」
      const existingJob = await aiQueue.getJob(`ai-${m.id}`);
      if (existingJob) continue;
      const conv = await prisma.conversation.findUnique({ where: { id: m.conversationId }, select: { clinicId: true } });
      if (!conv) continue;
      await aiQueue.add("classify", { conversationId: m.conversationId, messageId: m.id, clinicId: conv.clinicId }, { jobId: `ai-${m.id}` });
      aiReenqueued += 1;
    } catch (err) {
      log.warn({ messageId: m.id, err: err instanceof Error ? err.message : String(err) }, "stuck-sweep: ai re-enqueue failed");
    }
  }

  const capped = total >= PER_ROUND_LIMIT;
  log.info({ mediaReenqueued, aiReenqueued, mediaScanned, aiScanned, capped }, "stuck-sweep: done");
  return { mediaReenqueued, aiReenqueued, mediaScanned, aiScanned, capped };
}
