import { Queue, type QueueOptions } from "bullmq";
import IORedis from "ioredis";
import log from "@/lib/log";

/**
 * WA Clinic Inbox — BullMQ 骨架（框架 MD §1/§2）
 *
 * 4 個 queue：
 * - inbound  : webhook event 解析（patient 訊息 / echo / history / status）
 * - outbound : 發訊息 + 重試 + status 回寫
 * - ai       : 意圖識別 + 草稿生成（Phase 2）
 * - cron     : Apricot keepalive / 空檔 sync / 窗口到期提示（Phase 3/4）
 *
 * connection：單一 shared ioredis（BullMQ 要求 maxRetriesPerRequest: null）。
 * 注意：healthz 用獨立 probe client（見 healthz route），唔共用呢個。
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let sharedRedis: IORedis | null = null;

/** Shared Redis connection（web server + workers 都經呢度）。 */
export function getRedis(): IORedis {
  if (!sharedRedis) {
    sharedRedis = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null, // BullMQ 要求（blocking commands）
      enableReadyCheck: true,
      connectTimeout: 5000,
      // Redis 重啟後 BullMQ 會用呢個重試；60s 內無限重試，之後 stop（PM2 負責重啟 process）
      retryStrategy(times) {
        if (times > 60) return null;
        return Math.min(times * 500, 5000);
      },
    });
    sharedRedis.on("error", (err) => {
      log.error({ err: err.message }, "redis connection error");
    });
    sharedRedis.on("ready", () => {
      log.info("redis connected");
    });
  }
  return sharedRedis;
}

/** Graceful shutdown 時用。 */
export async function closeRedis(): Promise<void> {
  if (sharedRedis) {
    await sharedRedis.quit().catch(() => sharedRedis?.disconnect());
    sharedRedis = null;
  }
}

function queueOptions(): QueueOptions {
  return {
    connection: getRedis(),
    prefix: "wa-inbox",
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  };
}

export const inboundQueue = new Queue("inbound", queueOptions());
export const outboundQueue = new Queue("outbound", queueOptions());
export const aiQueue = new Queue("ai", queueOptions());
export const cronQueue = new Queue("cron", queueOptions());

export const QUEUE_NAMES = {
  inbound: "inbound",
  outbound: "outbound",
  ai: "ai",
  cron: "cron",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
