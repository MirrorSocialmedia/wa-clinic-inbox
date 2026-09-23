/**
 * Per-key token bucket rate limiter（框架 MD §6.3：per-number 80 msg/s 保險）。
 *
 * 用量級離 Cloud API 天花板十萬八千里，呢個只係保險（防 bug 造成 burst 被封號）。
 * In-memory（單 process worker）；key 一般係 phone_number_id。
 *
 * ★ cwi-final S3-6：另加 Redis sliding window（API 限流層 — 見檔案下半）。
 */
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// ── ★ cwi-final S3-6：Redis sliding window（API 限流層 — spec 逐字）──────────────
// 用途：login（IP 10/min + 帳號 20/15min 軟延遲）、change-password 5/15min、
//       flows/endpoint（IP 60/min + flow_token 30/min）、search（staff 30/min）。
// 故障口徑：Redis 下 → fail-open（hit=true / count=0）+ log warn（同 auth-lockout 現行口徑 —
//   可用性優先；CSRF middleware + argon2 成本另層防護）。

/**
 * Sliding window 計數（spec 逐字）：每 windowSec 一個 key，INCR；n=1 時設 EXPIRE。
 * @returns true = 冇超限（n <= limit）。Redis 故障 → true（fail-open）。
 */
export async function hit(key: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    const k = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
    const n = await getRedis().incr(k);
    if (n === 1) await getRedis().expire(k, windowSec + 1);
    return n <= limit;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "rate-limit: Redis fail-open（hit）");
    return true;
  }
}

/** 同 hit() 但返實際計數（軟延遲 2^n 計算用）。Redis 故障 → 0（fail-open）。 */
export async function hitCount(key: string, windowSec: number): Promise<number> {
  try {
    const k = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
    const n = await getRedis().incr(k);
    if (n === 1) await getRedis().expire(k, windowSec + 1);
    return n;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "rate-limit: Redis fail-open（hitCount）");
    return 0;
  }
}

/**
 * 客戶端 IP（S3-6）：Cloudflare `cf-connecting-ip` 優先；冇就 XFF **第一個**值
 *（**只喺 TRUST_PROXY=1 時信** — dev .env.local local-only）；再冇 → "local"。
 * 口徑改動註（AS-3② 舊 clientIp 取最後值）：TRUST_PROXY 模式下第一值係可信來源
 *（nginx $remote_addr 覆蓋 / e2e bucket）；非 TRUST_PROXY 唔信任何 XFF（防客戶端自塞）。
 */
export function clientIpFromHeaders(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  if (process.env.TRUST_PROXY === "1") {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return "local";
}

/**
 * ★ S3-6 login 帳號維度軟延遲：20/15min 窗口，超過後每次延遲 2^n 秒（n = 超額次數，上限 30s）
 * 而唔係硬鎖（spec：防惡意鎖人）。喺 argon2 verify 前調（延遲先驗證）。
 * @returns 延遲 ms（0 = 窗口內 / Redis fail-open）
 */
export async function loginSoftDelayMs(email: string): Promise<number> {
  const key = email.trim().toLowerCase();
  const n = await hitCount(`login:acct:${key}`, 15 * 60);
  const excess = n - 20;
  if (excess <= 0) return 0;
  const sec = Math.min(2 ** excess, 30);
  return sec * 1000;
}

const buckets = new Map<string, Bucket>();

/** 定期清閒置 bucket，防 Map 無限增長 */
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.lastRefill > 5 * 60_000) buckets.delete(k);
}, 5 * 60_000).unref();

/**
 * 攞一個 token。
 * @param key bucket key（e.g. phone_number_id）
 * @param capacity 上限（預設 80 = Cloud API per-number msg/s）
 * @param refillPerSec 每秒補多少（預設 = capacity，每秒全補）
 * @param maxWaitMs 最多等幾耐（預設 250ms）— 超時 throw（job retry 會處理）
 */
export async function acquireToken(opts: {
  key: string;
  capacity?: number;
  refillPerSec?: number;
  maxWaitMs?: number;
}): Promise<void> {
  const { key } = opts;
  const capacity = opts.capacity ?? 80;
  const refillPerSec = opts.refillPerSec ?? capacity;
  const maxWaitMs = opts.maxWaitMs ?? 250;
  const start = Date.now();

  for (;;) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, lastRefill: now };
      buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.lastRefill) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
      b.lastRefill = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    if (Date.now() - start >= maxWaitMs) {
      throw new Error(`rate limit wait timeout: ${key} (capacity=${capacity}/s)`);
    }
    // 等一輪（~50ms），避免 busy loop
    await new Promise((r) => setTimeout(r, 50));
  }
}
