/**
 * Per-key token bucket rate limiter（框架 MD §6.3：per-number 80 msg/s 保險）。
 *
 * 用量級離 Cloud API 天花板十萬八千里，呢個只係保險（防 bug 造成 burst 被封號）。
 * In-memory（單 process worker）；key 一般係 phone_number_id。
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
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
