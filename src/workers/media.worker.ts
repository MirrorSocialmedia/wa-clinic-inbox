/**
 * ★ Realtime P0 (R4, cwi-rt-20260823-a1) — media worker：獨立 media 下載隊列。
 *
 * 設計（realtime MD R4）：
 * - inbound job 只做「Message 落 DB（mediaStatus=PENDING）+ enqueue media job」即完，
 *   唔喺 inbound 裏面做 HTTP 下載 — 大 media 唔會阻住同對話後面的訊息
 *   （per-conversation ordering 由 inbound concurrency=1 保證；media 係旁路）。
 * - 呢度（concurrency = MEDIA_CONCURRENCY = 3）做實際下載：
 *     成功 → mediaPath + mediaStatus=READY + emit `media:ready`（client 即時補附件）
 *     mock/跳過 → mediaStatus=SKIPPED（mediaPath 保持 null — UI 顯示占位）
 *     失敗 → 重試（queue 預設 3 次）；exhausted → mediaStatus=FAILED
 * - 冪等：jobId = media-<messageId>（BullMQ 同 jobId 唔會重複 enqueue）；
 *   就算重入，mediaPath 已有值 / mediaStatus 唔係 PENDING → 直接 skip。
 *
 * ★ R2 鐵律：publish 永遠喺 commit 之後（呢度 update 完成先 publishNotify）。
 * ★ PII 鐵律：log 只准 metadata（messageId/wamid/bytes/path），訊息原文/媒體內容唔出 log。
 */
import { Worker, type Job } from "bullmq";
import { mediaQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";
import { downloadWaMedia } from "@/lib/wa/media";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { MEDIA_CONCURRENCY } from "./concurrency";

interface MediaJobData {
  messageId: string;
  mediaId: string;
  wamid: string;
  clinicId: string;
}

async function processMediaJob(job: Job<MediaJobData>): Promise<void> {
  const { messageId, mediaId, wamid, clinicId } = job.data;

  // ★ R9 chaos test hook（dev only）：模擬大 media 下載延遲
  //   （e2e 用 MEDIA_CHAOS_DELAY_MS=8000 驗收「大 media 唔阻其他對話」）。
  //   production 唔設呢個 env；NODE_ENV 雙保險。
  const chaosDelayMs = Number(process.env.MEDIA_CHAOS_DELAY_MS ?? 0);
  if (chaosDelayMs > 0 && process.env.NODE_ENV !== "production") {
    log.warn({ messageId, delayMs: chaosDelayMs }, "media: chaos delay (dev test hook)");
    await new Promise((r) => setTimeout(r, chaosDelayMs));
  }

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) {
    log.warn({ messageId, wamid }, "media: message not found (already deleted?) — skipped");
    return;
  }
  // 冪等：已處理過（重入 / 重複 enqueue）→ skip
  if (msg.mediaPath || msg.mediaStatus !== "PENDING") {
    log.info({ messageId, wamid, mediaStatus: msg.mediaStatus }, "media: already resolved — skipped");
    return;
  }

  const dl = await downloadWaMedia({ mediaId, wamid });

  if (dl.mediaPath) {
    await prisma.message.update({
      where: { id: messageId },
      data: { mediaPath: dl.mediaPath, mediaStatus: "READY" },
    });
    log.info({ messageId, wamid, path: dl.mediaPath }, "media: download complete");
    // ★ R2：commit 之後先 emit（上面 update 已 commit；publish 唔喺任何 $transaction 入面）
    publishNotify(clinicId, "media:ready", {
      conversationId: msg.conversationId,
      clinicId,
      messageId,
      mediaPath: dl.mediaPath,
    });
  } else {
    // mock mode / http 錯誤 / too-large → SKIPPED（訊息保留，冇附件）
    await prisma.message.update({
      where: { id: messageId },
      data: { mediaStatus: "SKIPPED" },
    });
    log.info({ messageId, wamid, reason: dl.reason ?? "unknown" }, "media: skipped");
  }
}

export function startMediaWorker(): Worker {
  const worker = new Worker<MediaJobData>(
    mediaQueue.name,
    processMediaJob,
    // ★ Realtime P0 (R4)：media 並行度 — 調大/調細只影響下載吞吐，唔影響 per-conversation 順序
    { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency: MEDIA_CONCURRENCY }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "media job completed");
  });
  worker.on("failed", async (job, err) => {
    // 重試 exhausted → 標 FAILED（訊息保留；staff 可見「附件處理失敗」）
    const d = job?.data as MediaJobData | undefined;
    if (d?.messageId) {
      await prisma.message
        .update({ where: { id: d.messageId }, data: { mediaStatus: "FAILED" } })
        .catch(() => undefined);
    }
    log.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      "media job failed (final) — message 保留，mediaStatus=FAILED"
    );
  });
  worker.on("error", (err) => {
    log.error({ queue: mediaQueue.name, err: err.message }, "media worker error — exiting for PM2 restart");
    process.exit(1);
  });

  return worker;
}
