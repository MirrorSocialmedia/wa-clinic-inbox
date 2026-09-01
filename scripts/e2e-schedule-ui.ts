/**
 * e2e-schedule-ui — cwi-sched-20260901 T-C 瀏覽器級斷言（T151/T152/T156）。
 *
 * T151 揀診所 → 真 fetch（network 斷言）+ URL 同步（§5 防回歸；週 + 日兩 granularity 都過）
 * T152 撳日格 → 日視圖 + 醫生 chips + 48 格 + 四態文案（含 mock held flag → 已佔）
 * T156 更新掣：週視圖刷 7 日 / 日視圖刷 1 日（request body 斷言）+ 429 / 409 UI（mock flag）
 *
 * 用法（repo root，dev server 3100 已起 + cookie 有效）：
 *   pnpm e2e:schedule-ui --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-admin.txt
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   SCHED-T151-OK / SCHED-T151-FAIL: <reason>
 *   SCHED-T152-OK / SCHED-T152-FAIL: <reason>
 *   SCHED-T156-OK / SCHED-T156-FAIL: <reason>
 *   SCHED-UI-OK / SCHED-UI-FAIL: <summary>（全部過先 OK）
 *
 * 前置：T152 需要 .dev/workforce-mock-held.json 有 TKW 今日 10:00–11:00 的
 *   mock-pract-TKW-0 HELD（mock-e2e.sh 段內寫好先跑呢個 script）。
 * Override flags（workforce mock）：.dev/workforce-mock-refresh-429.json / -409.json。
 */
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// host 全局 playwright-core（repo 唔帶依賴）— 同 e2e-duty-refresh.ts 同一 pattern
/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

const FLAG_429 = path.join(REPO_ROOT, ".dev", "workforce-mock-refresh-429.json");
const FLAG_409 = path.join(REPO_ROOT, ".dev", "workforce-mock-refresh-409.json");

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

/** 窄化（只用呢度用到嘅方法） */
interface P {
  [k: string]: unknown;
}
interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  selectOption: (sel: string, v: string) => Promise<void>;
  getByRole: (role: string, o?: Record<string, unknown>) => P;
  getByTitle: (re: RegExp) => P;
  getByText: (t: string | RegExp) => P;
  textContent: (sel: string) => Promise<string | null>;
  url: () => string;
  on: (ev: string, cb: (r: { url: () => string; resourceType?: () => string; postData?: () => string }) => void) => void;
  close: () => Promise<void>;
}
interface LocatorLike {
  first: () => LocatorLike;
  nth: (i: number) => LocatorLike;
  count: () => Promise<number>;
  click: (o?: Record<string, unknown>) => Promise<void>;
}
const L = (x: unknown): LocatorLike => x as unknown as LocatorLike;

const results: string[] = [];
function ok(name: string): void {
  console.log(`${name}-OK`);
  results.push(name);
}
function fail(name: string, reason: string): void {
  console.log(`${name}-FAIL: ${reason}`);
  results.push(`${name}-FAIL`);
}

async function main(): Promise<void> {
  const base = arg("--base").replace(/\/$/, "");
  const cookieFile = arg("--cookie");

  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  const sessionValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  if (!sessionValue) throw new Error("cookie 檔搵唔到 wa_inbox_session");

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });

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

  const slotFetches: string[] = [];
  const refreshPosts: string[] = [];
  let body = "";
  P.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/flows/slots")) slotFetches.push(u);
    if (u.includes("/api/availability/refresh") && r.postData) refreshPosts.push(r.postData());
  });

  // ══ T151：揀診所 → 真 fetch + URL 同步（週 + 日 granularity）════════════
  // dev lazy-compile / loadManifest flake 防抖：URL/fetch 用 poll（≤20s）代替固定 4s；
  // URL 未同步先重試一次（selectOption 重揀 — router.replace 重發），仍未同步先 FAIL。
  // §5 語義不變：URL 必同步 + 必真 fetch（只鬆綁 timing 預算）。
  const poll = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await P.waitForTimeout(300);
    }
    return pred();
  };

  // ══ WARMUP：cold dev（e2e [2/9] rm -rf .next + E0 重啟）第一個 RSC navigation
  //   會極慢／撞 loadManifest 500（navigation 死咗 URL 永遠唔 commit）— 用犧牲 clinic
  //   切換暖晒 RSC 管線（≤3 輪 × 30s）先跑真斷言。warm 時 ~2s，唔影響斷言嚴格度。
  try {
    await P.goto(`${base}/schedule?clinic=TKW`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(8000); // SSR + hydration（cold 要耐啲）
    for (let attempt = 1; attempt <= 3; attempt++) {
      await P.selectOption('select[aria-label="診所"]', "WTC");
      if (await poll(() => P.url().includes("clinic=WTC"), 30000)) break;
      if (attempt < 3) console.log(`WARMUP retry ${attempt}（RSC 未落定）`);
    }
  } catch (e) {
    console.log(`WARMUP-WARN: ${String(e).slice(0, 120)}`); // 暖唔到都得 — 真斷言自己有 retry
  }

  try {
    await P.goto(`${base}/schedule?clinic=TKW`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(6000); // SSR + 首次 client refetch 落定
    let body = (await P.textContent("body")) ?? "";
    if (!body.includes("mock 陳醫師")) throw new Error("週視圖未載入（mock 陳醫師 冇）");

    let n = slotFetches.length;
    await P.selectOption('select[aria-label="診所"]', "MF");
    if (!(await poll(() => P.url().includes("clinic=MF"), 20000))) {
      await P.selectOption('select[aria-label="診所"]', "MF"); // retry（dev flake / 慢 compile）
    }
    if (!P.url().includes("clinic=MF")) throw new Error(`URL 唔同步（20s×2）：${P.url()}`);
    if (!(await poll(() => slotFetches.slice(n).some((u) => u.includes("clinicCode=MF") && u.includes("granularity=week")), 10000)))
      throw new Error("換店（週）冇真 fetch clinicCode=MF");
    n = slotFetches.length;

    // 日視圖再換返（granularity=day 都要真 fetch）
    await L(P.getByTitle(/睇 \d{4}-\d{2}-\d{2} 日視圖/)).first().click();
    if (!(await poll(() => P.url().includes("view=day"), 20000)))
      throw new Error(`日格→日視圖 URL 錯（20s）：${P.url()}`);
    await P.waitForTimeout(6000); // 新 document hydration（full navigation 後）
    await P.selectOption('select[aria-label="診所"]', "TKW");
    if (!(await poll(() => P.url().includes("clinic=TKW"), 20000))) {
      await P.selectOption('select[aria-label="診所"]', "TKW"); // retry（dev flake / 慢 compile）
    }
    if (!P.url().includes("clinic=TKW")) throw new Error(`URL 唔同步（20s×2）：${P.url()}`);
    if (!(await poll(() => slotFetches.slice(n).some((u) => u.includes("clinicCode=TKW") && u.includes("granularity=day")), 10000)))
      throw new Error("換店（日）冇真 fetch clinicCode=TKW");
    ok("SCHED-T151");
  } catch (e) {
    fail("SCHED-T151", String(e).slice(0, 160));
  }

  // ══ T152：日格→日視圖 + chips + 48 格 + 四態（held flag → 已佔）═════════
  try {
    // a2：T151 成功時留低 clinic=TKW&view=day（select onChange 唔帶 date）— 原條件
    //   只睇 view=day 會跳過 goto → 無 date → 假紅。兩 param 都要先跳過。
    if (!P.url().includes("view=day") || !P.url().includes(`date=${today}`)) {
      await P.goto(`${base}/schedule?clinic=TKW&view=day&date=${today}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await P.waitForTimeout(5000);
    }
    body = (await P.textContent("body")) ?? "";
    if (!P.url().includes("view=day") || !P.url().includes(`date=${today}`)) throw new Error(`URL 錯：${P.url()}`);
    const chipCount = await L(P.getByRole("link", { name: /mock .醫師/ })).count();
    if (chipCount < 2) throw new Error(`chips 不夠（${chipCount}）`);
    if (!body.includes("09:00") || !body.includes("23:30")) throw new Error("48 格唔齊（09:00/23:30 缺失）");
    if (!body.includes("可上線約")) throw new Error("四態：可上線約 缺失");
    if (!body.includes("唔開診・滿")) throw new Error("四態：唔開診・滿 缺失");
    if (!body.includes("已佔")) throw new Error("四態：已佔 缺失（held flag 未生效？）");
    ok("SCHED-T152");
  } catch (e) {
    fail("SCHED-T152", String(e).slice(0, 160));
  }

  // ══ T156：更新掣 7 日/1 日 + 429/409 UI ═════════════════════════════════
  try {
    // 週視圖刷 7 日
    await P.goto(`${base}/schedule?clinic=TKW`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(5000);
    let n = refreshPosts.length;
    await L(P.getByRole("button", { name: /更新/ })).first().click();
    await P.waitForTimeout(3000);
    const weekPost = refreshPosts.slice(n).pop() ?? "";
    const weekDates = (JSON.parse(weekPost || "{}") as { dates?: string[] }).dates ?? [];
    if (weekDates.length !== 7) throw new Error(`週視圖刷新 dates=${weekDates.length}（要 7）`);

    // 日視圖刷 1 日
    await P.goto(`${base}/schedule?clinic=TKW&view=day&date=${today}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(5000);
    n = refreshPosts.length;
    await L(P.getByRole("button", { name: /更新/ })).first().click();
    await P.waitForTimeout(3000);
    const dayPost = refreshPosts.slice(n).pop() ?? "";
    const dayDates = (JSON.parse(dayPost || "{}") as { dates?: string[] }).dates ?? [];
    if (dayDates.length !== 1) throw new Error(`日視圖刷新 dates=${dayDates.length}（要 1）`);

    // 429 UI（mock flag → retryAfterSec=37）
    writeFileSync(FLAG_429, JSON.stringify({ clinicCode: "TKW" }), "utf8");
    try {
      await L(P.getByRole("button", { name: /更新|同步中/ })).first().click();
      // toast 8s 自動消失 — 7s poll（300ms tick）代替固定 2.5s（dev 慢回應防抖）
      let seen = false;
      const tToast = Date.now();
      while (Date.now() - tToast < 7000) {
        body = (await P.textContent("body")) ?? "";
        if (body.includes("啱啱先同步過")) { seen = true; break; }
        await P.waitForTimeout(300);
      }
      if (!seen) throw new Error("429 toast 缺失（啱啱先同步過）");
    } finally {
      rmSync(FLAG_429, { force: true });
    }

    // 409 UI（mock flag → APRICOT_BUSY）
    writeFileSync(FLAG_409, JSON.stringify({ clinicCode: "TKW" }), "utf8");
    try {
      await P.waitForTimeout(40000); // 等 429 倒數（disableSec）落返 — 429 後按鈕 disable 37s
      await L(P.getByRole("button", { name: /更新/ })).first().click();
      // 同上：7s poll（toast 8s 消失窗內）
      let seen409 = false;
      const tToast2 = Date.now();
      while (Date.now() - tToast2 < 7000) {
        body = (await P.textContent("body")) ?? "";
        if (body.includes("Apricot 忙緊")) { seen409 = true; break; }
        await P.waitForTimeout(300);
      }
      if (!seen409) throw new Error("409 toast 缺失（Apricot 忙緊）");
    } finally {
      rmSync(FLAG_409, { force: true });
    }
    ok("SCHED-T156");
  } catch (e) {
    fail("SCHED-T156", String(e).slice(0, 160));
  }

  await P.close();
  await ctx.close();
  await browser.close();

  // a2：ok() push 緊 name（無 -OK 尾）— 原 every(endsWith("-OK")) 永遠 false →
  //   SCHED-UI-OK 永遠唔出（只係 mock-e2e.sh 個 per-test grep 先救到）。
  const allOk = results.length > 0 && results.every((r) => !r.endsWith("-FAIL"));
  console.log(allOk ? "SCHED-UI-OK" : `SCHED-UI-FAIL: ${results.filter((r) => r.endsWith("-FAIL")).join(", ")}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.log(`SCHED-UI-FAIL: ${String(e).slice(0, 200)}`);
  process.exit(1);
});
