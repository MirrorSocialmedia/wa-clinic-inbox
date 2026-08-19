/**
 * e2e-lockout — AS-3③ per-account lockout 機制測試（單元級，真 Redis）。
 *
 * 測**非 mock 路徑**：mock-e2e.sh 以 `WA_MOCK=0 pnpm e2e:lockout` 跑
 * （HTTP 層 e2e 係 mock mode — lockout 禁用由主腳本 T49 斷言）。
 *
 * 斷言：
 * - 4 次失敗 → 未 lock
 * - 第 5 次 → 觸發 lock（SET NX EX 900，TTL ≈ 900）
 * - lock 後 isLocked = true
 * - NX 語義：已 lock 時再失敗唔延長 TTL（冷卻唔被刷新）
 * - email case/whitespace 變體唔能繞過（同 key）
 * - 成功清計數器：清後重計（4 次唔 lock，第 5 次 lock）
 *
 * 清理：完事 DEL 自己嘅 key（persistent sandbox Redis）。
 * 用法：pnpm e2e:lockout
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
// ★ 顯式非 mock — 本測試要行真 lockout 路徑（.env 可能有 WA_MOCK=1）
process.env.WA_MOCK = "0";

import { getRedis } from "../src/lib/queue";
import {
  isAccountLocked,
  recordLoginFailure,
  clearLoginFailures,
  normalizeEmailKey,
} from "../src/lib/auth-lockout";

let failed = 0;
function check(desc: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? "✅" : "❌"} ${desc}${ok ? "" : ` (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`}`
  );
  if (!ok) failed++;
}

async function main(): Promise<void> {
  const email = `e2e-lock-${Date.now()}@wa-clinic.local`;
  const key = normalizeEmailKey(email);
  const redis = getRedis();

  try {
    // 起點乾淨
    await redis.del(`loginfail:${key}`, `lockout:${key}`);

    // 1) 4 次失敗 → 未 lock
    for (let i = 0; i < 4; i++) {
      check(`fail #${i + 1} 唔觸發 lock`, await recordLoginFailure(email), false);
    }
    check("4 次後未 lock", await isAccountLocked(email), false);

    // 2) 第 5 次 → 觸發 lock
    check("第 5 次觸發 lock", await recordLoginFailure(email), true);
    check("lock 生效（isLocked）", await isAccountLocked(email), true);

    // 3) TTL ≈ 900（SET EX 900）
    const ttl = await redis.ttl(`lockout:${key}`);
    check("lockout TTL 在 (0, 900] 範圍", ttl > 0 && ttl <= 900, true);

    // 4) NX 語義：已 lock 時再失敗唔延長冷卻
    const ttlBefore = await redis.ttl(`lockout:${key}`);
    await recordLoginFailure(email);
    const ttlAfter = await redis.ttl(`lockout:${key}`);
    check("已 lock 時 TTL 唔被刷新（NX）", ttlAfter <= ttlBefore, true);

    // 5) email 變體（case / whitespace）同 key — 繞唔到
    check("email case 變體同 key", normalizeEmailKey(`  ${email.toUpperCase()}  `), key);
    check("變體 email 都係 locked", await isAccountLocked(`  ${email.toUpperCase()}  `), true);

    // 6) 成功清計數器：清後重頭計（4 次唔 lock，第 5 次先 lock）
    await redis.del(`lockout:${key}`); // 模擬 lockout 期滿（EX 到期）
    await clearLoginFailures(email); // 登入成功
    for (let i = 0; i < 4; i++) {
      check(`清後 fail #${i + 1} 唔觸發 lock（重計）`, await recordLoginFailure(email), false);
    }
    check("清後 4 次失敗未 lock", await isAccountLocked(email), false);
    check("清後第 5 次先 lock", await recordLoginFailure(email), true);
  } finally {
    await redis.del(`loginfail:${key}`, `lockout:${key}`).catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

main().then(() => {
  if (failed > 0) {
    console.error(`LOCKOUT-FAIL: ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("LOCKOUT OK");
}).catch((err) => {
  console.error("LOCKOUT-FAIL: crashed", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
