import { Queue, type QueueOptions } from "bullmq";
import IORedis from "ioredis";
import log from "@/lib/log";

/**
 * WA Clinic Inbox — BullMQ 骨架（框架 MD §1/§2）
 *
 * 5 個 queue：
 * - inbound  : webhook event 解析（patient 訊息 / echo / history / status）
 * - outbound : 發訊息 + 重試 + status 回寫
 * - ai       : 意圖識別 + 草稿生成（Phase 2）
 * - cron     : 排程入口（空檔 refresh / bookings-expire / 健康自檢）
 * - media    : ★ Realtime P0 (R4) media 下載獨立隊列（inbound job 只落 row + enqueue，
 *              唔喺入面做 HTTP 下載 — 大 media 唔阻 per-conversation 順序）
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

export const QUEUE_PREFIX = "wa-inbox";

// ★ cwi-final S1-1a：inbound queue 獨立 retry 口徑 — attempts 8 + exponential 2000（最長 ~4.2 分鐘：
//   2+4+8+16+32+64+128s）— 覆蓋 DB 短暫重啟；最終失敗 → DLQ（見 inbound.worker failed handler）。
//   其他 queue（outbound/ai/cron/media）零改動 — 保持 attempts 3。
export const INBOUND_ATTEMPTS = 8;

function queueOptions(defaultJobOptions?: Record<string, unknown>): QueueOptions {
  return {
    connection: getRedis(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      // ★ AS-1（AppSec 審計）：queue 記錄保留收細 — inbound job 嘅 data 係 raw webhook
      //   payload（含病人訊息原文），完成/失敗 job 會留喺 Redis（RDB/AOF 仲會明文落碟）。
      //   冪等靠 DB 層（WebhookEvent claim + Message.waMessageId unique），唔靠 queue 記錄 —
      //   所以保留多 job 冇任何功能價值，只係擴大大原文滯留面：
      //   完成 job 留 20 條、失敗 job 留 24h / 上限 200 條（debug 夠用）。
      removeOnComplete: { count: 20 },
      removeOnFail: { age: 86400, count: 200 },
      ...defaultJobOptions,
    },
  };
}

export const inboundQueue = new Queue("inbound", queueOptions({ attempts: INBOUND_ATTEMPTS }));
export const outboundQueue = new Queue("outbound", queueOptions());
export const aiQueue = new Queue("ai", queueOptions());
export const cronQueue = new Queue("cron", queueOptions());
// ★ Realtime P0 (R4)：media 下載獨立隊列（concurrency 3 — 見 src/workers/media.worker.ts）
export const mediaQueue = new Queue("media", queueOptions());

export const QUEUE_NAMES = {
  inbound: "inbound",
  outbound: "outbound",
  ai: "ai",
  cron: "cron",
  media: "media",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ── cwi-notify-fix-20260907（§7 撤回作廢）：8 秒撤回窗口整節剷 ────────────────────────────
// 舊 UNDO_WINDOW_MS + delay: 8000 已刪 — send job 即刻送（jobId 冪等保留）。
// MsgStatus.CANCELLED enum 值保留（零 migration — 淨剷功能；worker 側 guard 做 legacy 雙保險）。

/**
 * outbound 發送 job 統一 enqueue 入口：
 * - 即刻送（冇 delay — 8s 撤回窗口已作廢）
 * - jobId: messageId — 冪等（client retry / 重複調用唔會建重複 job）
 * 註：reminder cron / AI AUTO 覆都行同一入口。
 */
export async function enqueueOutboundSend(messageId: string): Promise<void> {
  await outboundQueue.add("send", { messageId }, { jobId: messageId });
}
