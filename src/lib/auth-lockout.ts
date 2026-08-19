/**
 * Per-account login lockout（AppSec 審計 AS-3③）。
 *
 * 背景：per-IP 限流（login route in-memory）可被換 IP 繞過（AS-3②）—
 * 同一帳號用唔同 IP 各撳 4 次就永遠撞唔到 IP 限流。per-account lockout 兜底：
 * 同一 email 連續 5 次認證失敗 → 15 分鐘冷卻，換 IP 都冇用。
 *
 * 機制（Redis）：
 * - `loginfail:<email>`  — INCR 計數器（TTL = cooldown + 60s，失敗窗口邊界）
 * - `lockout:<email>`    — 計數 >= 5 時 `SET lockout:<email> 1 NX EX 900`（15 分鐘冷卻）
 * - 登入成功 → 清計數器（「連續」語義：成功一次就重計）
 *
 * 邊界：
 * - Mock mode（WA_MOCK=1）全部 bypass — e2e 唔需要處理 lockout（E2E 有斷言）
 * - Redis 故障 → fail-open（登入可用性優先；IP 限流層仍然有效）+ log warn
 * - email 一律 lowercase + trim 做 key（防 case 變體繞過）
 */
import { getRedis } from "@/lib/queue";
import log from "@/lib/log";
import { waMock } from "@/lib/wa/graph";

const LOCKOUT_PREFIX = "lockout:";
const FAIL_PREFIX = "loginfail:";
const DEFAULT_LIMIT = 5; // 連續失敗上限
const DEFAULT_COOLDOWN_SEC = 900; // 15 分鐘冷卻

export function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

function mockMode(): boolean {
  // 每次 call 讀 env（e2e 子 process 改 env 測試）
  return waMock();
}

/** 帳號係否喺 lockout 冷卻期（mock mode / Redis 故障 → false，fail-open）。 */
export async function isAccountLocked(email: string): Promise<boolean> {
  if (mockMode()) return false;
  const key = `${LOCKOUT_PREFIX}${normalizeEmailKey(email)}`;
  try {
    const r = await getRedis().exists(key);
    return r > 0;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "lockout: redis 檢查失敗 — fail-open（IP 限流仍有效）"
    );
    return false;
  }
}

/**
 * 記一次認證失敗。
 * @returns true = 呢次失敗觸發咗 lockout（計數達上限 + lockout key 新建）
 */
export async function recordLoginFailure(
  email: string,
  limit: number = DEFAULT_LIMIT,
  cooldownSec: number = DEFAULT_COOLDOWN_SEC
): Promise<boolean> {
  if (mockMode()) return false;
  const key = `${FAIL_PREFIX}${normalizeEmailKey(email)}`;
  try {
    const r = getRedis();
    const count = await r.incr(key);
    if (count === 1) {
      // 窗口邊界：計數器 ~15min 無新失敗就自然歸零（「連續」唔係「累計」）
      await r.expire(key, cooldownSec + 60);
    }
    if (count >= limit) {
      // NX：已有 lockout 就唔重設（唔延長冷卻）
      const set = await r.set(`${LOCKOUT_PREFIX}${normalizeEmailKey(email)}`, "1", "EX", cooldownSec, "NX");
      return set === "OK";
    }
    return false;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "lockout: redis 記數失敗 — fail-open"
    );
    return false;
  }
}

/** 登入成功 → 清失敗計數器（lockout key 唔清 — 冷卻期内即使密碼正確都唔俾入）。 */
export async function clearLoginFailures(email: string): Promise<void> {
  if (mockMode()) return;
  try {
    await getRedis().del(`${FAIL_PREFIX}${normalizeEmailKey(email)}`);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "lockout: redis 清計數失敗（唔阻主流程）"
    );
  }
}
