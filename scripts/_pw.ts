/**
 * scripts/_pw.ts — playwright-core 單一入口（cwi-final F-5 半成品 → S6-1 完整版）
 *
 * - module 來源：env `PW_CORE`（預設 "playwright-core" = repo devDependency 1.59.1，
 *   同 openclaw 現用版本對齊；F-5 舊口徑可用絕對路徑覆蓋，例如 openclaw global node_modules）
 * - browser 路徑：env `PW_CHROMIUM`（CI 指 system chrome / 自定 binary）；
 *   未設 → 返 undefined → playwright-core 用 registry 預設
 *   （本地要裝咗對應 revision：pnpm exec playwright-core install chromium）
 *
 * 類型註：保持弱結構類型（launch: Record<string, unknown> → Promise<unknown>）—
 * 各 e2e script 會 cast 成自己結構類型（BrowserLike / PwChromium 等）；
 * 弱類型與任何一方都可 cast，22 個 caller 檔案零改動 call-site 類型。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const PW_PATH = process.env.PW_CORE ?? "playwright-core";
const mod = require(PW_PATH) as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

export const chromium = mod.chromium;

/** Browser 可執行路徑：PW_CHROMIUM（CI / 自定）；未設返 undefined（playwright-core registry 預設） */
export function chromiumPath(): string | undefined {
  return process.env.PW_CHROMIUM || undefined;
}
