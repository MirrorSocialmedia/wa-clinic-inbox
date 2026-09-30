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
 * ★ cwi-qa FX-12（QA-12）第 3 條：booking `writeState=WRITING AND writeAttemptAt < now-15min`
 *   且 booking-write queue 冇該 booking 嘅 active job（jobId 前綴 `bw-<id>-`，nonce 唔穩定
 *   → getJobIds 掃 + 逐個核 state）→ job 丟失 → UNKNOWN + writeError job_lost_sweep
 *   （唔係 FAILED — 唔知有冇落到；staff 可撳〔重試〕— 同 idempotency key 冪等安全）。
 *   背景：claim 只接受 null/FAILED/UNKNOWN → 行卡死 WRITING = 卡片永遠「落單處理緊」。
 *
 * 冪等：兩邊都靠同 jobId + 前置存在性檢查 — 原 job 仲喺 queue → BullMQ 自動忽略；
 * 已處理（READY / 有 draft）→ 唔會再命中 query。零 PII：log 只計數。
 *
 * 上限 50／輪（保護 DB / queue；积压会跨多轮清 — 每 5 分鐘一輪，足够）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { aiQueue, mediaQueue, bookingWriteQueue } from "@/lib/queue";

const PER_ROUND_LIMIT = 50;
const MEDIA_STUCK_MIN = 10; // PENDING 超過 10 分鐘先算 stuck
const AI_WINDOW_MIN = 30; // 最近 30 分鐘嘅 IN text
const WRITING_STUCK_MIN = 15; // ★ cwi-qa FX-12：WRITING 超過 15 分鐘 + 無 active job = job 丟失

export interface StuckSweepResult {
  mediaReenqueued: number;
  aiReenqueued: number;
  mediaScanned: number;
  aiScanned: number;
  bookingSwept: number; // ★ cwi-qa FX-12
  bookingScanned: number; // ★ cwi-qa FX-12
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
  // ★ cwi-qa FX-12：booking WRITING 丟失 sweep（獨立函數 — unit test 可單調，唔觸 ai/media queue）
  const booking = await sweepStuckBookingWrites(now);
  log.info(
    {
      mediaReenqueued,
      aiReenqueued,
      mediaScanned,
      aiScanned,
      bookingSwept: booking.bookingSwept,
      bookingScanned: booking.bookingScanned,
      capped,
    },
    "stuck-sweep: done"
  );
  return { mediaReenqueued, aiReenqueued, mediaScanned, aiScanned, bookingSwept: booking.bookingSwept, bookingScanned: booking.bookingScanned, capped };
}

/**
 * ★ cwi-qa FX-12（QA-12）：booking `writeState=WRITING` 超過 15 分鐘 + queue 冇該 booking
 * 嘅 active job → job 丟失 → UNKNOWN + writeError job_lost_sweep。
 *
 * 背景：confirm-core claim 只接受 null/FAILED/UNKNOWN（WRITING 唔會再 claim）— job 一旦丟失
 * （Redis 重啟 job 清咗 / 手動誤刪）→ 行永久 WRITING → 卡片永遠「落單處理緊」。
 * job 丟失 = 未知有冇寫到 Apricot（job 可能已部分執行）→ UNKNOWN（唔係 FAILED — 唔會誤導
 * 「未落到，可以人手落」）+ staff 可撳〔重試〕（同 idempotencyKey 冪等重放安全）。
 *
 * job 偵測：jobId = `bw-<bookingId>-<idemAttempt>-<nonce>`（nonce 每次 claim 變 — 無單一穩定
 * jobId 可以 getJob）→ getJobs（非終態 states：wait/waiting/active/delayed/prioritized/
 * waiting-children）+ 前綴匹配。completed/failed = 終態 job，天然唔喺列表入面（唔算保護）。
 * queue 查詢失敗（Redis blip）→ 呢輪 skip booking 段（保守 — 唔會在睇唔到 queue 時誤標 UNKNOWN）。
 */
export async function sweepStuckBookingWrites(nowMs: number = Date.now()): Promise<{ bookingSwept: number; bookingScanned: number }> {
  const writingCutoff = new Date(nowMs - WRITING_STUCK_MIN * 60_000);
  const bookingRows = await prisma.bookingRequest.findMany({
    where: { status: "PENDING", writeState: "WRITING", writeAttemptAt: { lt: writingCutoff } },
    select: { id: true },
    take: PER_ROUND_LIMIT,
  });
  let bookingScanned = 0;
  let bookingSwept = 0;

  // queue job 偵測（一次掃 — 只喺有候選 row 先查；v6 getJobs 只攞非終態 = active 語義）
  let activeJobIds: string[] | null = null;
  if (bookingRows.length > 0) {
    try {
      const jobs = await bookingWriteQueue.getJobs(["wait", "waiting", "active", "delayed", "prioritized", "waiting-children"] as const);
      activeJobIds = jobs.map((j) => j.id).filter((x): x is string => typeof x === "string");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "stuck-sweep: booking-write queue getJobs failed — skip booking sweep this round");
    }
  }

  for (const b of bookingRows) {
    bookingScanned += 1;
    try {
      if (activeJobIds === null) continue; // queue 睇唔到 → 保守 skip（下輪再試）
      // 有 active job（waiting/delayed/active/paused…）→ 唔係丟
      const hasActive = activeJobIds.some((j) => j.startsWith(`bw-${b.id}-`));
      if (hasActive) continue;
      // 丟 → 條件 update（race 保護：仲係 PENDING + WRITING + 仲超過 cutoff）
      const w = await prisma.bookingRequest.updateMany({
        where: { id: b.id, status: "PENDING", writeState: "WRITING", writeAttemptAt: { lt: writingCutoff } },
        data: { writeState: "UNKNOWN", writeError: "job_lost_sweep" },
      });
      if (w.count === 1) bookingSwept += 1;
    } catch (err) {
      log.warn({ bookingId: b.id, err: err instanceof Error ? err.message : String(err) }, "stuck-sweep: booking WRITING sweep failed");
    }
  }
  return { bookingSwept, bookingScanned };
}
