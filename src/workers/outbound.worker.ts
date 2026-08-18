import { Worker, type Job } from "bullmq";
import { outboundQueue, getRedis } from "@/lib/queue";
import log from "@/lib/log";

/**
 * outbound worker — Phase 0-C STUB。
 *
 * Phase 1 填實（框架 MD §6.3）：
 * - POST graph.facebook.com/{version}/{phone_number_id}/messages
 * - 24h 窗口檢查先喺 API route（lib/wa/window.ts），呢度負責發 + 重試
 * - 成功寫 waMessageId；attempts 3 + 指數 backoff（queue defaultJobOptions 已設）
 * - per-number token bucket rate limit（Cloud API 上限 80 msg/s，量級離天花板好遠，做保險）
 *
 * ★ PII 鐵律：log 只准 metadata（waMessageId / phone_number_id / status），內文永不入 log。
 */
export function startOutboundWorker(): Worker {
  const worker = new Worker(
    outboundQueue.name,
    async (job: Job) => {
      const data = (job.data ?? {}) as Record<string, unknown>;
      log.info(
        {
          jobId: job.id,
          queue: job.queueName,
          attemptsMade: job.attemptsMade,
          dataKeys: Object.keys(data),
        },
        "outbound job received (stub)"
      );
      return { stub: true, jobId: job.id };
    },
    { connection: getRedis(), concurrency: 5 }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "outbound job completed (stub)");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "outbound job failed");
  });
  worker.on("error", (err) => {
    // Connection-level error（e.g. Redis retry 耗盡）→ log 後 exit，PM2 重啟 process。
    // 唔好留低一個死咗嘅 worker 冇聲冇息（silent outage 比 crash 可怕）。
    log.error({ queue: outboundQueue.name, err: err.message }, "outbound worker error — exiting for PM2 restart");
    process.exit(1);
  });

  return worker;
}
