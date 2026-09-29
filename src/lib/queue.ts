import { Queue, type QueueOptions } from "bullmq";
import IORedis from "ioredis";
import { existsSync } from "node:fs";
import path from "node:path";
export type { default as IORedis } from "ioredis"; // ★ cwi-final S4-2：ai.worker test hook 用（type-only re-export）
import log from "@/lib/log";

/**
 * WA Clinic Inbox — BullMQ 骨架（框架 MD §1/§2）
 *
 * 8 個 queue：
 * - inbound  : webhook event 解析（patient 訊息 / echo / history / status）
 * - outbound : 發訊息 + 重試 + status 回寫
 * - ai       : 意圖識別 + 草稿生成（Phase 2）
 * - ai-urgent: ★ cwi-final S1-14 急症通道獨立 lane（urgentHit 訊息 — concurrency 1，
 *              急症摘要唔排喺普通 ai job 後面；見 src/workers/concurrency.ts）
 * - cron     : 排程 light lane（★ cwi-final S6-5 拆出 — sweep 類 2m–15m 間隔 job；worker concurrency 4）
 * - cron-heavy: ★ cwi-final S6-5 排程 heavy lane（長批 job — 日報表 / retention-purge / followup-scan；
 *              worker concurrency 1 — 唔阻 light lane 短周期 sweep）
 * - media    : ★ Realtime P0 (R4) media 下載獨立隊列（inbound job 只落 row + enqueue，
 *              唔喺入面做 HTTP 下載 — 大 media 唔阻 per-conversation 順序）
 * - booking-write: ★ cwi-final S5-1（F1）createBooking 異步寫 Apricot（concurrency 1 —
 *              見 src/workers/concurrency.ts）— API 202 {state:"WRITING"} 先 enqueue
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
      // ★ cwi-final S6-5：唔再喺 60 次後 return null（null = 放棄重試，process 死等 PM2 重啟）—
      //   無限 backoff 重試（cap 10s）：Redis 重啟後 worker/web 自動重連自愈，PM2 restart 次數 = 0
      //   （T692(c) 實測：redis 停 90s → worker 自己恢復）
      retryStrategy(times) {
        return Math.min(times * 500, 10_000);
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

let appRedis: IORedis | null = null;

/** ★ cwi-qa CI-R1：request 路徑單次指令 timeout（ms）— 超時 reject → caller 自己 fail-open／fail-closed。 */
const APP_REDIS_COMMAND_TIMEOUT_MS = Number(process.env.APP_REDIS_COMMAND_TIMEOUT_MS ?? 1500);

/**
 * ★ cwi-qa CI-R1：request 路徑專用 Redis（session deny／rate limit／TOTP／nonce）。
 *
 * 點解唔用 getRedis()：shared client 係 BullMQ 規定嘅 `maxRetriesPerRequest: null` —
 * Redis 一斷，指令會喺 offline queue 無限等（唔 reject），caller 嘅 try/catch 永遠唔觸發 →
 * requireAuth → isSessionDenied 卡死 → 全部已登入 API 冇回應（CI run 36527615294：T692 停 Redis
 * 後 T693 嘅 curl 吊到 job 被 cancel）。呢個 client 有 commandTimeout + 有限 retry → 斷線時
 * ≤ 1.5s reject，註釋講嘅 fail-open 先真係生效。
 */
export function getAppRedis(): IORedis {
  if (!appRedis) {
    appRedis = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: APP_REDIS_COMMAND_TIMEOUT_MS,
      enableReadyCheck: true,
      connectTimeout: 5000,
      retryStrategy(times) {
        return Math.min(times * 500, 10_000);
      },
    });
    appRedis.on("error", (err) => {
      log.warn({ err: err.message }, "app redis connection error");
    });
  }
  return appRedis;
}

/** Graceful shutdown 時用。 */
export async function closeRedis(): Promise<void> {
  if (sharedRedis) {
    await sharedRedis.quit().catch(() => sharedRedis?.disconnect());
    sharedRedis = null;
  }
  if (appRedis) {
    await appRedis.quit().catch(() => appRedis?.disconnect());
    appRedis = null;
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
// ★ cwi-final S1-14：急症通道獨立 queue（worker concurrency 1 — 見 ai.worker.ts startAiUrgentWorker）
export const aiUrgentQueue = new Queue("ai-urgent", queueOptions());
export const cronQueue = new Queue("cron", queueOptions());
// ★ cwi-final S6-5：cron 拆兩條 queue — light（cronQueue，concurrency 4）+ heavy（concurrency 1）。
//   兩個 worker 共用同一個 handler switch（job name 唔會排錯隊列失靈 — 見 src/workers/cron.worker.ts）。
export const cronHeavyQueue = new Queue("cron-heavy", queueOptions());
// ★ Realtime P0 (R4)：media 下載獨立隊列（concurrency 3 — 見 src/workers/media.worker.ts）
export const mediaQueue = new Queue("media", queueOptions());
// ★ cwi-final S5-1（F1）：booking-write — createBooking 異步寫 Apricot（worker concurrency 1）
export const bookingWriteQueue = new Queue("booking-write", queueOptions());

export const QUEUE_NAMES = {
  inbound: "inbound",
  outbound: "outbound",
  ai: "ai",
  aiUrgent: "ai-urgent", // ★ cwi-final S1-14
  cron: "cron",
  cronHeavy: "cron-heavy", // ★ cwi-final S6-5
  media: "media",
  bookingWrite: "booking-write", // ★ cwi-final S5-1（F1）
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ── cwi-notify-fix-20260907（§7 撤回作廢）：8 秒撤回窗口整節剷 ────────────────────────────
// 舊 UNDO_WINDOW_MS + delay: 8000 已刪 — send job 即刻送（jobId 冪等保留）。
// MsgStatus.CANCELLED enum 值保留（零 migration — 淨剷功能；worker 側 guard 做 legacy 雙保險）。

/**
 * outbound 發送 job 統一 enqueue 入口：
 * - 即刻送（冇 delay — 8s 撤回窗口已作廢）
 * - jobId 預設 messageId — 冪等（client retry / 重複調用唔會建重複 job）
 * - ⚠️ **重新 enqueue 已存在嘅 message（retry / sweep 類）必傳 fresh 唯一 jobId**：
 *   完成 job 嘅 key 會保留（removeOnComplete count:20）→ 用同一 jobId 再 add 會撞 BullMQ
 *   `handleDuplicatedJob`（Lua 實證：jobIdKey EXISTS → 靜默 return 舊 jobId，唔入 wait list、唔 throw）
 *   → 訊息永久卡 QUEUED。（2026-09-28 G4 gen5 T693 事故實測；同 booking-write 註釋嘅 trap。）
 * 註：reminder cron / AI AUTO 覆都行同一入口（全部係首次 enqueue 新 message → 預設 jobId 安全）。
 */
export async function enqueueOutboundSend(messageId: string, jobId?: string): Promise<void> {
  // ★ cwi-final S1-15 (P0-07) 測試 hook：ENQUEUE_DELAY_MS 人工拉長 enqueue 延遲
  //   （e2e T716：2000 > caller 1500ms race timeout → 202 enqueueUncertain 路徑實測）。
  //   production 未設 = 0（零行為改變）。
  const delayMs = Math.max(0, parseInt(process.env.ENQUEUE_DELAY_MS ?? "0", 10) || 0);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  await outboundQueue.add("send", { messageId }, { jobId: jobId ?? messageId });
}

// ── ★ cwi-final S5-1（F1）：booking-write job ─────────────────────────────────────

/** booking-write job data（createBooking 所需嘅全部參數快照 — worker 唔需要再查 dictionaries） */
export interface BookingWriteJobData {
  bookingId: string;
  actor: { type: "STAFF"; staffId: string } | { type: "AI"; sessionId: string };
  visitReasonId: string;
  visitReasonCode: string | null;
  /** AI 路徑觸發訊息（自動確認訊息 sendAuto gate 用；STAFF 路徑 null） */
  triggerMsgId: string | null;
}

/** queue 不可用（Redis 斷 / 起唔到 queue）— confirm-core 回 PRECONDITION QUEUE_UNAVAILABLE。 */
export class QueueUnavailableError extends Error {
  constructor() {
    super("booking-write queue unavailable");
    this.name = "QueueUnavailableError";
  }
}

// ★ e2e test hook（T672）：模擬 queue 死 — flag 檔存在 → enqueueBookingWriteJob throw。
//   只影響 enqueue 入口（dev-only；production 唔會有呢個檔）→ 零 prod 行為改變。
export const BOOKING_WRITE_QUEUE_OFF_FLAG = ".dev/booking-write-queue-off.json";

/**
 * booking-write enqueue 統一入口：
 * - jobId: bw-${bookingId}-${idemAttempt}-${claimNonce}（caller 提供 — 帶 claim nonce；
 *   穩定 jobId 會被 BullMQ 預設 keepJobs={count:-1} 嘅已完成 hash 冪等掉 → retry no-op）
 * - queue 不可用 → throw QueueUnavailableError（caller 負責 rollback writeState）
 */
export async function enqueueBookingWriteJob(data: BookingWriteJobData, jobId: string): Promise<void> {
  if (existsSync(path.resolve(process.cwd(), BOOKING_WRITE_QUEUE_OFF_FLAG))) {
    log.warn({ jobId }, "booking-write: queue off flag — 模擬 queue 死（e2e T672）");
    throw new QueueUnavailableError();
  }
  await bookingWriteQueue.add("create", data, { jobId });
}
