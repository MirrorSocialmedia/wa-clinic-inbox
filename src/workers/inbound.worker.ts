import { Worker, type Job } from "bullmq";
import { inboundQueue, getRedis } from "@/lib/queue";
import log from "@/lib/log";

/**
 * inbound worker — Phase 0-C STUB。
 *
 * Phase 1 填實（框架 MD §6.2）：
 * - 分流：entry[].changes[].value.metadata.phone_number_id → Clinic.waPhoneNumberId
 * - 冪等：wamid upsert WebhookEvent
 * - messages[] / smb_message_echoes / history / statuses 各自處理
 * - Socket 推 message:new 去 clinic:{id} room
 *
 * ★ PII 鐵律：log 只准 metadata，訊息原文永不入 log（要 log payload 先過 redactDeep）。
 */
export function startInboundWorker(): Worker {
  const worker = new Worker(
    inboundQueue.name,
    async (job: Job) => {
      const data = (job.data ?? {}) as Record<string, unknown>;
      log.info(
        {
          jobId: job.id,
          queue: job.queueName,
          attemptsMade: job.attemptsMade,
          dataKeys: Object.keys(data),
        },
        "inbound job received (stub)"
      );
      return { stub: true, jobId: job.id };
    },
    { connection: getRedis(), concurrency: 5 }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "inbound job completed (stub)");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "inbound job failed");
  });
  worker.on("error", (err) => {
    // Connection-level error（e.g. Redis retry 耗盡）→ log 後 exit，PM2 重啟 process。
    // 唔好留低一個死咗嘅 worker 冇聲冇息（silent outage 比 crash 可怕）。
    log.error({ queue: inboundQueue.name, err: err.message }, "inbound worker error — exiting for PM2 restart");
    process.exit(1);
  });

  return worker;
}
