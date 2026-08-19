/**
 * e2e helper：由 secret 計算 TOTP code（跟 server 同一算法 — src/lib/totp.ts）。
 *
 * 用法：pnpm e2e:totp-code <secret> [timeMs]
 * - timeMs 預設 Date.now()（同一部機計算 → verify 時差 <1s，必然喺 ±1 window 內）
 * - 傳固定/偏移時間 → 可構造「過期」code（e.g. +90s = 3 個 period 之外 → 一定錯）
 *
 * 呢個 helper 係 test-only 工具；production 唔會用。
 */
import { totpCode } from "../src/lib/totp";

const [secret, timeArg] = process.argv.slice(2);
if (!secret) {
  console.error("usage: totp-code <secret> [timeMs]");
  process.exit(2);
}
const t = timeArg ? Number(timeArg) : Date.now();
if (!Number.isFinite(t)) {
  console.error("invalid timeMs");
  process.exit(2);
}
console.log(totpCode(secret, t));
