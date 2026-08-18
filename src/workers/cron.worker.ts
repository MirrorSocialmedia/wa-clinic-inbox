/**
 * cron worker — 排程入口（MD §8.3）
 *
 * Job names（由 workers/index.ts 用 upsertJobScheduler 登記；E2E 可手動 enqueue）：
 * - sync-availability  每 15 分鐘（cron pattern: 15 分間隔） → enqueue apricot `sync-all`
 *                                       （apricot worker 執行，concurrency=1 序列化）
 * - apricot-keepalive  每 3 日（cron pattern: 隔 3 日 03:00） → enqueue apricot `keepalive`
 *                                       （14 日 token 唔死嘅 heartbeat 之一）
 * - bookings-expire    每 5 分鐘（cron pattern: 5 分間隔） → 48h PENDING → EXPIRED + 棄單 Flow 清理
 */
import { Worker } from "bullmq";
import { cronQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import log from "@/lib/log";
import { enqueueApricot } from "./apricot.worker";
import { runExpiry } from "@/lib/booking/expiry";

export async function startCronWorker(): Promise<Worker | null> {
  const worker = new Worker(
    cronQueue.name,
    async (job) => {
      switch (job.name) {
        case "sync-availability": {
          const jobId = await enqueueApricot("sync-all", { reason: "cron-15min" });
          log.info({ jobId }, "cron: sync-availability → apricot queue（apricot worker 會行）");
          return { ok: true, apricotJobId: jobId };
        }
        case "apricot-keepalive": {
          const jobId = await enqueueApricot("keepalive", {});
          log.info({ jobId }, "cron: apricot-keepalive → apricot queue");
          return { ok: true, apricotJobId: jobId };
        }
        case "bookings-expire": {
          const r = await runExpiry();
          return { ok: true, ...r };
        }
        default:
          log.warn({ jobName: job.name }, "cron worker: unknown job — skip");
      }
    },
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error({ job: job?.name, err: err.message }, "cron: job failed");
  });

  log.info({}, "cron worker started");
  return worker;
}
