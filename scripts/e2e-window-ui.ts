/**
 * e2e-window-ui — cwi-window-20260901 T172/T173 瀏覽器級斷言（過窗三出路 UI）。
 *
 * 前置：過窗對話（lastInboundAt > 24h）+（T172）COPY_ONLY 草稿（wa.me link 帶編碼草稿）。
 * 斷言（MD §1 W-1）：
 *   1. 三出路 block 標題「24 小時窗口已過 — 揀一個方式跟進」+ ③ 文字
 *   2. ① wa.me anchor：E164 無加號；--draft 提供時 href 必含 ?text=encodeURIComponent(draft)
 *   3. ① 細字「只適用於主動搵過我哋嘅病人」
 *   4. ② picker：select 存在 + ≥1 option + 「發送（逐條收費）」掣 + 預填行（--expect-prefill 1/0）
 *
 * 用法（repo root，dev server 3100 已起 + cookie 有效）：
 *   pnpm e2e:window-ui --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-tkw.txt \
 *     --conv <conversationId> [--draft <草稿文字>] [--expect-prefill 1]
 *
 * 輸出（mock-e2e.sh grep 用）：WINDOW-UI-OK / WINDOW-UI-FAIL: <reason>
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
  count: () => Promise<number>;
  first: () => LocatorLike;
  last: () => LocatorLike;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
  getAttribute: (n: string) => Promise<string | null>;
  textContent: () => Promise<string | null>;
  allTextContents: () => Promise<string[]>;
  nth: (i: number) => LocatorLike;
  locator: (sel: string) => LocatorLike;
}
interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (role: string, o?: Record<string, unknown>) => LocatorLike;
  locator: (sel: string) => LocatorLike;
  close: () => Promise<void>;
}

async function main(): Promise<void> {
  const base = req("--base").replace(/\/$/, "");
  const cookieFile = req("--cookie");
  const conv = req("--conv");
  const draft = arg("--draft");
  const expectPrefill = arg("--expect-prefill") === "1";

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
  await ctx.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();

  try {
    await P.goto(`${base}/inbox?conv=${conv}`, { waitUntil: "domcontentloaded" });

    // 1. 三出路 block 標題
    await P.getByText("24 小時窗口已過 — 揀一個方式跟進").first().waitFor({ timeout: 20000 });
    // ③ 等病人
    await P.getByText("等病人下次搵你（窗口會重開）").first().waitFor({ timeout: 5000 });

    // 2. ① wa.me anchor（E164 無加號 + 編碼草稿）
    // a2 fix：?text= 要等 pendingDraft（/drafts fetch）落定先出現 — 首個 href 可能冇 ?text=
    //   （r2 實測：即刻讀 = 假紅「未正確編碼」）。poll 到期望 suffix 先斷言。
    const wa = P.locator('a[href^="https://wa.me/"]');
    await wa.first().waitFor({ timeout: 20000 });
    const expectedSuffix = draft ? `?text=${encodeURIComponent(draft)}` : null;
    let href = (await wa.first().getAttribute("href")) ?? "";
    if (expectedSuffix) {
      const deadline = Date.now() + 20000;
      while (!href.endsWith(expectedSuffix) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        href = (await wa.first().getAttribute("href")) ?? "";
      }
    }
    const pathPart = href.split("?")[0].replace("https://wa.me/", "");
    if (!/^[0-9]+$/.test(pathPart)) throw new Error(`wa.me path 有非數字（加號？）: ${pathPart}`);
    if (expectedSuffix && !href.endsWith(expectedSuffix)) {
      throw new Error(`wa.me text 未正確編碼：href=${href.slice(0, 120)}`);
    }
    // ① 細字
    await P.getByText("只適用於主動搵過我哋嘅病人").first().waitFor({ timeout: 5000 });

    // 4. ② picker（select + 發送掣 + 預填行）
    // a2 fix：combobox.first() 可能命到頭部 assignee select（先存在）→ picker 未載入就數發送掣 = 假紅；
    //   改以 aria-label「揀 template」直命 picker select（佢本身要等 /templates fetch 先出現）
    const sel = P.getByRole("combobox", { name: /揀 template/ });
    await sel.waitFor({ timeout: 20000 });
    const optCount = await sel.locator("option").count();
    if (optCount < 1) throw new Error("picker select 零 option");
    const sendBtn = P.getByRole("button", { name: /發送（逐條收費）/ });
    if ((await sendBtn.count()) !== 1) throw new Error(`發送掣 count=${await sendBtn.count()}（expected 1）`);
    if (expectPrefill) {
      await P.getByText("變數已填好：").first().waitFor({ timeout: 5000 });
    } else {
      await P.getByText("冇 CONFIRMED 預約").first().waitFor({ timeout: 5000 });
    }

    console.log("WINDOW-UI-OK");
  } catch (e) {
    console.log(`WINDOW-UI-FAIL: ${String(e).slice(0, 200)}`);
    process.exitCode = 1;
  } finally {
    await P.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

void main();
