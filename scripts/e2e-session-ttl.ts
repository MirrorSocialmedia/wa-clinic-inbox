/**
 * e2e helper：M-4 session TTL 單元斷言（hermetic — monkey-patch Date.now，唔靠真時間漂）。
 *
 * 用法：pnpm e2e:session-ttl
 * - STAFF 24h：23h59m fresh / 24h01m expired
 * - ADMIN 12h：11h59m fresh / 12h01m expired（高權限 session 先過期）
 * - ADMIN 20h → expired（唔會錯用 STAFF 24h 窗口）
 * - loginAt 唔係有效 number → fail-closed expired
 * 全過 → 打 "SESSION-TTL OK"。
 */
import { isSessionFresh } from "../src/lib/session";

const realNow = Date.now;
const H = 3600 * 1000;
let failures = 0;

function t(label: string, actual: boolean, expected: boolean): void {
  if (actual !== expected) {
    console.error(`  ❌ ${label}: expected=${expected} actual=${actual}`);
    failures += 1;
  }
}

try {
  const T = 1_800_000_000_000; // 固定參考時間（任意值 — 只需邊界計算）
  Date.now = () => T;

  // STAFF（24h）
  t("STAFF 1s（fresh）", isSessionFresh({ role: "STAFF", loginAt: T - 1000 }), true);
  t("STAFF 23h59m（fresh）", isSessionFresh({ role: "STAFF", loginAt: T - (24 * H - 60_000) }), true);
  t("STAFF 24h01m（expired）", isSessionFresh({ role: "STAFF", loginAt: T - (24 * H + 60_000) }), false);
  // ADMIN（12h）
  t("ADMIN 1s（fresh）", isSessionFresh({ role: "ADMIN", loginAt: T - 1000 }), true);
  t("ADMIN 11h59m（fresh）", isSessionFresh({ role: "ADMIN", loginAt: T - (12 * H - 60_000) }), true);
  t("ADMIN 12h01m（expired）", isSessionFresh({ role: "ADMIN", loginAt: T - (12 * H + 60_000) }), false);
  t("ADMIN 20h（expired — 用 12h 唔係 24h 窗口）", isSessionFresh({ role: "ADMIN", loginAt: T - 20 * H }), false);
  // fail-closed
  t("loginAt 唔係有效 number（fail-closed）", isSessionFresh({ role: "STAFF", loginAt: Number.NaN }), false);
} finally {
  Date.now = realNow;
}

if (failures > 0) {
  process.exit(1);
}
console.log("SESSION-TTL OK");
