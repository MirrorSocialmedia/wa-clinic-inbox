import { Worker, type Job } from "bullmq";
import { cronQueue, getRedis } from "@/lib/queue";
import log from "@/lib/log";

/**
 * cron worker — Phase 0-C STUB。
 *
 * Phase 3/4 填實（框架 MD §8.1 / §9.3）：
 * - Apricot keepalive（每 3 日輕量 request 頂住 7 日 sliding window）
 * - 空檔 sync（每 15 分鐘 getOverviewAppointments → AvailabilitySlot）
 * - 24h 窗口到期提示
 * - 每 5 分鐘自檢：webhook 最後事件時間差 / queue depth / AI breaker / disk 餘量
 *
 * 排程入口（cron schedule）Phase 3 先加：用 BullMQ repeatable job 或独立 scheduler。
 * ★ PII：log 只准 metadata。
 */
export function startCronWorker(): Worker {
  const worker = new Worker(
    cronQueue.name,
    async (job: Job) => {
      const data = (job.data ?? {}) as Record<string, unknown>;
      log.info(
        {
          jobId: job.id,
          queue: job.queueName,
          attemptsMade: job.attemptsMade,
          dataKeys: Object.keys(data),
        },
        "cron job received (stub)"
      );
      return { stub: true, jobId: job.id };
    },
    { connection: getRedis(), concurrency: 1 }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "cron job completed (stub)");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "cron job failed");
  });

  return worker;
}
