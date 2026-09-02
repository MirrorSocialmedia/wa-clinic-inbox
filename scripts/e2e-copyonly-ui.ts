/**
 * e2e-copyonly-ui — cwi-window-20260901 T171 瀏覽器級斷言（COPY_ONLY 草稿卡）。
 *
 * 前置：過窗對話已有 AiDraft(mode=COPY_ONLY, status=PROPOSED)（e2e-ai-job old-inbound 觸發）。
 * 斷言（MD §2 W-2）：
 *   1. 草稿卡顯示「AI 草稿（只可複製）」+ banner「24 小時窗口已過 — 呢段字發唔出」
 *   2. 「複製去手機 App」掣存在（取代「採用並編輯」）
 *   3. 「採用並編輯」掣唔存在（COPY_ONLY 發唔出）
 *
 * 用法（repo root，dev server 3100 已起 + cookie 有效）：
 *   pnpm e2e:copyonly-ui --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-tkw.txt --conv <conversationId>
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   COPYONLY-UI-OK / COPYONLY-UI-FAIL: <reason>
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// host 全局 playwright-core（repo 唔帶依賴）— 同 e2e-schedule-ui.ts 同一 pattern
/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : "";
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

interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (role: string, o?: Record<string, unknown>) => LocatorLike;
  close: () => Promise<void>;
}
interface LocatorLike {
  count: () => Promise<number>;
  first: () => LocatorLike;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
}

async function main(): Promise<void> {
  const base = arg("--base").replace(/\/$/, "");
  const cookieFile = arg("--cookie");
  const conv = arg("--conv");

  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  const sessionValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  if (!sessionValue) throw new Error("cookie 檔搵唔到 wa_inbox_session");

  const browser = (await chromium.launch({ headless: true, executablePath: findChromium() })) as unknown as {
    newContext: (o: Record<string, unknown>) => Promise<{
      addCookies: (c: unknown[]) => Promise<void>;
      newPage: () => Promise<PageLike>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // ★ addCookies（唔係 newContext({cookies}) — 實測後者喺呢個 build 下 cookie 未送到 server）
  await ctx.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();

  try {
    await P.goto(`${base}/inbox?conv=${conv}`, { waitUntil: "domcontentloaded" });

    // 1. 草稿卡標題（COPY_ONLY 變體）
    const title = P.getByText("AI 草稿（只可複製）", { exact: true });
    await title.first().waitFor({ timeout: 20000 });

    // 2. banner
    await P.getByText(/24 小時窗口已過 — 呢段字發唔出/).first().waitFor({ timeout: 5000 });

    // 3. 複製掣存在
    const copyBtn = P.getByRole("button", { name: "複製去手機 App" });
    if ((await copyBtn.count()) !== 1) throw new Error(`複製掣 count=${await copyBtn.count()}（expected 1）`);

    // 4. 採用並編輯 掣唔存在
    const adoptBtn = P.getByRole("button", { name: "採用並編輯" });
    if ((await adoptBtn.count()) !== 0) throw new Error(`採用並編輯 掣仲喺度（count=${await adoptBtn.count()}）`);

    console.log("COPYONLY-UI-OK");
  } catch (e) {
    console.log(`COPYONLY-UI-FAIL: ${String(e).slice(0, 160)}`);
    process.exitCode = 1;
  } finally {
    await P.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

void main();
