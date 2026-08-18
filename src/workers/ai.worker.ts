import { Worker, type Job } from "bullmq";
import { aiQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import log from "@/lib/log";

/**
 * ai worker — Phase 0-C STUB。
 *
 * Phase 2 填實（框架 MD §7）：
 * - 意圖分類（guided JSON，8 類 taxonomy）
 * - 覆客草稿生成（注入 greetingConfig + 近 10 條 + 醫療鐵律）
 * - circuit breaker：連續 3 fail → OPEN 60s（skip AI 唔排隊）
 * - 寫 AiDraft(PROPOSED) + Socket 推 draft:ready
 *
 * ★ PII：AI 係本地 vLLM（Tailscale 私網），但 log 仍然只准 metadata。
 *   草稿內文只寫 DB / 經 Socket 推前端，永不入 log。
 */
export function startAiWorker(): Worker {
  const worker = new Worker(
    aiQueue.name,
    async (job: Job) => {
      const data = (job.data ?? {}) as Record<string, unknown>;
      log.info(
        {
          jobId: job.id,
          queue: job.queueName,
          attemptsMade: job.attemptsMade,
          dataKeys: Object.keys(data),
        },
        "ai job received (stub)"
      );
      return { stub: true, jobId: job.id };
    },
    { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency: 3 }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "ai job completed (stub)");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "ai job failed");
  });
  worker.on("error", (err) => {
    // Connection-level error（e.g. Redis retry 耗盡）→ log 後 exit，PM2 重啟 process。
    // 唔好留低一個死咗嘅 worker 冇聲冇息（silent outage 比 crash 可怕）。
    log.error({ queue: aiQueue.name, err: err.message }, "ai worker error — exiting for PM2 restart");
    process.exit(1);
  });

  return worker;
}
