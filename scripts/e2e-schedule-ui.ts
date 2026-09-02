/**
 * e2e-schedule-ui — cwi-sched-20260901 T-C + cwi-schedv2-20260903 Part D 瀏覽器級斷言。
 *
 * T151 揀診所 → 真 fetch（network 斷言）+ URL 同步（§5 防回歸；週 + 日兩 granularity 都過）
 * T152 撳日格 → 日視圖 + 醫生 chips + 時段格 + 四態文案 + D.1 摺疊行（新契約：
 *       default 只 render 非 CLOSED 格；頭尾「↑/↓ …唔開診·展開」；48 格覆蓋由展開尾段保證）
 * T156 更新掣：週視圖刷 7 日 / 日視圖刷 1 日（request body 斷言）+ 429 / 409 UI（mock flag）
 *
 * D（cwi-schedv2-20260903）：
 * T180 今日：auto-scroll 而家行 + past 淡化(opacity .45) + 而家線（— 而家 / 2px brand）
 *       + 摺疊行 round-trip + 60s tick（playwright clock 凍結今日 10:59 HK，runFor 121s）
 * T181 非今日：冇而家線 / 冇淡化
 * T182 capacity fallback warn（server log：每 process 每 clinic|date|provider 一次）
 * T183 日視圖 popover：搜病人（既有對話）→ 發預約連結（Flow · 已鎖定呢格）
 *       → POST body prefill + ok:true + DB Message body 含 flow_action_payload.data
 * T184 側欄迷你表：撳格 confirm 一次即發（跳過揀病人）→ POST body prefill + ok:true
 * T185 過窗改三出路：日視圖 popover + 側欄迷你表（25h 前 lastInboundAt）
 * T186 迷你表：>3 醫生橫捲（extra-providers flag）+ ≤10 行
 * T187 = 本 script T151+T152+T156 全迴歸（+ mock-e2e.sh curl T150/T153/T154/T155）
 *
 * 用法（repo root，dev server 3100 已起 + cookie 有效）：
 *   pnpm e2e:schedule-ui --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-admin.txt [--log /tmp/e2e-server.log]
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   SCHED-T151-OK / SCHED-T151-FAIL: <reason>
 *   SCHED-T152-OK / SCHED-T152-FAIL: <reason>
 *   SCHED-T156-OK / SCHED-T156-FAIL: <reason>
 *   SCHED-T180..T186-OK / -FAIL: <reason>
 *   SCHED-UI-OK / SCHED-UI-FAIL: <summary>（全部過先 OK）
 *
 * 前置：T152 需要 .dev/workforce-mock-held.json 有 TKW 今日 10:00–11:00 的
 *   mock-pract-TKW-0 HELD（mock-e2e.sh 段內寫好先跑呢個 script；獨立跑要自己寫）。
 * Override flags（workforce mock）：.dev/workforce-mock-refresh-429.json / -409.json /
 *   -extra-providers.json。
 */
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
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
const FLAG_EXTRA = path.join(REPO_ROOT, ".dev", "workforce-mock-extra-providers.json");

// T183–T185 對話 fixture（WA id 範圍專用 e2e，零真 PII）
const WA_PREFILL = "85290018301";
const WA_MINI = "85290018302";
const WA_OLDWIN = "85290018303";
const WA_WIDE = "85290018304";

function arg(name: string, dflt = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
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
  fill: (sel: string, v: string) => Promise<void>;
  textContent: (sel: string) => Promise<string | null>;
  url: () => string;
  on: (ev: string, cb: (r: any) => void) => void;
  evaluate: <T>(fn: (arg?: unknown) => T, arg?: unknown) => Promise<T>;
  close: () => Promise<void>;
  // T180 clock 凍結（playwright ≥1.45）— pauseAt = 凍喺起點（install 會繼續 real-time 走）
  clock?: {
    install: (o: { time: Date; timeZone?: string }) => Promise<void>;
    pauseAt: (t: Date) => Promise<void>;
    runFor: (ms: number) => Promise<void>;
  };
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

// ── T183–T185 DB / webhook fixture helpers ───────────────────────────────
// .env → DATABASE_URL（timestamptz 欄用原生 timestamptz 運算，避 naive-tz 陷阱）
let DATABASE_URL = "";
try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env"));
  DATABASE_URL = process.env.DATABASE_URL ?? "";
} catch {
  /* .env 缺 → DB 斷言會 fail（明確報錯） */
}

function psql(sql: string): string {
  if (!DATABASE_URL) throw new Error("DATABASE_URL 缺（.env）— DB 斷言無法行");
  return execSync(`psql "${DATABASE_URL}" -tA -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function mockInbound(waId: string, name: string): void {
  execSync(`pnpm -s mock-inbound message --clinic TKW --from ${waId} --text "e2e schedv2" --name "${name}"`, {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
}

function convIdByWa(waId: string): string {
  const id = psql(
    `SELECT id FROM "Conversation" WHERE "contactId" = (SELECT id FROM "Contact" WHERE "waId" = '${waId}') LIMIT 1;`
  );
  if (!id) throw new Error(`conversation 未建（waId ${waId}）`);
  return id;
}

/** cleanup：waId sweep（worker 自建殘留都洗到 — FlowSession → Message → Conversation → Contact） */
function cleanupWa(waId: string): void {
  const sub = `(SELECT id FROM "Contact" WHERE "waId" = '${waId}')`;
  const convs = `(SELECT id FROM "Conversation" WHERE "contactId" IN ${sub})`;
  psql(`
    DELETE FROM "FlowSession" WHERE "conversationId" IN ${convs};
    DELETE FROM "Message" WHERE "conversationId" IN ${convs};
    DELETE FROM "Conversation" WHERE "contactId" IN ${sub};
    DELETE FROM "Contact" WHERE "waId" = '${waId}';
  `);
}

/** 25h 前 lastInboundAt（timestamptz — 原生運算，唔經 session tz） */
function ageConvToPast(waId: string, hours: number): void {
  psql(
    `UPDATE "Conversation" SET "lastInboundAt" = now() - interval '${hours} hours'
     WHERE "contactId" = (SELECT id FROM "Contact" WHERE "waId" = '${waId}');`
  );
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const base = arg("--base", "http://127.0.0.1:3100").replace(/\/$/, "");
  const cookieFile = arg("--cookie");
  if (!cookieFile) {
    console.error("missing --cookie");
    process.exit(2);
  }
  // T182 server log（獨立跑 = /tmp/w-dev-3100.log；mock-e2e.sh 整合跑 = /tmp/e2e-server.log）
  const logCandidates = [arg("--log"), "/tmp/e2e-server.log", "/tmp/w-dev-3100.log"].filter(Boolean) as string[];
  const logPath = logCandidates.find((p) => existsSync(p)) ?? logCandidates[0];

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

  const poll = async (pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return true;
      await P.waitForTimeout(300);
    }
    return await pred();
  };

  const slotFetches: string[] = [];
  const refreshPosts: string[] = [];
  // D.3：Flow POST 捕獲（T183/T184 prefill 斷言）
  const flowsReqs: { url: string; body: string }[] = [];
  const flowsResps: { status: number; body: string }[] = [];
  const flowsRe = /\/api\/conversations\/[^/]+\/flows$/;
  P.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/flows/slots")) slotFetches.push(u);
    if (u.includes("/api/availability/refresh") && r.postData) refreshPosts.push(r.postData());
    if (flowsRe.test(u) && r.postData) flowsReqs.push({ url: u, body: r.postData() });
  });
  P.on("response", (resp) => {
    if (flowsRe.test(resp.url()) && resp.request().method() === "POST") {
      resp
        .text()
        .then((t: string) => flowsResps.push({ status: resp.status(), body: t }))
        .catch(() => {});
    }
  });

  // ══ WARMUP：cold dev 第一個 RSC navigation 會極慢／撞 loadManifest 500 — 用犧牲 clinic
  //   切換暖晒 RSC 管線（≤3 輪 × 30s）先跑真斷言。（同時觸發 T182 capacity warn）══
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

  // ══ T151：揀診所 → 真 fetch + URL 同步（週 + 日 granularity）════════════
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

  // ══ T152：日格→日視圖 + chips + 時段格 + 四態 + D.1 摺疊行（新契約）═══════
  try {
    if (!P.url().includes("view=day") || !P.url().includes(`date=${today}`)) {
      await P.goto(`${base}/schedule?clinic=TKW&view=day&date=${today}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await P.waitForTimeout(5000);
    }
    let body = (await P.textContent("body")) ?? "";
    if (!P.url().includes("view=day") || !P.url().includes(`date=${today}`)) throw new Error(`URL 錯：${P.url()}`);
    const chipCount = await L(P.getByRole("link", { name: /mock .醫師/ })).count();
    if (chipCount < 2) throw new Error(`chips 不夠（${chipCount}）`);
    if (!body.includes("09:00")) throw new Error("時段格：09:00 缺失");
    // D.1 新契約：default 唔 render 全 48 格 — 頭尾 CLOSED 段摺一行（mock：09:00 起 / 13:00 止）
    if (!body.includes("↑ 09:00 之前（唔開診）· 展開")) throw new Error("D.1 頭摺行缺失（↑ 09:00 之前）");
    if (!body.includes("↓ 13:00 之後（唔開診）· 展開")) throw new Error("D.1 尾摺行缺失（↓ 13:00 之後）");
    if (body.includes("23:30")) throw new Error("D.1 違約：23:30 行 default 出現（應該摺埋）");
    if (!body.includes("可上線約")) throw new Error("四態：可上線約 缺失");
    if (!body.includes("唔開診・滿")) throw new Error("四態：唔開診・滿 缺失（圖例）");
    if (!body.includes("已佔")) throw new Error("四態：已佔 缺失（held flag 未生效？）");
    // 展開尾段 → 48 格覆蓋（23:30 出現）→ 再收埋
    await L(P.getByText("↓ 13:00 之後（唔開診）· 展開")).first().click();
    await P.waitForTimeout(500);
    body = (await P.textContent("body")) ?? "";
    if (!body.includes("23:30")) throw new Error("展開尾段後 23:30 缺失（48 格覆蓋）");
    if (!body.includes("收埋")) throw new Error("展開後 label 未變「收埋」");
    await L(P.getByText("↓ 13:00 之後（唔開診）· 收埋")).first().click();
    await P.waitForTimeout(500);
    body = (await P.textContent("body")) ?? "";
    if (body.includes("23:30")) throw new Error("收埋後 23:30 仍出現");
    ok("SCHED-T152");
  } catch (e) {
    fail("SCHED-T152", String(e).slice(0, 160));
  }

  // ══ T180：今日 auto-scroll + 淡化 + 而家線 + 摺疊 + 60s tick（clock 凍結 10:59）══
  // 10:59 → nowMin=659：past = 09:00/09:30/10:00（end ≤ 659）；而家線插 10:00 與 10:30 之間。
  // runFor(121s) → 11:01:01（nowMin=661）：10:30 變 past、而家線移到 10:30 與 11:00 之間（tick 生效）。
  try {
    const clockCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Hong_Kong" });
    await clockCtx.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
    const PC = await clockCtx.newPage();
    if (!PC.clock) throw new Error("playwright clock API 缺（需 ≥1.45）");
    await PC.clock.pauseAt(new Date(`${today}T10:59:00+08:00`));

    await PC.goto(`${base}/schedule?clinic=TKW&view=day&date=${today}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 等 hydration + mount effect 出而家線（nowMin 初始 -1 → effect 後先 render；SSR 無線 → 零 mismatch）
    const posEval = () =>
      PC.evaluate(() => {
        const grid = document.querySelector('div[class*="min-w-[220px]"]');
        if (!grid) return null;
        const kids = Array.from(grid.children);
        const iNow = kids.findIndex((k) => k.hasAttribute("data-now-line"));
        if (iNow < 0) return null;
        const r = grid.querySelector("[data-now-line]")!.getBoundingClientRect();
        return {
          prev: kids[iNow - 1]?.textContent ?? "",
          next: kids[iNow + 1]?.textContent ?? "",
          inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
        };
      });
    let posInfo: { prev: string; next: string; inViewport: boolean } | null = null;
    const tPos = Date.now();
    while (Date.now() - tPos < 30000) {
      posInfo = await posEval();
      if (posInfo && posInfo.prev.includes("10:00") && posInfo.next.includes("10:30")) break;
      await PC.waitForTimeout(500);
    }
    if (!posInfo) throw new Error("而家線缺失（data-now-line）或 30s 內位置未到（hydration？）");
    if (!posInfo.prev.includes("10:00") || !posInfo.next.includes("10:30"))
      throw new Error(`而家線位置錯（prev=${posInfo.prev.slice(0, 12)} next=${posInfo.next.slice(0, 12)}）`);
    if (!posInfo.inViewport) throw new Error("auto-scroll 未生效（而家線唔喺 viewport）");
    if (!(await PC.textContent("body"))?.includes("— 而家")) throw new Error("「— 而家」label 缺失");

    // 淡化：恰 3 行（09:00/09:30/10:00）
    const fadedCount = await PC.evaluate(() => document.querySelectorAll(".opacity-45").length);
    if (fadedCount !== 3) throw new Error(`淡化行數錯（${fadedCount}，要 3）`);

    // 摺疊 round-trip（尾段）
    if (!((await PC.textContent("body")) ?? "").includes("↓ 13:00 之後（唔開診）· 展開")) throw new Error("尾摺行缺失");

    // 60s tick：runFor 121s → 11:01:01（兩 tick 觸發）→ 10:30 變淡化 + 線移位
    await PC.clock!.runFor(121_000);
    let posInfo2: { prev: string; next: string; inViewport: boolean } | null = null;
    const t2 = Date.now();
    while (Date.now() - t2 < 10000) {
      posInfo2 = await posEval();
      if (posInfo2 && posInfo2.prev.includes("10:30") && posInfo2.next.includes("11:00")) break;
      await PC.waitForTimeout(300);
    }
    const fadedCount2 = await PC.evaluate(() => document.querySelectorAll(".opacity-45").length);
    if (fadedCount2 !== 4) throw new Error(`tick 後淡化行數錯（${fadedCount2}，要 4）`);
    if (!posInfo2 || !posInfo2.prev.includes("10:30") || !posInfo2.next.includes("11:00"))
      throw new Error(`tick 後而家線未移位（prev=${posInfo2?.prev.slice(0, 12)} next=${posInfo2?.next.slice(0, 12)}）`);
    await clockCtx.close();
    ok("SCHED-T180");
  } catch (e) {
    fail("SCHED-T180", String(e).slice(0, 160));
  }

  // ══ T181：非今日 → 冇而家線 / 冇淡化 ════════════════════════════════════
  try {
    const tomorrow = addDays(today, 1);
    await P.goto(`${base}/schedule?clinic=TKW&view=day&date=${tomorrow}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(5000);
    const body = (await P.textContent("body")) ?? "";
    if (body.includes("— 而家")) throw new Error("非今日出現而家線");
    const nowLine = await P.evaluate(() => !!document.querySelector("[data-now-line]"));
    if (nowLine) throw new Error("非今日 data-now-line 存在");
    const faded = await P.evaluate(() => document.querySelectorAll(".opacity-45").length);
    if (faded !== 0) throw new Error(`非今日出現淡化行（${faded}）`);
    ok("SCHED-T181");
  } catch (e) {
    fail("SCHED-T181", String(e).slice(0, 160));
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
      let seen = false;
      const tToast = Date.now();
      while (Date.now() - tToast < 7000) {
        const b = (await P.textContent("body")) ?? "";
        if (b.includes("啱啱先同步過")) { seen = true; break; }
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
      let seen409 = false;
      const tToast2 = Date.now();
      while (Date.now() - tToast2 < 7000) {
        const b = (await P.textContent("body")) ?? "";
        if (b.includes("Apricot 忙緊")) { seen409 = true; break; }
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

  // ══ T182：capacity fallback warn（server log — 每 process 每 clinic|date|provider 一次）═
  // WARMUP/T150 嘅 TKW 今日請求已觸發 SSR buildFlowSlots → warn 已落 log。
  try {
    if (!existsSync(logPath)) throw new Error(`server log 檔不存在：${logPath}`);
    const logText = readFileSync(logPath, "utf8");
    const lines = logText
      .split("\n")
      .filter((l) => l.includes("capacity 缺") && l.includes(`"date":"${today}"`) && l.includes('"clinicCode":"TKW"'));
    if (lines.length < 1) throw new Error("capacity fallback warn 缺失（server log）");
    const perProvider = new Map<string, number>();
    for (const l of lines) {
      const m = /"providerId":"([^"]+)"/.exec(l);
      const cap = /"fallbackCapacity":(\d+)/.exec(l);
      if (!m || !cap) throw new Error(`warn 行缺欄：${l.slice(0, 120)}`);
      perProvider.set(m[1], (perProvider.get(m[1]) ?? 0) + 1);
    }
    if (perProvider.size < 1) throw new Error("warn 冇 providerId");
    for (const [pid, c] of perProvider) {
      if (c > 1) throw new Error(`provider ${pid} warn 咗 ${c} 次（要恰 1 次）`);
    }
    ok("SCHED-T182");
  } catch (e) {
    fail("SCHED-T182", String(e).slice(0, 160));
  }

  // ── D.3 fixture：三個對話（窗口開 / 窗口開 / 過窗）───────────────────────
  const convPrefill =
    (() => {
      try {
        cleanupWa(WA_PREFILL);
        mockInbound(WA_PREFILL, "E2E-D-PREFILL");
        return convIdByWa(WA_PREFILL);
      } catch (e) {
        return null;
      }
    })() ?? null;
  const convMini =
    (() => {
      try {
        cleanupWa(WA_MINI);
        mockInbound(WA_MINI, "E2E-D-MINI");
        return convIdByWa(WA_MINI);
      } catch (e) {
        return null;
      }
    })() ?? null;
  const convOldWin =
    (() => {
      try {
        cleanupWa(WA_OLDWIN);
        mockInbound(WA_OLDWIN, "E2E-D-OLDWIN");
        ageConvToPast(WA_OLDWIN, 25);
        return convIdByWa(WA_OLDWIN);
      } catch (e) {
        return null;
      }
    })() ?? null;

  // ══ T183：日視圖 popover — 搜病人 → 發預約連結（Flow · 已鎖定呢格）══════
  try {
    if (!convPrefill) throw new Error("fixture conversation 未建（見上 fixture 錯誤）");
    await P.goto(`${base}/schedule?clinic=TKW&view=day&date=${today}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(4000);
    // 撳 12:00 ONLINE 格（default chip = 第一有席 = mock-pract-TKW-0）
    await L(P.getByTitle(/12:00–12:30/)).first().click();
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("幫病人約"), 5000)))
      throw new Error("popover 未開（幫病人約）");
    await P.fill('input[aria-label="搜病人"]', "E2E-D-PREFILL");
    // debounce 300ms + search + conversations list
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("E2E-D-PREFILL"), 10000)))
      throw new Error("搜尋結果未出現（E2E-D-PREFILL）");
    await L(P.getByRole("button", { name: /E2E-D-PREFILL/ })).first().click();
    await P.waitForTimeout(300);
    const reqBefore = flowsReqs.length;
    const respBefore = flowsResps.length;
    await L(P.getByRole("button", { name: /發預約連結（Flow · 已鎖定呢格）/ })).first().click();
    if (!(await poll(async () => flowsReqs.length > reqBefore, 10000))) throw new Error("Flow POST 未發出");
    const req = flowsReqs[flowsReqs.length - 1];
    if (!req.body.includes(`"date":"${today}"`)) throw new Error(`prefill.date 錯：${req.body.slice(0, 120)}`);
    if (!req.body.includes('"providerId":"mock-pract-TKW-0"')) throw new Error("prefill.providerId 錯");
    if (!req.body.includes('"start":"12:00"')) throw new Error("prefill.start 錯（12:00）");
    if (!(await poll(async () => flowsResps.length > respBefore, 10000))) throw new Error("Flow POST 無 response");
    const resp = flowsResps[flowsResps.length - 1];
    if (resp.status !== 200) throw new Error(`Flow POST ${resp.status}：${resp.body.slice(0, 120)}`);
    if (!/"ok"\s*:\s*true/.test(resp.body)) throw new Error("Flow response ok 唔係 true");
    // toast（UI 唔靜靜成功）
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("已發預約連結（Flow · 已鎖定呢格）"), 5000)))
      throw new Error("成功 toast 缺失");
    // DB：Message body 含 flow_action_payload.data（第一屏預選）
    const msgBody = psql(
      `SELECT body FROM "Message" WHERE "conversationId" = '${convPrefill}' AND body LIKE '%flow_action_payload%' ORDER BY "createdAt" DESC LIMIT 1;`
    );
    if (!msgBody.includes(`"start":"12:00"`)) throw new Error("DB Message 冇 flow_action_payload.start=12:00");
    if (!msgBody.includes(`"date":"${today}"`)) throw new Error("DB Message 冇 flow_action_payload.date");
    ok("SCHED-T183");
  } catch (e) {
    fail("SCHED-T183", String(e).slice(0, 160));
  } finally {
    try { cleanupWa(WA_PREFILL); } catch { /* best-effort */ }
  }

  // ══ T184：側欄迷你表 — 撳格 confirm 一次即發（跳過揀病人）═══════════════
  try {
    if (!convMini) throw new Error("fixture conversation 未建（見上 fixture 錯誤）");
    await P.goto(`${base}/inbox?conv=${convMini}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("今日可約"), 30000)))
      throw new Error("側欄迷你表未出現（今日可約）");
    // 等 data fetch 落定（grid 出現 — 首載有幾百 ms~幾秒 dev 延遲）
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("撳格 = 幫佢約"), 15000)))
      throw new Error("迷你表 grid 未載入（撳格 = 幫佢約 缺失）");
    const body0 = (await P.textContent("body")) ?? "";
    if (!body0.includes("睇成日 →")) throw new Error("「睇成日 →」link 缺失");
    // 撳 09:00 × mock 陳醫師 格（aria-label = `09:00 · mock 陳醫師 · 剩 N 席`）
    await L(P.getByRole("button", { name: /^09:00 · mock 陳醫師 · 剩 \d+ 席$/ })).first().click();
    await P.waitForTimeout(300);
    if (!((await P.textContent("body")) ?? "").includes("幫 E2E-D-MINI 約 09:00–09:30？"))
      throw new Error("confirm 帶缺失（幫 E2E-D-MINI 約 09:00–09:30？）");
    const reqBefore = flowsReqs.length;
    const respBefore = flowsResps.length;
    await L(P.getByRole("button", { name: "發送 Flow" })).first().click();
    if (!(await poll(async () => flowsReqs.length > reqBefore, 10000))) throw new Error("Flow POST 未發出");
    const req = flowsReqs[flowsReqs.length - 1];
    if (!req.body.includes(`"date":"${today}"`) || !req.body.includes('"start":"09:00"') || !req.body.includes('"providerId":"mock-pract-TKW-0"'))
      throw new Error(`prefill 錯：${req.body.slice(0, 120)}`);
    if (!(await poll(async () => flowsResps.length > respBefore, 10000))) throw new Error("Flow POST 無 response");
    const resp = flowsResps[flowsResps.length - 1];
    if (resp.status !== 200 || !/"ok"\s*:\s*true/.test(resp.body))
      throw new Error(`Flow POST ${resp.status} ok 唔係 true：${resp.body.slice(0, 120)}`);
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("已發預約連結（Flow · 已鎖定呢格）"), 5000)))
      throw new Error("成功 flash 缺失");
    ok("SCHED-T184");
  } catch (e) {
    fail("SCHED-T184", String(e).slice(0, 160));
  } finally {
    try { cleanupWa(WA_MINI); } catch { /* best-effort */ }
  }

  // ══ T185：過窗改三出路（日視圖 popover + 側欄迷你表）════════════════════
  try {
    if (!convOldWin) throw new Error("fixture conversation 未建（見上 fixture 錯誤）");
    // a) 日視圖 popover：過窗對話 → 揀中後出三出路（唔出「發預約連結」）
    await P.goto(`${base}/schedule?clinic=TKW&view=day&date=${today}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(4000);
    await L(P.getByTitle(/12:00–12:30/)).first().click();
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("幫病人約"), 5000)))
      throw new Error("popover 未開");
    await P.fill('input[aria-label="搜病人"]', "E2E-D-OLDWIN");
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("E2E-D-OLDWIN"), 10000)))
      throw new Error("搜尋結果未出現");
    await L(P.getByRole("button", { name: /E2E-D-OLDWIN/ })).first().click();
    await P.waitForTimeout(500);
    let body = (await P.textContent("body")) ?? "";
    if (body.includes("發預約連結（Flow · 已鎖定呢格）")) throw new Error("過窗仍出「發預約連結」掣");
    if (!body.includes("24 小時窗口已過 — 揀一個方式跟進")) throw new Error("三出路卡缺失（popover）");
    if (!body.includes("開手機對話")) throw new Error("三出路 ① 缺失");
    if (!body.includes("② 發 template")) throw new Error("三出路 ② 缺失");
    if (!body.includes("③ 等病人下次搵你")) throw new Error("三出路 ③ 缺失");
    if (!body.includes("窗口已過")) throw new Error("結果行窗口狀態缺失（窗口已過）");

    // b) 側欄迷你表：過窗對話 → 撳格 confirm 出三出路（唔出「發送 Flow」）
    await P.goto(`${base}/inbox?conv=${convOldWin}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("今日可約"), 30000)))
      throw new Error("側欄迷你表未出現");
    await L(P.getByRole("button", { name: /^09:00 · mock 陳醫師 · 剩 \d+ 席$/ })).first().click();
    await P.waitForTimeout(300);
    body = (await P.textContent("body")) ?? "";
    if (!body.includes("幫 E2E-D-OLDWIN 約 09:00–09:30？")) throw new Error("confirm 帶缺失（側欄）");
    if (body.includes(">發送 Flow<") || /button[^>]*>[^<]*發送 Flow/.test(body)) throw new Error("過窗仍出「發送 Flow」掣（側欄）");
    if (!body.includes("呢位病人 24 小時窗口已過 — Flow 出唔到，改出三出路：")) throw new Error("側欄三出路引介缺失");
    if (!body.includes("24 小時窗口已過 — 揀一個方式跟進")) throw new Error("三出路卡缺失（側欄）");
    ok("SCHED-T185");
  } catch (e) {
    fail("SCHED-T185", String(e).slice(0, 160));
  } finally {
    try { cleanupWa(WA_OLDWIN); } catch { /* best-effort */ }
  }

  // ══ T186：迷你表 >3 醫生橫捲 + ≤10 行 ═══════════════════════════════════
  try {
    let convWide: string | null = null;
    try {
      cleanupWa(WA_WIDE);
      mockInbound(WA_WIDE, "E2E-D-WIDE");
      convWide = convIdByWa(WA_WIDE);
    } catch {
      convWide = null;
    }
    if (!convWide) throw new Error("fixture conversation 未建（見上 fixture 錯誤）");
    // extra:4 → 2 + 4 = 6 醫生（48px + 6×62px = 420px → 側欄必橫捲）
    writeFileSync(FLAG_EXTRA, JSON.stringify([{ clinicCode: "TKW", extra: 4 }]), "utf8");
    try {
      await P.goto(`${base}/inbox?conv=${convWide}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (!(await poll(async () => ((await P.textContent("body")) ?? "").includes("今日可約"), 30000)))
        throw new Error("側欄迷你表未出現");
      // 等 data fetch 落定（grid 出現）
      if (!(await poll(async () => P.evaluate<boolean>(() => !!document.querySelector('div[class*="grid"][style*="48px"]')), 15000)))
        throw new Error("迷你表 grid 未載入（15s）");
      const scroll = await P.evaluate(() => {
        const grid = document.querySelector('div[class*="grid"][style*="48px"]');
        if (!grid) return null;
        // 真正嘅橫捲 scroller = 最近嘅 overflow-x auto/scroll 祖輩（overflow-x-auto div）
        let scroller: HTMLElement | null = grid.parentElement;
        while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
        if (!scroller) return null;
        const cells = Array.from(grid.querySelectorAll("button[aria-label]")).map((b) => b.getAttribute("aria-label") ?? "");
        const starts = new Set(cells.map((c) => c.split(" · ")[0]));
        return {
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
          rowStarts: starts.size,
        };
      });
      if (!scroll) throw new Error("迷你表 grid 搵唔到");
      if (!(scroll.scrollWidth > scroll.clientWidth))
        throw new Error(`橫捲未生效（scrollWidth=${scroll.scrollWidth} clientWidth=${scroll.clientWidth}）`);
      if (scroll.rowStarts > 10) throw new Error(`行數 ${scroll.rowStarts} > 10`);
      if (scroll.rowStarts < 1) throw new Error("迷你表冇行");
      ok("SCHED-T186");
    } finally {
      rmSync(FLAG_EXTRA, { force: true });
      try { cleanupWa(WA_WIDE); } catch { /* best-effort */ }
    }
  } catch (e) {
    fail("SCHED-T186", String(e).slice(0, 160));
  }

  await P.close();
  await ctx.close();
  await browser.close();

  // T187 = 本 script T151+T152+T156（+ mock-e2e.sh curl T150/T153/T154/T155）— 全綠 = 迴歸過
  const allOk = results.length > 0 && results.every((r) => !r.endsWith("-FAIL"));
  console.log(allOk ? "SCHED-UI-OK" : `SCHED-UI-FAIL: ${results.filter((r) => r.endsWith("-FAIL")).join(", ")}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.log(`SCHED-UI-FAIL: ${String(e).slice(0, 200)}`);
  process.exit(1);
});
