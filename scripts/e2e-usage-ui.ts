/**
 * e2e-usage-ui — cwi-window-20260901 T176 瀏覽器級斷言（/admin/usage 頁）。
 *
 * 背景：§5 決策表 + 數據表都係 client component 載入後先 render（SSR 只有「載入中…」）
 *   → curl grep HTML 斷唔到（假紅源）— 呢個 script 係真實瀏覽器級驗證。
 * 斷言（MD W-4）：
 *   1. 無 redirect（未登入/admin 以外 → 應跳走；ADMIN → 留喺 /admin/usage）
 *   2. 「用量統計」header 出現
 *   3. 數據載入完成（「載入中…」消失 + 估算提示行出現）
 *   4. §5 決策表 render
 *
 * 用法（repo root，dev server 3100 已起 + ADMIN cookie）：
 *   pnpm e2e:usage-ui --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-admin.txt
 *
 * 輸出（mock-e2e.sh grep 用）：USAGE-UI-OK / USAGE-UI-FAIL: <reason>
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? "") : "";
}
function req(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

function findChromium(): string {
  const base = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = path.join(base, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到（~/.cache/ms-playwright）");
}

interface LocatorLike {
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
  count: () => Promise<number>;
  first: () => LocatorLike;
}
interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  close: () => Promise<void>;
}
interface ContextLike {
  addCookies: (c: unknown[]) => Promise<void>;
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
}

async function main(): Promise<void> {
  const base = req("--base");
  const cookieFile = req("--cookie");
  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  const sessionValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  if (!sessionValue) throw new Error("cookie file 無 wa_inbox_session");

  const browser = await (chromium.launch({ headless: true, executablePath: findChromium() }) as Promise<{
    newContext: (o?: Record<string, unknown>) => Promise<ContextLike>;
    close: () => Promise<void>;
  }>);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();

  try {
    await P.goto(`${base}/admin/usage`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = P.url();
    if (!url.includes("/admin/usage")) {
      throw new Error(`redirect 離咗 /admin/usage（actual url=${url}）`);
    }
    // 2. header
    await P.getByText("用量統計", { exact: false }).first().waitFor({ timeout: 20000 });
    // 3. 數據載入完成（client fetch → 估算提示行；「載入中…」應該走晒）
    await P.getByText("留空 = 唔估算", { exact: false }).first().waitFor({ timeout: 20000 });
    const loadingLeft = await P.getByText("載入中…").count();
    if (loadingLeft > 0) throw new Error(`「載入中…」仍然在（count=${loadingLeft}）`);
    // 4. §5 決策表
    await P.getByText("§5 決策表", { exact: false }).first().waitFor({ timeout: 10000 });
    console.log("USAGE-UI-OK");
  } finally {
    await P.close();
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.log(`USAGE-UI-FAIL: ${String(e?.message ?? e)}`);
  process.exit(1);
});
