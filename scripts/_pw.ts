// scripts/_pw.ts（新檔）
/** ★ cwi-final F-5：playwright-core 單一入口 — PW_CORE 可覆蓋（CI 用 devDependency） */
/* eslint-disable @typescript-eslint/no-require-imports */
const PW_PATH = process.env.PW_CORE ?? "/usr/lib/node_modules/openclaw/node_modules/playwright-core";
export const { chromium } = require(PW_PATH) as { chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> } };
