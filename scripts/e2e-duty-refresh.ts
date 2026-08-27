/**
 * e2e-duty-refresh — §B2 今日當值卡 client 端刷新（cwi-r1close-20260827）。
 *
 * Browser-level（playwright-core headless）：SSR 快照（fixture A）→ flag 換名單（B）→
 * 換對話再換返（唔 reload）→ 卡必須顯示 B（client useEffect fetch /api/duty-roster 生效）。
 *
 * 用法（repo root，server 必須已起 + cookie 有效）：
 *   tsx scripts/e2e-duty-refresh.ts --base http://127.0.0.1:3100 \
 *     --cookie /tmp/e2e-cookie-tkw.txt --conv1 <convId> --conv2 <convId>
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   DUTY-REFRESH-OK / DUTY-REFRESH-FAIL: <reason>
 *
 * 註：conv1/conv2 必須係同一 staff（STAFF）scope 內、同一 clinic（TKW）嘅對話 —
 *   兩患者嘅 profileName 必須含「E2E-DUTY-A」/「E2E-DUTY-B」（click selector 用）。
 * Override flag = .dev/duty-mock-override.json（duty/client.ts mock 分支讀；DUTY_MOCK=1 only）。
 */
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FLAG_PATH = path.join(REPO_ROOT, ".dev", "duty-mock-override.json");

// host 全局 playwright-core（repo 唔帶 — 避免新增依賴）— 絕對路徑 require；
// tsc 無法解析非 repo 模組嘅型別 → 窄化 cast。呢部 sandbox 定點路径。
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

// 註：--conv2 可以傳（文檔一致性）但 script 唔用 — 對話項用患者名 click（見下）

/** 搵最新 chromium binary（~/.cache/ms-playwright 下 chromium-NNN/chrome-linux64/chrome）。 */
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
      /* try next */
    }
  }
  throw new Error("chromium binary 搵唔到（~/.cache/ms-playwright）");
}

const OVERLAP_STAFF = [
  { staffName: "陳志強", role: "醫生", shiftStart: "08:00", shiftEnd: "16:00" },
  { staffName: "吳雅婷", role: "護士", shiftStart: "12:00", shiftEnd: "20:00" },
];

/** 窄化 playwright Page 型別（repo 唔帶 playwright 依賴 — 只用呢度用到嘅方法）。 */
interface PageLite {
  goto: (url: string, o?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForSelector: (sel: string, o?: Record<string, unknown>) => Promise<unknown>;
  waitForFunction: (fn: string | ((...a: unknown[]) => unknown), o?: Record<string, unknown>) => Promise<unknown>;
  getByText: (t: string, o?: Record<string, unknown>) => { first: () => { count: () => Promise<number>; click: (o?: Record<string, unknown>) => Promise<void> } };
  on: (ev: string, cb: (r: { url: () => string; ok: () => boolean }) => void) => void;
  url: () => string;
  evaluate: (fn: () => unknown) => Promise<unknown>;
  close: () => Promise<void>;
}

async function main(): Promise<void> {
  const base = arg("--base").replace(/\/$/, "");
  const cookieFile = arg("--cookie");
  const conv1 = arg("--conv1");
  // （--conv2 傳入即忽略 — 對話項用患者名 click）

  // cookie jar（curl 格式：... wa_inbox_session <value>）
  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  const sessionValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  if (!sessionValue) throw new Error("cookie 檔搵唔到 wa_inbox_session");

  // hermetic：清舊 flag
  rmSync(FLAG_PATH, { force: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
  }) as unknown as {
    newContext: (o: Record<string, unknown>) => Promise<{
      newPage: () => Promise<PageLite>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, // ≥lg → 桌面三欄（detail pane 常駐）
  });
  // ★ addCookies（唔係 newContext({cookies}) — 實測後者喺呢個 playwright-core build 下 cookie 未送到 server）
  await (ctx as unknown as { addCookies: (c: unknown[]) => Promise<void> }).addCookies([
    {
      name: "wa_inbox_session",
      value: sessionValue,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const P = await ctx.newPage();

  let dutyCalls = 0;
  P.on("response", (r) => {
    if (r.url().includes("/api/duty-roster") && r.ok()) dutyCalls++;
  });

  // ── 1) 載入 /inbox?conv=conv1 → SSR 快照應顯示 fixture A（林小曼） ─────────
  await P.goto(`${base}/inbox?conv=${conv1}`, { waitUntil: "domcontentloaded" });
  await P.waitForSelector("text=今日當值", { timeout: 30000 });
  const hasA = await P.getByText("林小曼").first().count();
  if (hasA === 0) throw new Error("初始卡冇顯示 fixture A（林小曼）— SSR initialDuty 未生效？");
  const callsAfterLoad = dutyCalls;
  // client mount 會發一次 /api/duty-roster（refreshDuty effect）— 等佢落定
  await P.waitForTimeout(1500);

  // ── 2) flag 換名單 B → 換對話 conv2 → 換返 conv1（唔 reload）→ 卡必須係 B ──
  writeFileSync(FLAG_PATH, JSON.stringify({ staff: OVERLAP_STAFF }), "utf8");
  await P.getByText("E2E-DUTY-B", { exact: true }).first().click();
  await P.waitForTimeout(800);
  await P.getByText("E2E-DUTY-A", { exact: true }).first().click();

  try {
    await P.waitForFunction(
      () => document.body.innerText.includes("陳志強") && !document.body.innerText.includes("林小曼"),
      { timeout: 30000 }
    );
  } catch {
    // 診斷：dump 當下 url + body 尾（定係 cookie 失効 307 / click 未中 / fetch 未發）
    const dbg = (await P.evaluate(() => ({
      url: location.href,
      tail: document.body.innerText.slice(-600),
    }))) as { url: string; tail: string };
    throw new Error(`卡未翻 B（url=${dbg.url}）tail: ${JSON.stringify(dbg.tail.slice(-300))}`);
  }
  if (dutyCalls <= callsAfterLoad) {
    throw new Error(`client 端刷新未發 /api/duty-roster（calls=${dutyCalls}, afterLoad=${callsAfterLoad}）`);
  }
  // 換對話後新卡顯示 B（陳志強）— 已喺 waitForFunction 斷言
  rmSync(FLAG_PATH, { force: true });

  console.log(`DUTY-REFRESH-OK (dutyCalls=${dutyCalls}, afterLoad=${callsAfterLoad})`);
  await P.close();
  await ctx.close();
  await browser.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log(`DUTY-REFRESH-FAIL: ${e instanceof Error ? e.message : String(e)}`);
    rmSync(FLAG_PATH, { force: true });
    process.exit(1);
  });
