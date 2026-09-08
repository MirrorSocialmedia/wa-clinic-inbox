/**
 * e2e-notify-ui — cwi-master-20260902 B2（Part B 通知 v1）瀏覽器級斷言 T160–T168 + T169（ADMIN 附加）。
 *
 * 點解新建（而唔係擴充 e2e-socket-events.ts）：Part B 驗收係瀏覽器級行為
 * （OS 通知彈屏 / 提示音 / 分頁標題 / favicon 紅點 / bell badge / 設定面板），
 * 現行 socket e2e 係 Node 側 catcher（無 browser）驗唔到 — 照 e2e-window-ui.ts 模式
 * （playwright-core + chromium headless + cookie jar）。
 *
 * 事件注入：直接 Redis publish `wa-inbox:notify`（同 worker publishNotify 完全同 channel/shape）
 * → web server subscriber emit 去 clinic/staff room — 行真實 socket 路徑，
 * 唔依賴 worker 狀態（AI mock 等），確定性高。
 *
 * Spy（addInitScript，app JS 前載入）：
 * - FakeNotification（permission = granted|denied 可控制）— 記錄 title/body/tag/viaSW
 * - ServiceWorkerRegistration.showNotification 攔截 → 同一 spy（viaSW:true + tag）
 *   （v2 有 SW 時通知行 SW — Android 必須；headless 里 SW 真註冊，spy 先收得到）
 * - HTMLMediaElement.play 計數 + src — v2 音效全部走 media：chime.wav（普通）/ notify-urgent.mp3（急）
 * - AudioContext 構造計數（v1 beep 殘留偵測 — v2 應該永遠 = 0）
 *
 * v2 新增場景：t188（全域 3s 節流）/ t189（SW 註冊 + show 路徑）/ t194（手機登出入口）
 * --no-sw：/sw.js request abort → 驗 new Notification fallback 路徑
 *
 * 用法（repo root，dev server 已起）：
 *   pnpm e2e:notify-ui --scenario t160 --base http://127.0.0.1:3100 \
 *     --cookie /tmp/e2e-cookie-tkw.txt --cookie2 /tmp/e2e-cookie-notify-b.txt \
 *     --clinic <tkwId> --conv <convU> --staff-a <id> --staff-b <id> ...
 *
 * 輸出（mock-e2e.sh grep 用）：NOTIFY-UI-OK / NOTIFY-UI-FAIL: <reason>
 *
 * ★ PII 鐵律：斷言本身就用 fixture 病人資料做 canary（t164 零 PII regex）。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Redis from "ioredis";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

// ── args ─────────────────────────────────────────────────────────────────
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

const scenario = req("--scenario");
const base = req("--base").replace(/\/$/, "");
const clinic = req("--clinic");
const clinicM = arg("--clinic-m"); // MF clinic id（t167/t169）
const convU = arg("--conv-u"); // 未指派對話
const convA = arg("--conv-a"); // 已指派對話（assignee = staff-a）
const convM = arg("--conv-m"); // MF 未指派對話（t167/t169）
const convsT = arg("--convs-t").split(",").filter(Boolean); // t163 節流用 5 個未指派
const staffA = arg("--staff-a");
const staffB = arg("--staff-b");
const denied = arg("--denied") === "1";
const noSw = arg("--no-sw") === "1"; // v2：abort /sw.js → 驗 fallback 路徑
const prefPreset = arg("--prefs"); // JSON（t167 預設 mutedClinics）
const waitName = arg("--wait-name"); // 列表等待名（t265–t267；缺省 = PII_NAME）
const cookieAFile = arg("--cookie");
const cookieBFile = arg("--cookie2");
const cookieCFile = arg("--cookie3");
// cwi-realtime-fix T270–T282
const convB = arg("--conv-b"); // 第二對話（t270 合成 B / t272 換對話）
const nameA = arg("--name-a"); // t272 對話 A 接觸人名（列表行 click）
const nameB = arg("--name-b"); // t272 對話 B 接觸人名
const idA2 = arg("--id-a2"); // t270 直插 DB 訊息 id
const bodyA2 = arg("--body-a2"); // t270 直插 DB 訊息 body
const idA3 = arg("--id-a3"); // t271 同秒對 A3
const idA4 = arg("--id-a4"); // t271 同秒對 A4
const bodyA4s = arg("--body-a4s"); // t271 合成 socket 訊息 body
const bodyT2873 = arg("--b3"); // t287（舊 t281）背景訊息 3
const bodyT2874 = arg("--b4"); // t287（舊 t282）背景訊息 4
const bodyA5 = arg("--body-a5"); // t288（舊 t282）重開後應在嘅訊息 body
// ★ cwi-realtime-v2 T281–T285
const staffMfId = arg("--staff-mf"); // t281 跨店 assignee（MF staff id）
const staffTkwId = arg("--staff-tkw"); // t281 同店 assignee（TKW staff id）
const waA = arg("--wa"); // t281 mock-inbound --from（TKW 對話 A 嘅 waId）
const bodyT281a = arg("--b-a"); // t281 (a) 跨店訊息 body
const bodyT281b = arg("--b-b"); // t281 (b) 同店訊息 body
const waM = arg("--wa-m"); // t285 MF 對話 contact waId
const nameM = arg("--name-m"); // t285 MF 對話 contact 名

const PII_NAME = "PII 張三 E2E";
const listWaitName = waitName || PII_NAME; // 必喺 PII_NAME 之後（TDZ）
const PII_PHONE = "85291234567";
const PII_BODY = "e2e-notify-pii-xyz 牙痛瞓唔着想約明日";
const CLINIC_SHORT = "TKW";
const MF_SHORT = "MF";

// ── chromium / cookie ────────────────────────────────────────────────────
function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(baseDir)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到（~/.cache/ms-playwright）");
}

function readSession(cookieFile: string): string {
  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  return (line ?? "").trim().split(/\s+/).pop() ?? "";
}

// ── spy（addInitScript） ─────────────────────────────────────────────────
interface SpyState {
  notifications: { title: string; body: string; tag?: string; viaSW?: boolean; t: number }[];
  mediaPlays: { src: string; t: number }[];
  ctxCreations: number;
  errors: unknown[];
  // cwi-realtime-fix：可觀測性 spy（T273/T274/T275/T276/T272）
  debugLogs: string[]; // console.debug 含 notify: / [rt] 嘅行
  warnLogs: string[]; // console.warn 含 prefs/notify 嘅行（自我修復留痕）
  prefsPosts: string[]; // POST /api/push/prefs 嘅 body（角色欄斷言）
  fetchUrls: string[]; // /messages? 請求 URL（latest vs delta 斷言）
}
declare global {
  interface Window {
    __spy?: SpyState;
  }
}

function spyInitScript(mode: "granted" | "denied", prefPresetJson: string): string {
  return `
  (function (mode, prefJson) {
    window.__spy = { notifications: [], mediaPlays: [], ctxCreations: 0, errors: [] };
    class FakeNotification {
      static get permission() { return mode === "granted" ? "granted" : "denied"; }
      static requestPermission() { return Promise.resolve(FakeNotification.permission); }
      constructor(title, opts) {
        this.title = title;
        this.body = (opts && opts.body) || "";
        this.onclick = null;
        window.__spy.notifications.push({ title: title, body: this.body, tag: (opts && opts.tag) || undefined, viaSW: false, t: Date.now() });
      }
    }
    window.Notification = FakeNotification;
    // v2：有 SW 時 app 行 registration.showNotification — 攔截進 spy（viaSW:true）
    if (window.ServiceWorkerRegistration) {
      ServiceWorkerRegistration.prototype.showNotification = function (title, opts) {
        try {
          window.__spy.notifications.push({ title: title, body: (opts && opts.body) || "", tag: (opts && opts.tag) || undefined, viaSW: true, t: Date.now() });
        } catch (e) {}
        return Promise.resolve();
      };
    }
    if (window.AudioContext) {
      const OrigAC = window.AudioContext;
      window.AudioContext = class extends OrigAC {
        constructor(...a) { super(...a); window.__spy.ctxCreations++; }
      };
    }
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) {
      try { window.__spy.mediaPlays.push({ src: this.currentSrc || this.src || "", t: Date.now() }); } catch (e) {}
      const p = origPlay.apply(this, a);
      return p && typeof p.catch === "function" ? p.catch(() => {}) : p;
    };
    if (prefJson) {
      try { localStorage.setItem("wa_inbox_notify_prefs_v1", prefJson); } catch (e) {}
    }
    // cwi-realtime-fix：debug/warn log + prefs POST + /messages? URL 追蹤（T272/T273/T274/T275/T276）
    window.__spy.debugLogs = [];
    window.__spy.warnLogs = [];
    window.__spy.prefsPosts = [];
    window.__spy.fetchUrls = [];
    const origDebug = console.debug;
    console.debug = function (...a) {
      try {
        const s = a.map((x) => (typeof x === "string" ? x : ((function () { try { return JSON.stringify(x); } catch (e) { return String(x); } })()))).join(" ");
        if (s.indexOf("notify:") >= 0 || s.indexOf("[rt]") >= 0) window.__spy.debugLogs.push(s);
      } catch (e) {}
      return origDebug.apply(console, a);
    };
    const origWarn = console.warn;
    console.warn = function (...a) {
      try {
        const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
        if (s.indexOf("prefs") >= 0 || s.indexOf("notify") >= 0) window.__spy.warnLogs.push(s);
      } catch (e) {}
      return origWarn.apply(console, a);
    };
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.indexOf("/messages?") >= 0) window.__spy.fetchUrls.push(url);
        if (url.indexOf("/api/push/vapid-key") >= 0) window.__spy.fetchUrls.push(url);
        if (url.indexOf("/api/push/prefs") >= 0 && init && (init.method || "GET").toUpperCase() === "POST") {
          window.__spy.prefsPosts.push(typeof init.body === "string" ? init.body : "");
        }
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  })(${JSON.stringify(mode)}, ${JSON.stringify(prefPresetJson)});
  `;
}

// ── redis publisher（同 worker publishNotify 同 channel/shape） ──────────
async function publish(clinicId: string, event: string, payload: unknown, staffId?: string): Promise<void> {
  const r = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await r.connect();
    const msg: Record<string, unknown> = { clinicId, event, payload };
    if (staffId) msg.staffId = staffId;
    await r.publish("wa-inbox:notify", JSON.stringify(msg));
  } finally {
    await r.quit().catch(() => r.disconnect());
  }
}

const nowIso = () => new Date().toISOString();
let msgSeq = 0;
const nextMsgId = () => `e2enotifymsg${++msgSeq}`;

function messagePayload(conv: string, clinicId: string, opts: { unread?: number; body?: string; contact?: boolean; direction?: string; ts?: string; id?: string }): unknown {
  const t = opts.ts ?? nowIso(); // cwi-realtime-fix：可傳固定 ts（同秒對 / 游標序測試）
  return {
    conversationId: conv,
    clinicId,
    contact: opts.contact
      ? { id: "e2enotifyct1", waId: PII_PHONE, profileName: PII_NAME, labels: [] }
      : null,
    message: {
      id: opts.id ?? nextMsgId(), // cwi-realtime-fix：可傳固定 id（同 DB 行 by-id 去重測試）
      waMessageId: `wamid.E2E_NOTIFY_${msgSeq}`,
      direction: opts.direction ?? "IN",
      channel: "API",
      type: "text",
      body: opts.body ?? PII_BODY,
      status: "RECEIVED",
      waTimestamp: t,
    },
    conversation: { status: "OPEN", unreadCount: opts.unread ?? 1, lastMessageAt: t, lastInboundAt: t },
  };
}

function urgentPayload(conv: string, opts: { contactName?: string; contactId?: string }): unknown {
  return {
    conversationId: conv,
    intent: "URGENT_PAIN",
    urgency: "HIGH",
    contactId: opts.contactId ?? "e2enotifyct1",
    contactName: opts.contactName ?? PII_NAME,
    waMessageId: `wamid.E2E_NOTIFY_URG_${msgSeq}`,
  };
}

// ── browser helpers ──────────────────────────────────────────────────────
interface CtxLike {
  addCookies: (c: unknown[]) => Promise<void>;
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
  route: (p: string, h: (r: { abort: () => Promise<void>; fulfill: (o: Record<string, unknown>) => Promise<void> }) => Promise<void>) => Promise<void>;
}
interface PageLike {
  addInitScript: (s: string) => Promise<void>;
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  locator: (sel: string) => LocatorLike;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (role: string, o?: Record<string, unknown>) => LocatorLike;
  evaluate: <T>(fn: unknown, arg?: unknown) => Promise<T>;
  close: () => Promise<void>;
}
interface LocatorLike {
  count: () => Promise<number>;
  first: () => LocatorLike;
  last: () => LocatorLike;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
  click: (o?: Record<string, unknown>) => Promise<void>;
  textContent: () => Promise<string | null>;
  getAttribute: (n: string) => Promise<string | null>;
  allTextContents: () => Promise<string[]>;
}

let failReason: string | null = null;
function fail(r: string): never {
  failReason = r;
  throw new Error(r);
}

async function waitForListReady(P: PageLike, waitText: string, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const n = await P.getByText(waitText).count();
      if (n > 0) return;
    } catch {
      /* page still compiling */
    }
    if (Date.now() - t0 > timeoutMs) fail(`list 120s 未 render（waitText="${waitText}" — dev 編譯失敗？）`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function openBrowser(exe: string, cookieFile: string, url: string, mode: "granted" | "denied", prefPreset: string, opts?: { noSw?: boolean; swBody?: string; viewport?: { width: number; height: number } }): Promise<{ B: unknown; C: CtxLike; P: PageLike }> {
  const sessionValue = readSession(cookieFile);
  if (!sessionValue) throw new Error(`cookie 檔搵唔到 wa_inbox_session: ${cookieFile}`);
  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<{ newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> }> }).launch({
    headless: true,
    executablePath: exe,
    // cwi-realtime-fix §7.2：headless 環境音頻播放确定性（app 層 audioUnlocked gate 照斷 — 呢度只係卸咗瀏覽器 autoplay 政策）
    args: ["--autoplay-policy=no-user-gesture-required"],
  })) as unknown as { newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> };
  const C = await B.newContext({ viewport: opts?.viewport ?? { width: 1440, height: 900 } });
  if (opts?.noSw) {
    // v2 --no-sw：abort /sw.js → SW 註冊失敗 → app 行 new Notification fallback
    await C.route("**/sw.js", (r) => r.abort());
  } else if (opts?.swBody) {
    // cwi-realtime-fix T279/T280：攔截 /sw.js 送指定 byte（SW 版本切換測試）
    await C.route("**/sw.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: opts.swBody }));
  }
  await C.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  // cwi-realtime-fix §2 (RT-4)：DB 係 prefs 單一真相。`--prefs` preset 預設係「舊本地值」（local-only，
  // app mount 會用 DB 覆蓋 — 正是 T273/T274 要測嘅行為）。舊 gate suite 語義（preset = 生效 prefs，
  // 舊 world 靠 syncPushPrefs mount 回寫）用 `--prefs-db` 旗號：預先把角色欄 POST 入 DB。
  // server 按 role 驗證：非本角色欄自動強制 [] — 兩欄一併 POST 安全。
  if (prefPreset && process.argv.includes("--prefs-db")) {
    try {
      const p = JSON.parse(prefPreset) as { mutedClinics?: string[]; adminMsgClinics?: string[] };
      const body: Record<string, unknown> = {};
      if (Array.isArray(p.mutedClinics)) body.mutedClinics = p.mutedClinics;
      if (Array.isArray(p.adminMsgClinics)) body.adminMsgClinics = p.adminMsgClinics;
      if (Object.keys(body).length > 0) {
        const res = await fetch(`${base}/api/push/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `wa_inbox_session=${sessionValue}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) console.error(`[prefs-bridge] POST /api/push/prefs → ${res.status}`);
      }
    } catch (e) {
      console.error("[prefs-bridge] 失敗（繼續）:", String(e));
    }
  }
  const P = await C.newPage();
  await P.addInitScript(spyInitScript(mode, prefPreset));
  await P.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  return { B, C, P };
}

/** 讀 spy snapshot */
async function spy(P: PageLike): Promise<{ notifications: { title: string; body: string; tag?: string; viaSW?: boolean }[]; mediaPlays: { src: string }[]; ctxCreations: number }> {
  return await P.evaluate(() => window.__spy) as never;
}

/** v2 音效計數：chime.wav（message/notice/mention）*/
const chimePlays = (s: Awaited<ReturnType<typeof spy>>): number => s.mediaPlays.filter((m) => m.src.includes("chime.wav")).length;
/** v2 音效計數：notify-urgent.mp3（urgent） */
const urgentPlays = (s: Awaited<ReturnType<typeof spy>>): number => s.mediaPlays.filter((m) => m.src.includes("notify-urgent.mp3")).length;

/** 等 SW 註冊 + activation 完成（v2 斷言 SW 路徑前必做） */
async function waitForSwReady(P: PageLike, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const st = await P.evaluate(() =>
      navigator.serviceWorker?.getRegistration().then((r) => (r ? r.active ? "active" : "pending" : "none")).catch(() => "none")
    ) as string;
    if (st === "active") return;
    if (st === "none" && Date.now() - t0 > timeoutMs) fail("SW 60s 仍未註冊（/sw.js 有問題？）");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 等 spy 達標（ring 類）— 6s poll loop */
async function waitForSpy(P: PageLike, cond: (s: Awaited<ReturnType<typeof spy>>) => boolean, what: string, timeoutMs = 8000): Promise<Awaited<ReturnType<typeof spy>>> {
  const t0 = Date.now();
  for (;;) {
    const s = await spy(P);
    if (cond(s)) return s;
    if (Date.now() - t0 > timeoutMs) fail(`等 ${what} 逾時（${timeoutMs}ms）spy=${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** silent 類：對比 baseline — 斷言冇新增（頁面之前已有事件時防誤判） */
type SpyBaseline = { notifications: number; mediaPlays: number; ctxCreations: number };
async function assertNoNew(P: PageLike, what: string, before?: SpyBaseline): Promise<void> {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await spy(P);
  const b = before ?? { notifications: 0, mediaPlays: 0, ctxCreations: 0 };
  if (s.notifications.length > b.notifications || s.ctxCreations > b.ctxCreations || s.mediaPlays.length > b.mediaPlays) {
    fail(
      `${what}: 期望靜但新增（Δnotif=${s.notifications.length - b.notifications} Δchime=${s.ctxCreations - b.ctxCreations} Δmedia=${s.mediaPlays.length - b.mediaPlays}）spy=${JSON.stringify(s)}`
    );
  }
}

/**
 * 交付證明：重 publish 直到指定文字出現（列表 preview / 對話欄）。
 * 防「silent 假綠」：事件若丟咗（socket 未連 race），「冇響」斷言會假綠 —
 * 先用 DOM 更新證明事件到咗，先斷言 spy 淨。
 */
async function publishUntilSeen(P: PageLike, what: string, pub: () => Promise<void>, visibleText: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pub();
    const t0 = Date.now();
    for (;;) {
      const n = await P.getByText(visibleText).count();
      if (n > 0) return;
      if (Date.now() - t0 > 5000) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (attempt === 3) fail(`${what}: 3 次 publish 文字仍未出現（事件未交付？）`);
  }
}

/** publish + 若期望響但冇反應 → 重 publish（socket 未連 race 兜底；同 conv 節流唔會被重發誤計 — 節流只在收到時計） */
async function publishAndRing(P: PageLike, what: string, pub: () => Promise<void>, cond: (s: Awaited<ReturnType<typeof spy>>) => boolean): Promise<Awaited<ReturnType<typeof spy>>> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pub();
    try {
      return await waitForSpy(P, cond, `${what}（attempt ${attempt}）`, 8000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("逾時")) throw e;
      // 逾時 → 可能 socket 未連 — 再試
    }
  }
  return fail(`${what}: 3 次 publish 都無反應`);
}

function titleMatches(s: Awaited<ReturnType<typeof spy>>, exactTitle: string): boolean {
  return s.notifications.some((n) => n.title === exactTitle);
}

/** 標題里的 (N) — 冇 (N) 前綴回 0 */
async function titleUnread(P: PageLike): Promise<number> {
  const t = (await P.evaluate(() => document.title)) as string;
  const m = /^\((\d+)\) WA Inbox$/.exec(t);
  return m ? Number(m[1]) : 0;
}

/** cwi-notify-fix T4：模擬 tab 背景/前台（patch visibilityState + dispatch visibilitychange） */
async function cycleVisibility(P: PageLike, to: "hidden" | "visible"): Promise<void> {
  await P.evaluate((v: string) => {
    Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
    Object.defineProperty(document, "hidden", { value: v === "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, to);
}

// ── scenarios ────────────────────────────────────────────────────────────
// ── cwi-realtime-fix T270–T282 helpers ───────────────────────────────────────────────

/** 讀 spy 可觀測性欄（debug/warn log、prefs POST、fetch URL） */
async function spyMeta(P: PageLike): Promise<{ debugLogs: string[]; warnLogs: string[]; prefsPosts: string[]; fetchUrls: string[] }> {
  const s = await P.evaluate(() => window.__spy);
  return s as unknown as { debugLogs: string[]; warnLogs: string[]; prefsPosts: string[]; fetchUrls: string[] };
}

/** §7.2：headless 無真實 user gesture → autoplay 鎖定。真實 click（isTrusted）→ app pointerdown
 *  listener → unlockAudio（0 音量 chime）。回 unlock 後 baseline — chime 斷言一律用 delta。
 *  （evaluate dispatch 嘅事件係 untrusted — 解唔到鎖） */
/** 開 SW 前音頻解鎖：真實 trusted gesture（pointerdown）— app `onFirstPointerDown` 一次性
 *  pointerdown listener 先調 unlockAudio（0 音量 chime）。headless 無人手互動 → 用 Playwright
 *  真 click（isTrusted）模擬。
 * ★ 關面板要用**背景遮罩**（fixed inset-0）— 面板開咗時 gear 被遮罩蓋住，
 *   再 click gear 會 pointer-events intercept 30s 超時（T160 等實測）。
 */
async function unlockAudio(P: PageLike): Promise<Awaited<ReturnType<typeof spy>>> {
  const gear = P.locator('[aria-label="通知設定"]').first();
  await gear.click(); // 開（trusted pointerdown — 音頻解鎖就係呢一下）
  await new Promise((r) => setTimeout(r, 500));
  await P.locator('div.fixed.inset-0[aria-hidden="true"]')
    .click({ timeout: 5000 })
    .catch(() => {
      /* 遮罩未出 / 已關 — 唔影響（解鎖已落） */
    });
  await new Promise((r) => setTimeout(r, 800)); // unlock chime（0 音量）落定
  return await spy(P);
}

/** focus 事件 → app onFocus = refetchDelta（純補漏路徑 — 無 fetchMessagesLatest 兜底） */
async function dispatchFocus(P: PageLike): Promise<void> {
  await P.evaluate(() => window.dispatchEvent(new Event("focus")));
}

/** SW 版本查詢（postMessage round-trip — sw.js 嘅 sw-version handler） */
async function swVersionQuery(P: PageLike, timeoutMs = 8000): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const v = (await P.evaluate((t: number) =>
      new Promise<string>((res) => {
        const to = setTimeout(() => res("TIMEOUT"), t);
        navigator.serviceWorker.addEventListener(
          "message",
          (e) => {
            if (e.data && e.data.type === "sw-version-ack") {
              clearTimeout(to);
              res(String(e.data.version));
            }
          },
          { once: true }
        );
        try {
          navigator.serviceWorker.controller?.postMessage({ type: "sw-version" });
        } catch {
          res("NOCTL");
        }
      }),
      timeoutMs
    )) as string;
    if (v !== "TIMEOUT" && v !== "NOCTL") return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

/** 攞 dev server 現行 /sw.js byte */
async function fetchSwBody(baseUrl: string): Promise<string> {
  const r = await fetch(`${baseUrl}/sw.js`);
  if (!r.ok) throw new Error(`sw.js fetch ${r.status}`);
  return await r.text();
}

/** scenario 側 DB 操作（e2e-query — 固定 id 冪等 fixture 插/洗；失敗回 ERR…） */
function dbq(sql: string): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("./node_modules/.bin/tsx", ["scripts/e2e-query.ts", sql], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      timeout: 90_000,
    });
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** dbq 包裝：JSON rows 抽第一行某欄（e2e-query.ts 輸出 = JSON.stringify(rows)） */
function dbqGet(sql: string, key: string): string {
  const out = dbq(sql);
  if (out.startsWith("ERR")) return "";
  try {
    const rows = JSON.parse(out) as Record<string, unknown>[];
    const v = rows[0]?.[key];
    return typeof v === "string" ? v : v == null ? "" : String(v);
  } catch {
    return "";
  }
}

/** 真 webhook 路徑（mock-inbound）— 等 worker 處理（notify 先於 AI 分類，快） */
function mockInbound(clinicCode: string, from: string, text: string, wamid: string, name?: string): void {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const args = ["scripts/mock-inbound.ts", "message", "--clinic", clinicCode, "--from", from, "--text", text, "--wamid", wamid];
    if (name) args.push("--name", name);
    execFileSync("./node_modules/.bin/tsx", args, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // 唔即時 fail — caller 嘅 DOM/DB wait 會 timeout 帶上下文
    console.error(`[mockInbound] ${String(e).slice(0, 200)}`);
  }
}

/** thread 內 #msg-* 行嘅 DOM 序（idx = 位置，total = 總數）— 排序斷言用 */
async function msgDomOrder(P: PageLike, id: string): Promise<{ idx: number; total: number }> {
  return P.evaluate((mid: string) => {
    const el = document.getElementById(`msg-${mid}`);
    if (!el || !el.parentElement) return { idx: -1, total: 0 };
    const rows = Array.from(el.parentElement.children).filter((n) => /^msg-/.test((n as HTMLElement).id ?? ""));
    return { idx: rows.findIndex((n) => (n as HTMLElement).id === `msg-${mid}`), total: rows.length };
  }, id);
}

/** 等 SW subscription（app mount 自動 ensurePushSubscription；headless datacenter 環境 push service
 *  唔可能可用 → null 亦係合理結果，caller 自行判斷） */
async function waitForSubscription(P: PageLike, timeoutMs = 20_000): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    const ep = (await P.evaluate(() =>
      navigator.serviceWorker
        .getRegistration()
        .then((r) =>
          r
            ? r.pushManager.getSubscription().then((s) => (s ? s.endpoint : null))
            : null
        )
        .catch(() => null)
    )) as string | null;
    if (ep) return ep;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 讀 public/sw.js（T279/T280 file-swap — dev server 每次 request 都讀盤） */
function readSwFile(): string {
  return readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf-8");
}
function writeSwFile(body: string): void {
  writeFileSync(path.join(__dirname, "..", "public", "sw.js"), body);
}

/** 等對話開咗（contact 名出現 ≥2 次 = 列表 + chat header） */
async function waitForConvOpen(P: PageLike, name: string, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const n = await P.getByText(name).count();
    if (n >= 2) return;
    if (Date.now() - t0 > timeoutMs) fail(`對話未開（?conv= 深連結；waitText="${name}"）`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const exe = findChromium();
  const browsers: unknown[] = [];
  const closeAll = async () => {
    for (const b of browsers) {
      await (b as { close: () => Promise<void> }).close().catch(() => {});
    }
  };

  try {
    // cwi-realtime-fix §2 (RT-4)：DB 係 prefs 單一真相 → 每個 scenario 開始前清晒 pushPrefs，
    // 還原舊 world 嘅「fresh browser = fresh prefs」語義（DB 跨 scenario 持久 — 唔清會跨 scenario 污染，
    // 例：T275 寫咗 ADMIN adminMsgClinics → 下個 suite 嘅 T169「ADMIN 預設靜」假紅 — 實測）。
    // `--no-prefs-reset`：scenario 自己預設 DB state（T273/T274）— 跳過 reset。
    if (!process.argv.includes("--no-prefs-reset")) {
      const prefReset = dbq('UPDATE "StaffUser" SET "pushPrefs" = NULL');
      if (prefReset.startsWith("ERR")) console.error(`[prefs-reset] 失敗（繼續）: ${prefReset.slice(0, 120)}`);
    }
    if (scenario === "t160") {
      // 未指派 → 全店 STAFF 響（A + B 兩瀏覽器都收）
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      const b = await openBrowser(exe, cookieBFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B, b.B);
      await waitForListReady(a.P, PII_NAME);
      await waitForListReady(b.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000)); // socket connect
      // cwi-realtime-fix §7.2：headless 無真實 gesture → 頁面音鎖 — 模擬真實互動解鎖；
      // chime 斷言用 unlock 後 baseline 嘅 delta
      const baseA = await unlockAudio(a.P);
      const baseB = await unlockAudio(b.P);
      const sA = await publishAndRing(a.P, "A（assignee 無 → 全店）", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1 })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      const sB = await publishAndRing(b.P, "B（assignee 無 → 全店）", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1 })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      if (chimePlays(sA) - chimePlays(baseA) < 1) fail("t160 A: 冇 chime（unlock 後 Δ=0）");
      if (chimePlays(sB) - chimePlays(baseB) < 1) fail("t160 B: 冇 chime（unlock 後 Δ=0）");
      if (sA.ctxCreations !== 0 || sB.ctxCreations !== 0) fail("t160: v1 WebAudio beep 應該已退役（ctxCreations>0）");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t161") {
      // 已指派 → 只負責人響（A = assignee 響；B 靜）
      if (!convA) throw new Error("t161 要 --conv-a");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      const b = await openBrowser(exe, cookieBFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B, b.B);
      await waitForListReady(a.P, "E2E 李四");
      await waitForListReady(b.P, "E2E 李四");
      await new Promise((r) => setTimeout(r, 3000));
      const baseA = await unlockAudio(a.P); // cwi-realtime-fix §7.2：解鎖後先斷 chime
      const sA = await publishAndRing(a.P, "A（assignee）", () => publish(clinic, "message:new", messagePayload(convA, clinic, { unread: 1, contact: false, body: "e2e-notify-t161-a" })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      if (chimePlays(sA) - chimePlays(baseA) < 1) fail("t161 A: 冇 chime（unlock 後 Δ=0）");
      await assertNoNew(b.P, "t161 B（非 assignee）");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t162") {
      // 正開住嗰個對話 → 唔響唔彈（純列表/訊息更新）
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      // 開咗對話 = profileName 出現 ≥2 次（列表 + chat header）
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.getByText(PII_NAME).count();
        if (n >= 2) break;
        if (Date.now() - t0 > 120_000) fail("t162 對話未開（?conv= 深連結）");
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 3000));
      // 交付證明（訊息入對話欄）— 重 publish 兜底 socket 未連 race
      await publishUntilSeen(a.P, "t162", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1 })), PII_BODY);
      // 事件到咗但必須唔響唔彈
      const s = await spy(a.P);
      if (s.notifications.length > 0 || s.ctxCreations > 0 || s.mediaPlays.length > 0) {
        fail(`t162: 正開對話唔應該響/彈（spy=${JSON.stringify(s)}）`);
      }
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t188") {
      // v2 節流（T163 改寫）：同 conv 連發 5 條 → 通知全部照出（tag 取代）+ 聲只響 1 次（全域 3s）；
      // 間隔滿 4s → 再響。斷言 v1 beep（AudioContext）退役。
      if (!convU) throw new Error("t188 要 --conv-u");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      const baseT = await unlockAudio(a.P); // cwi-realtime-fix §7.2：解鎖後 baseline（chime 斷言用 delta）
      // 5 條連發（同 conv，間隔 120ms — 全部落喺 3s 窗內）
      for (let i = 1; i <= 5; i++) {
        await publish(clinic, "message:new", messagePayload(convU, clinic, { unread: i, contact: false, body: `e2e-t188-${i}` }));
        await new Promise((r) => setTimeout(r, 120));
      }
      const s5 = await waitForSpy(a.P, (s) => s.notifications.length >= 5, "t188 五條通知", 15_000);
      if (s5.notifications.length !== 5) fail(`t188: 期望 5 通知（每條都出 — 通知唔受限流），actual=${s5.notifications.length}`);
      if (!s5.notifications.every((n) => n.tag === convU)) fail(`t188: 全部 tag 應 = convU（tags=${JSON.stringify([...new Set(s5.notifications.map((n) => n.tag))])}）`);
      if (chimePlays(s5) - chimePlays(baseT) !== 1) fail(`t188: 3s 窗內期望只響 1 次，Δ=${chimePlays(s5) - chimePlays(baseT)}（mediaPlays=${JSON.stringify(s5.mediaPlays)}）`);
      if (s5.ctxCreations !== 0) fail(`t188: v1 WebAudio beep 應該已退役（ctxCreations=${s5.ctxCreations}）`);
      // 間隔滿 3s → 第六條 → 再響
      console.log("  (t188 等 3.5s 全域音間隔過咗...)");
      await new Promise((r) => setTimeout(r, 3500));
      const s6 = await publishAndRing(a.P, "t188 3.5s 後第六條", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 6, contact: false, body: "e2e-t188-6" })), (s) => s.notifications.length >= 6);
      if (s6.notifications.length !== 6) fail(`t188: 期望 6 通知，actual=${s6.notifications.length}`);
      if (chimePlays(s6) - chimePlays(baseT) !== 2) fail(`t188: 3.5s 後應再響（期望 Δ=2），actual Δ=${chimePlays(s6) - chimePlays(baseT)}`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t164") {
      // OS 零 PII regex — message + urgent 都要（urgent payload 有 contactName = 陷阱）
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      await publishAndRing(a.P, "t164 message", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: true })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      let s = await spy(a.P);
      const msgN = s.notifications.find((n) => n.title === `新訊息 · ${CLINIC_SHORT}`);
      if (!msgN) fail("t164: message 通知缺");
      const msgFull = `${msgN.title} ${msgN.body}`;
      if (msgFull.includes(PII_NAME) || msgFull.includes(PII_PHONE) || msgFull.includes(PII_BODY)) fail(`t164: message 通知含 PII: ${msgFull}`);
      if (msgN.body !== "") fail(`t164: message 通知 body 應該空，actual="${msgN.body}"`);
      // urgent（contactName 喺 payload — 唔准漏）
      await publishAndRing(a.P, "t164 urgent", () => publish(clinic, "urgent:escalation", urgentPayload(convA, { contactName: PII_NAME })), (s) => titleMatches(s, `⚠ 緊急 · ${CLINIC_SHORT}`));
      s = await spy(a.P);
      const urgN = s.notifications.find((n) => n.title === `⚠ 緊急 · ${CLINIC_SHORT}`);
      if (!urgN) fail("t164: urgent 通知缺");
      const urgFull = `${urgN.title} ${urgN.body}`;
      if (urgFull.includes(PII_NAME) || urgFull.includes(PII_PHONE) || urgFull.includes(PII_BODY)) fail(`t164: urgent 通知含 PII: ${urgFull}`);
      if (urgN.body !== "") fail(`t164: urgent 通知 body 應該空，actual="${urgN.body}"`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t165") {
      // permission denied → 降級：(N) 標題 + favicon 紅點 + bell badge
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "denied", "");
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      // 交付證明（列表 preview 更新）— 防事件丟失假綠；標題跟 client state 走
      // （(N) = 全列表未讀總和 — baseline 讀 badge（純 React state，無 Next title manager race），唔假設環境無其他未讀）
      const badgeNum = async () => {
        const b = (await a.P.locator('[aria-label^="訊息未讀"]').first().getAttribute("aria-label")) ?? "";
        const m = /（(\d+) 則）/.exec(b);
        return m ? Number(m[1]) : 0;
      };
      const beforeNum = await badgeNum();
      const expectNum = beforeNum + 3;
      await publishUntilSeen(a.P, "t165 交付", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 3 })), PII_BODY);
      let title = "";
      const t0 = Date.now();
      for (;;) {
        title = await a.P.evaluate(() => document.title);
        if (title === `(${expectNum}) WA Inbox`) break;
        if (Date.now() - t0 > 5000) fail(`t165: 事件已到但標題未變（expected="(${expectNum}) WA Inbox" actual="${title}"）`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const s = await spy(a.P);
      if (s.notifications.length > 0) fail(`t165: denied 唔應該有 OS 通知，actual=${JSON.stringify(s.notifications)}`);
      const iconHref = (await a.P.evaluate(() => (document.getElementById("wa-inbox-dyn-icon") as HTMLLinkElement | null)?.href ?? "")) as string;
      if (!iconHref.startsWith("data:image/png")) fail(`t165: favicon 未換紅點 data URL（href="${iconHref.slice(0, 40)}"）`);
      const hasRed = await a.P.evaluate(
        (href: string) =>
          new Promise<boolean>((res) => {
            const img = new Image();
            img.onload = () => {
              try {
                const c = document.createElement("canvas");
                c.width = 64;
                c.height = 64;
                const g = c.getContext("2d");
                if (!g) return res(false);
                g.drawImage(img, 0, 0, 64, 64);
                const d = g.getImageData(0, 0, 64, 64).data;
                for (let i = 0; i < d.length; i += 4) {
                  if (d[i] > 150 && d[i + 1] < 120 && d[i + 2] < 120) return res(true);
                }
                res(false);
              } catch {
                res(false);
              }
            };
            img.onerror = () => res(false);
            img.src = href;
          }),
        iconHref
      );
      if (!hasRed) fail("t165: favicon 無紅色像素");
      const badge = await a.P.locator('[aria-label^="訊息未讀"]').first().getAttribute("aria-label");
      if (!badge || !badge.includes(`${expectNum} 則`)) fail(`t165: unread badge 錯（expected 含 "${expectNum} 則"，aria-label="${badge}"）`);
      // 設定面板存在（B.3）：齒輪 → 面板 + 灰字（v2 文案：Web Push 閂分頁都收到）
      await a.P.locator('[aria-label="通知設定"]').first().click();
      const panel = await a.P.getByText("閂咗分頁都收到通知").count();
      if (panel < 1) fail("t165: 設定面板灰字缺（v2 文案）");
      const desktopToggle = await a.P.getByText("桌面通知", { exact: true }).count();
      if (desktopToggle < 1) fail("t165: 設定面板「桌面通知」toggle 缺");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t166") {
      // urgent → 第二音（notify-urgent.mp3），唔係 playChime
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      const baseU = await unlockAudio(a.P); // cwi-realtime-fix §7.2：解鎖後先斷 second 音
      const s0 = await publishAndRing(a.P, "t166 urgent", () => publish(clinic, "urgent:escalation", urgentPayload(convU, { contactName: PII_NAME })), (sp) => sp.mediaPlays.some((m) => m.src.includes("notify-urgent.mp3")) || titleMatches(sp, `⚠ 緊急 · ${CLINIC_SHORT}`));
      // ★ cwi-realtime-fix（a2）race 修：cond 有快路「聲」（本地 Audio.play，同步入 spy）；通知行慢路
      //   （SW getRegistration → showNotification round-trip，dev load 下可 >500ms poll 間隔）。
      //   cond 被聲先 hit → snapshot 搶喺通知之前 → 假紅「OS 通知 title 錯（[]）」（實測重現；
      //   probe 驗證 app 本身聲+通知同出）。settle 800ms 後重讀 notifications 先斷言 —
      //   真缺通知（app bug）settle 後照係 [] 照紅，唔會假綠。
      await new Promise((r) => setTimeout(r, 800));
      const s = { ...s0, notifications: (await spy(a.P)).notifications };
      if (!s.mediaPlays.some((m) => m.src.includes("notify-urgent.mp3"))) fail(`t166: 冇 play notify-urgent.mp3（mediaPlays=${JSON.stringify(s.mediaPlays)}）`);
      if (chimePlays(s) - chimePlays(baseU) > 0) fail(`t166: urgent 唔應該行 chime.wav（unlock 後 Δ=${chimePlays(s) - chimePlays(baseU)}）`);
      if (s.ctxCreations > 0) fail(`t166: v1 beep 應該已退役（ctxCreations=${s.ctxCreations}）`);
      if (!titleMatches(s, `⚠ 緊急 · ${CLINIC_SHORT}`)) {
        const dbg = (await a.P.evaluate(() => ({
          ls: localStorage.getItem("wa_inbox_notify_prefs_v1"),
          perm: typeof Notification !== "undefined" ? Notification.permission : "undef",
          reg: !!navigator.serviceWorker.getRegistration,
        }))) as Record<string, unknown>;
        fail(`t166: OS 通知 title 錯（${JSON.stringify(s.notifications)}）dbg=${JSON.stringify(dbg)}`);
      }
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t167") {
      // 多店逐店靜音（C = TKW+MF；預設 mute TKW）
      const a = await openBrowser(exe, cookieCFile, `${base}/inbox`, "granted", prefPreset);
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      const baseC = await unlockAudio(a.P); // cwi-realtime-fix §7.2：解鎖後 baseline
      // TKW（muted）→ 靜（交付證明：列表 preview 更新 — 防事件丟失假綠）
      await publishUntilSeen(a.P, "t167 TKW 交付", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-notify-t167-tkw" })), "e2e-notify-t167-tkw");
      {
        const s = await spy(a.P);
        if (s.notifications.length > 0 || s.ctxCreations > 0) fail(`t167 TKW（muted）應該靜（spy=${JSON.stringify(s)}）`);
        if (s.mediaPlays.length > baseC.mediaPlays.length) fail(`t167 TKW（muted）應該靜（unlock 後 Δmedia=${s.mediaPlays.length - baseC.mediaPlays.length}）`);
      }
      // MF（未 mute）→ 響（v2：chime.wav）
      if (!clinicM) throw new Error("t167 要 --clinic-m");
      const s = await publishAndRing(a.P, "t167 MF（未 mute）", () => publish(clinicM, "message:new", messagePayload(convM, clinicM, { unread: 1, contact: false, body: "e2e-notify-t167-mf" })), (sp) => titleMatches(sp, `新訊息 · ${MF_SHORT}`));
      if (chimePlays(s) - chimePlays(baseC) < 1) fail("t167 MF: 冇 chime（unlock 後 Δ=0）");
      // 設定面板：逐店靜音 section 存在（多店）— C 嘅 SSR 首屏 clinics=[TKW]（legacy 限制）→ 只斷言基本面板
      await a.P.locator('[aria-label="通知設定"]').first().click();
      if ((await a.P.getByText("閂咗分頁都收到通知").count()) < 1) fail("t167: 設定面板灰字缺（v2 文案）");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t168") {
      // mention 迴歸：bell badge + chime + 彈屏（同事名保留）+ 定向（staff room）
      if (!staffA || !staffB) throw new Error("t168 要 --staff-a --staff-b");
      if (!convA) throw new Error("t168 要 --conv-a");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, "E2E 李四");
      await new Promise((r) => setTimeout(r, 3000));
      const baseM = await unlockAudio(a.P); // cwi-realtime-fix §7.2：解鎖後 baseline
      const s = await publishAndRing(a.P, "t168 mention", () => publish(clinic, "notify:mention", { conversationId: convA, clinicId: clinic, messageId: "e2enotifymsg-mention-1", fromStaffId: staffB }, staffA), (sp) => titleMatches(sp, "WA Inbox @mention"));
      if (chimePlays(s) - chimePlays(baseM) < 1) fail(`t168: 冇 chime（unlock 後 Δ=${chimePlays(s) - chimePlays(baseM)}）`);
      const n = s.notifications.find((x) => x.title === "WA Inbox @mention");
      if (!n) fail("t168: mention 通知缺");
      if (!n.body.includes("E2E Notify B")) fail(`t168: mention body 應該有同事名（actual="${n.body}"）`);
      const bell = await a.P.locator('[aria-label^="Mention 通知"]').first().getAttribute("aria-label");
      if (!bell || !bell.includes("1 未讀")) fail(`t168: mention bell badge 未 +1（aria-label="${bell}"）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t169") {
      // ADMIN：預設唔收（六店會炸）+ 設定面板逐店 opt-in + urgent 預設收
      const adm = await openBrowser(exe, cookieCFile, `${base}/inbox`, "granted", "");
      browsers.push(adm.B);
      await waitForListReady(adm.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      // Phase 1：ADMIN 預設唔收 message（交付證明：列表 preview 更新 — 防事件丟失假綠）
      await publishUntilSeen(adm.P, "t169 P1 交付", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-notify-t169-p1" })), "e2e-notify-t169-p1");
      {
        const s = await spy(adm.P);
        if (s.notifications.length > 0 || s.ctxCreations > 0 || s.mediaPlays.length > 0) fail(`t169 ADMIN 預設應該靜（spy=${JSON.stringify(s)}）`);
      }
      // Phase 2：設定面板 ADMIN section 存在
      await adm.P.locator('[aria-label="通知設定"]').first().click();
      if ((await adm.P.getByText("接收訊息通知（預設唔收 — 逐店開）").count()) < 1) fail("t169: ADMIN opt-in section 缺");
      // cwi-realtime-fix §2.3：角色分離 — ADMIN 只見 opt-in（白名單）；逐店靜音（黑名單）係 STAFF 嘅，唔好同時出
      // ★ exact:true — 面板 help 文字（「…逐店靜音 / 訊息通知選項已同步 server…」）含 substring，
      //   只有 section heading（<div>逐店靜音</div>）先 exact match（實測假紅）
      if ((await adm.P.getByText("逐店靜音", { exact: true }).count()) > 0) {
        // a2 診斷 aid：fail 時 dump 實際命中小節（chain 假紅一次，standalone 綠 — 留痕先至追得到）
        const hits = await adm.P.evaluate(
          () => Array.from(document.querySelectorAll("*")).filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() === "逐店靜音").map((el) => el.outerHTML.slice(0, 200))
        ) as string[];
        fail(`t169: ADMIN 唔應該見逐店靜音 section（角色分離）hits=${JSON.stringify(hits)}`);
      }
      // Phase 3：opt-in TKW → 收
      const tkwChecks = adm.P.locator('label:has-text("TKW") input[type="checkbox"]');
      const nChecks = await tkwChecks.count();
      if (nChecks < 1) fail("t169: 搵唔到 TKW checkbox");
      // cwi-realtime-fix §2.3 後：ADMIN 只有一個 TKW checkbox（opt-in）— last() = first()
      await tkwChecks.last().click();
      // v2 全域 3s 音間隔：click 會觸發 pointerdown → unlockAudio 播一次 0 音量 chime（計入 lastSoundAt）
      // → 等 3.5s 先 publish，確保 opt-in 事件嘅 chime 唔會被 unlock 音誤壓（測試語義清晰）
      await new Promise((r) => setTimeout(r, 3500));
      const s = await publishAndRing(adm.P, "t169 opt-in 後", () => publish(clinic, "message:new", messagePayload(convA, clinic, { unread: 1, contact: false, body: "e2e-notify-t169" })), (sp) => titleMatches(sp, `新訊息 · ${CLINIC_SHORT}`));
      if (chimePlays(s) < 1) fail("t169 opt-in: 冇 chime");
      // Phase 4：urgent 預設收（MF 未 opt-in 都收 — 急症安全網）
      if (!clinicM) throw new Error("t169 要 --clinic-m");
      const s4 = await publishAndRing(adm.P, "t169 urgent 預設", () => publish(clinicM, "urgent:escalation", urgentPayload(convM, { contactName: PII_NAME })), (sp) => titleMatches(sp, `⚠ 緊急 · ${MF_SHORT}`));
      if (!s4.mediaPlays.some((m) => m.src.includes("notify-urgent.mp3"))) fail("t169 urgent: 冇第二音");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t189") {
      // v2 SW+PWA：SW 註冊成功 + manifest；show() 有 SW 行 showNotification（viaSW:true）；
      // --no-sw 第二個 browser → new Notification fallback（viaSW:false）
      if (!convU) throw new Error("t189 要 --conv-u");
      // (a) SW 路徑
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await waitForSwReady(a.P);
      const manifestHref = (await a.P.evaluate(() => (document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null)?.href ?? "")) as string;
      if (!manifestHref.includes("manifest.webmanifest")) fail(`t189a: manifest link 缺（href="${manifestHref}"）`);
      const iconHref = (await a.P.evaluate(() => (document.querySelector('link[rel="icon"][sizes="512x512"], link#wa-inbox-dyn-icon') as HTMLLinkElement | null)?.href ?? "")) as string;
      if (!iconHref) fail("t189a: PWA icon link 缺");
      const sA = await publishAndRing(a.P, "t189a SW 路徑", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-t189-a" })), (sp) => titleMatches(sp, `新訊息 · ${CLINIC_SHORT}`));
      const nA = sA.notifications.find((n) => n.title === `新訊息 · ${CLINIC_SHORT}`);
      if (!nA) fail("t189a: 通知缺");
      if (!nA.viaSW) fail(`t189a: 有 SW 應行 showNotification（viaSW=${nA.viaSW}；all=${JSON.stringify(sA.notifications)}）`);
      if (nA.tag !== convU) fail(`t189a: tag 應 = convU（actual=${nA.tag}）`);
      // (b) 無 SW fallback 路徑
      const b = await openBrowser(exe, cookieBFile, `${base}/inbox`, "granted", "", { noSw: true });
      browsers.push(b.B);
      await waitForListReady(b.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 2000));
      const swNone = (await b.P.evaluate(() => navigator.serviceWorker?.getRegistration().then((r) => (r ? "has" : "none")).catch(() => "none"))) as string;
      if (swNone !== "none") fail(`t189b: --no-sw 應該無 SW（actual=${swNone}）`);
      const sB = await publishAndRing(b.P, "t189b fallback 路徑", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-t189-b" })), (sp) => titleMatches(sp, `新訊息 · ${CLINIC_SHORT}`));
      const nB = sB.notifications.find((n) => n.title === `新訊息 · ${CLINIC_SHORT}`);
      if (!nB) fail("t189b: 通知缺（fallback）");
      if (nB.viaSW) fail("t189b: 無 SW 應行 new Notification（viaSW=true）");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t194") {
      // v2 手機登出入口：STAFF 底部 bar「我的」tab → /account（多店 staff 見到自己所有店）→ 登出二次確認 → /login
      const a = await openBrowser(exe, cookieCFile, `${base}/inbox`, "granted", "", { viewport: { width: 390, height: 844 } });
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      const myTab = a.P.locator('a[href="/account"]');
      if ((await myTab.count()) < 1) fail("t194: STAFF 手機底部 bar 缺「我的」tab（/account）");
      await myTab.first().click();
      // ★ navigation 時 evaluate 會 throw "Execution context was destroyed" → 吞咗當過渡
      const getPath = async () => {
        try {
          return (await a.P.evaluate(() => window.location.pathname)) as string;
        } catch {
          return "";
        }
      };
      const t0 = Date.now();
      let atAccount = false;
      for (;;) {
        const p = await getPath();
        if (p === "/account") { atAccount = true; break; }
        if (Date.now() - t0 > 15_000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!atAccount) fail("t194: 撳「我的」未去 /account");
      // ★ dev client-nav race：pathname 已變 /account 但 RSC 內容 swap 可滯後 ~1s（實測探針）
      //   → 斷言前 poll 等內容落地（30s timeout 兼抓真渲染失敗）
      const tAcc = Date.now();
      for (;;) {
        if ((await a.P.getByText("所屬診所").count()) >= 1) break;
        if (Date.now() - tAcc > 30_000) fail("t194: /account 缺「所屬診所」（30s 未渲染）");
        await new Promise((r) => setTimeout(r, 500));
      }
      if ((await a.P.getByText("TKW").count()) < 1) fail("t194: 唔見自己店 TKW");
      if ((await a.P.getByText("MF").count()) < 1) fail("t194: 多店 staff 應見到所有店（MF 缺）");
      const logoutBtn = a.P.getByText("登出", { exact: true });
      if ((await logoutBtn.count()) < 1) fail("t194: 登出掣缺");
      await logoutBtn.first().click();
      if ((await a.P.getByText("再撳一次確認登出").count()) < 1) fail("t194: 二次確認狀態缺");
      await a.P.getByText("再撳一次確認登出").first().click();
      const t1 = Date.now();
      let atLogin = false;
      for (;;) {
        const p = await getPath();
        if (p === "/login") { atLogin = true; break; }
        if (Date.now() - t1 > 15_000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!atLogin) fail("t194: 登出後未去 /login");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t265") {
      // cwi-notify-fix F-7：通知只准 socket/push 觸發 — refetch 路徑（visibilitychange →
      //   register + refetchDelta + fetchMessagesLatest）唔好產生任何通知/聲/標題改。
      if (!convU) throw new Error("t265 要 --conv-u");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000)); // socket connect
      const titleBefore = (await a.P.evaluate(() => document.title)) as string;
      const sBase = await spy(a.P);
      // 背景 → 前台（全程零 socket 事件 — 純 refetch 路徑）
      await cycleVisibility(a.P, "hidden");
      await new Promise((r) => setTimeout(r, 1500));
      await cycleVisibility(a.P, "visible");
      await new Promise((r) => setTimeout(r, 6000)); // 等 register + refetch 行完
      const s = await spy(a.P);
      if (s.notifications.length > sBase.notifications.length) fail(`t265: refetch 路徑唔應該彈通知（Δ=${s.notifications.length - sBase.notifications.length}）spy=${JSON.stringify(s)}`);
      if (s.mediaPlays.length > sBase.mediaPlays.length || s.ctxCreations > sBase.ctxCreations) fail(`t265: refetch 路徑唔應該響（media=${s.mediaPlays.length} ctx=${s.ctxCreations}）`);
      const titleAfter = (await a.P.evaluate(() => document.title)) as string;
      if (titleAfter !== titleBefore) fail(`t265: refetch 路徑唔應該改標題（${titleBefore} → ${titleAfter}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t266") {
      // cwi-notify-fix F-8：refetch 回舊 list（server 快照無 socket 剛 append 嗰條 — 佢只喺 client
      //   state）→ merge by messageId 唔好 drop 嗰條、唔好重複。
      if (!convU) throw new Error("t266 要 --conv-u");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      // 等對話開咗（profileName 出現 ≥2 次 = 列表 + chat header）
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.getByText(listWaitName).count();
        if (n >= 2) break;
        if (Date.now() - t0 > 120_000) fail("t266 對話未開（?conv= 深連結）");
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 3000)); // socket connect
      // socket append 一條（佢唔會入 server 快照 → 下一次 refetch 天然係「舊 list」）
      // 假訊息 id = e2enotifymsg1（msgSeq 進程內首個）— 只數 chat pane 行（#msg-<id>），
      //   唔會同列表 preview 重複計
      await publishUntilSeen(a.P, "t266", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-t266-new" })), "e2e-t266-new");
      const seenBefore = await a.P.locator("#msg-e2enotifymsg1").count();
      if (seenBefore !== 1) fail(`t266: socket append 後期望 chat pane 1 條（actual=${seenBefore}）`);
      // 觸發 refetch（visibility 循環）
      await cycleVisibility(a.P, "hidden");
      await new Promise((r) => setTimeout(r, 1500));
      await cycleVisibility(a.P, "visible");
      await new Promise((r) => setTimeout(r, 6000)); // 等 fetchMessagesLatest 行完（merge）
      const seenAfter = await a.P.locator("#msg-e2enotifymsg1").count();
      if (seenAfter !== 1) fail(`t266: refetch 後 merge 應保留且無重複（期望 1，actual=${seenAfter}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t267") {
      // cwi-notify-fix T4：背景 → 前台 → socket 重註冊（冪等）+ refetch；
      //   循環後 socket 路徑仍可用（新消息照常到）。
      //   限制：headless 無法強制 TCP 斷線，「重連」行為以 re-register → 交付驗證
      //   （visibility handler 已掛 = 循環後事件照常到 + refetch 唔損訊息）。
      if (!convU) throw new Error("t267 要 --conv-u");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.getByText(listWaitName).count();
        if (n >= 2) break;
        if (Date.now() - t0 > 120_000) fail("t267 對話未開（?conv= 深連結）");
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 3000));
      // 背景 → 前台
      await cycleVisibility(a.P, "hidden");
      await new Promise((r) => setTimeout(r, 1500));
      await cycleVisibility(a.P, "visible");
      await new Promise((r) => setTimeout(r, 4000)); // register + refetch
      const vis = (await a.P.evaluate(() => document.visibilityState)) as string;
      if (vis !== "visible") fail(`t267: visibilityState 應=visible（actual=${vis}）`);
      // 交付證明：循環後新消息照常到（socket + register 有效）
      await publishUntilSeen(a.P, "t267", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-t267-after" })), "e2e-t267-after");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t270") {
      // cwi-realtime-fix T1（根因 A）：per-conversation 游標隔離 — B 嘅較新訊息唔好推進 A 嘅補漏窗。
      // A2 只喺 DB（冇 socket 事件）→ 唯一收返路徑係 catchUp(A) 嘅 delta fetch；
      // 舊代碼全域游標被 B（tsB > A2.ts）推進 → fetchMessagesAfter(A, tsB) 永遠收唔到 A2。
      // 觸發用 focus 事件（onFocus = refetchDelta — 無 fetchMessagesLatest 兜底，純補漏路徑）。
      if (!convB || !idA2 || !bodyA2 || !listWaitName) throw new Error("t270 要 --conv-b --id-a2 --body-a2");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      await waitForConvOpen(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000)); // socket connect + 首屏 fetch 落定
      // 對話已開（A 游標 = fixture ts）→ 而家先插 A2 入 DB（確保首屏 latest page 冇佢）
      const tsA2 = new Date(Date.now() + 10_000).toISOString();
      dbq(`DELETE FROM "Message" WHERE id='${idA2}'`);
      const ins = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp") VALUES ('${idA2}','${convU}','rtwa2','IN','API','text','${bodyA2}','RECEIVED','${tsA2}')`
      );
      if (ins.startsWith("ERR")) fail(`t270: A2 INSERT 失敗（${ins.slice(0, 200)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${tsA2}' WHERE id='${convU}'`);
      const before = await a.P.locator(`#msg-${idA2}`).count();
      if (before !== 0) fail(`t270: A2 未 catch-up 前應該未喺 state（actual=${before}）`);
      // 合成 B 訊息（ts 比 A2 新）→ 交付證明 +（舊代碼）全域游標被推進
      const tsB = new Date(Date.now() + 20_000).toISOString();
      await publish(clinic, "message:new", messagePayload(convB, clinic, { unread: 1, contact: false, body: "e2e-t270-b-syn", ts: tsB }));
      const tB0 = Date.now();
      for (;;) {
        if ((await a.P.getByText("e2e-t270-b-syn").count()) > 0) break;
        if (Date.now() - tB0 > 10_000) fail("t270: B 合成訊息未交付（socket 未連？）");
        await new Promise((r) => setTimeout(r, 500));
      }
      // 觸發純補漏路徑（focus → refetchDelta → catchUp(A)）
      await dispatchFocus(a.P);
      const tA2 = Date.now();
      for (;;) {
        const n = await a.P.locator(`#msg-${idA2}`).count();
        if (n === 1) break;
        if (Date.now() - tA2 > 15_000) fail(`t270: A2 應該被 catchUp(A) 補返（15s 後 actual=${n}）— 游標被 B 推進？`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const dbg = (await spyMeta(a.P)).debugLogs;
      if (!dbg.some((l) => l.includes("[rt] catchUp"))) fail(`t270: 應該有 [rt] catchUp log（debugLogs=${JSON.stringify(dbg.slice(-4))}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t271") {
      // cwi-realtime-fix T1（RT-2）：同秒 waTimestamp 對（server after = strict gt）— 60s 重疊窗
      // 令兩條都喺窗口內；fetchMessagesAfter by-id 去重 → 無重複。
      if (!idA3 || !idA4 || !bodyA4s) throw new Error("t271 要 --id-a3 --id-a4 --body-a4s");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      await waitForConvOpen(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      // 插入同秒對 A3/A4（同一 instant — 對話已開先插，確保首屏冇佢哋）
      const tsPair = new Date(Date.now() + 40_000).toISOString();
      dbq(`DELETE FROM "Message" WHERE id IN ('${idA3}','${idA4}')`);
      const ins3 = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp") VALUES ('${idA3}','${convU}','rtwa3','IN','API','text','e2e-t271-a3-db','RECEIVED','${tsPair}')`
      );
      const ins4 = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp") VALUES ('${idA4}','${convU}','rtwa4','IN','API','text','e2e-t271-a4-db','RECEIVED','${tsPair}')`
      );
      if (ins3.startsWith("ERR") || ins4.startsWith("ERR")) fail(`t271: INSERT 失敗（${(ins3 + ins4).slice(0, 200)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${tsPair}' WHERE id='${convU}'`);
      // 合成 socket 訊息（同秒 ts）→ 游標推進到 tsPair + state 有一條（socket append）
      await publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: bodyA4s, ts: tsPair }));
      const tS = Date.now();
      for (;;) {
        if ((await a.P.getByText(bodyA4s, { exact: true }).count()) > 0) break;
        if (Date.now() - tS > 10_000) fail("t271: 合成訊息未交付（socket 未連？）");
        await new Promise((r) => setTimeout(r, 500));
      }
      // 純補漏路徑（focus）→ catchUp(A)：from = cursor - 60s → A3/A4（同秒）都喺窗口
      await dispatchFocus(a.P);
      const tD = Date.now();
      for (;;) {
        const n3 = await a.P.locator(`#msg-${idA3}`).count();
        const n4 = await a.P.locator(`#msg-${idA4}`).count();
        if (n3 === 1 && n4 === 1) break;
        if (Date.now() - tD > 15_000) fail(`t271: 同秒對應該兩條都補返（A3=${n3} A4=${n4}）— 重疊窗失效？`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      // 去重：DB 兩條 + socket 一條各只一次
      const n3 = await a.P.locator(`#msg-${idA3}`).count();
      const n4 = await a.P.locator(`#msg-${idA4}`).count();
      const nS = await a.P.locator("#msg-e2enotifymsg1").count();
      if (n3 !== 1 || n4 !== 1) fail(`t271: 重複行（A3=${n3} A4=${n4}）`);
      if (nS !== 1) fail(`t271: socket 行應該只一次（actual=${nS}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t272") {
      // cwi-realtime-fix §1.5（RT-3）：換對話 = setMessages([]) + fetchMessagesLatest —
      // spy /messages? URL：每次換入 A 嘅最後一個請求必係 ?limit=（絕無 after=）。
      if (!convB || !nameA || !nameB) throw new Error("t272 要 --conv-b --name-a --name-b");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      const lastUrlFor = async (convId: string) => {
        const urls = (await spyMeta(a.P)).fetchUrls;
        const hit = urls.filter((u) => u.includes(`/conversations/${convId}/messages?`));
        return hit.length ? hit[hit.length - 1] : "";
      };
      // 換 1：→ A
      await a.P.getByText(nameA, { exact: true }).first().click();
      await new Promise((r) => setTimeout(r, 3000));
      let url = await lastUrlFor(convU);
      if (!url) fail("t272: 換入 A 後冇 /messages 請求");
      if (url.includes("after=")) fail(`t272: 換對話要行 latest（唔准 delta），actual=${url}`);
      if (!url.includes("limit=")) fail(`t272: latest 請求應帶 limit，actual=${url}`);
      // 換 2：→ B → A（重複換 — state 已清過一次）
      await a.P.getByText(nameB, { exact: true }).first().click();
      await new Promise((r) => setTimeout(r, 3000));
      await a.P.getByText(nameA, { exact: true }).first().click();
      await new Promise((r) => setTimeout(r, 3000));
      url = await lastUrlFor(convU);
      if (url.includes("after=")) fail(`t272: 第二次換入 A 都要行 latest，actual=${url}`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t273") {
      // cwi-realtime-fix T2（RT-4）：DB 單一真相 — mount 時 fetch server 覆蓋 localStorage。
      // prefPreset（--prefs）= 舊本地值（mutedClinics=[TKW]）；driver 已設 DB = {mutedClinics: []}
      // → mount 後 localStorage.mutedClinics 必 = []（server 為準）。
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", prefPreset);
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      const t0 = Date.now();
      for (;;) {
        const local = (await a.P.evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem("wa_inbox_notify_prefs_v1") || "{}");
          } catch {
            return {};
          }
        })) as Record<string, unknown>;
        const muted = Array.isArray(local.mutedClinics) ? (local.mutedClinics as unknown[]) : null;
        if (muted !== null && muted.length === 0) break; // 被 server（DB 空）覆蓋
        if (Date.now() - t0 > 20_000) fail(`t273: 20s localStorage 未喺 server 覆蓋（local=${JSON.stringify(local)}）— mount GET 冇行？`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t274") {
      // cwi-realtime-fix T2（RT-5 client 自我修復）：壞值 muted === adminMsg（非空）→
      // 讀時 muted 當空 + console.warn + 寫返正；最終值由 mount GET（DB）覆蓋。
      // prefPreset = 壞值（兩 array 都 = [TKW]）；driver 已設 DB = {mutedClinics: [MF]}。
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", prefPreset);
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      const t0 = Date.now();
      for (;;) {
        const meta = await spyMeta(a.P);
        const warned = meta.warnLogs.some((w) => w.includes("prefs 壞資料"));
        const local = (await a.P.evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem("wa_inbox_notify_prefs_v1") || "{}");
          } catch {
            return {};
          }
        })) as Record<string, unknown>;
        const muted = Array.isArray(local.mutedClinics) ? (local.mutedClinics as string[]) : null;
        if (warned && muted !== null && muted.length === 1) break;
        if (Date.now() - t0 > 20_000) fail(`t274: 自我修復 warn 缺或 localStorage 未落定（warned=${warned} local=${JSON.stringify(local)}）`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const local = (await a.P.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem("wa_inbox_notify_prefs_v1") || "{}");
        } catch {
          return {};
        }
      })) as Record<string, unknown>;
      const muted = local.mutedClinics as string[];
      if (muted[0] !== clinicM) fail(`t274: localStorage 應 = DB 值 [${clinicM}]（實際=${JSON.stringify(muted)}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t275") {
      // cwi-realtime-fix T2（§2.3）：ADMIN 客戶端唔寫 mutedClinics — 斷 POST payload + 面板單一 checkbox。
      const adm = await openBrowser(exe, cookieCFile, `${base}/inbox`, "granted", "");
      browsers.push(adm.B);
      await waitForListReady(adm.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      await adm.P.locator('[aria-label="通知設定"]').first().click();
      const tkwChecks = adm.P.locator('label:has-text("TKW") input[type="checkbox"]');
      const nChecks = await tkwChecks.count();
      if (nChecks !== 1) fail(`t275: ADMIN 應該只見一個 TKW checkbox（opt-in；無逐店靜音），actual=${nChecks}`);
      const postsBefore = (await spyMeta(adm.P)).prefsPosts.length;
      await tkwChecks.first().click(); // opt-in TKW → POST
      await new Promise((r) => setTimeout(r, 2500));
      const posts = (await spyMeta(adm.P)).prefsPosts.slice(postsBefore);
      if (posts.length < 1) fail(`t275: click 應該觸發 POST /api/push/prefs（Δ=${posts.length}）`);
      const lastBody = JSON.parse(posts[posts.length - 1]) as Record<string, unknown>;
      if (!("adminMsgClinics" in lastBody)) fail(`t275: POST payload 應有 adminMsgClinics，actual=${JSON.stringify(lastBody)}`);
      if ("mutedClinics" in lastBody) fail(`t275: ADMIN POST 唔准帶 mutedClinics，actual=${JSON.stringify(lastBody)}`);
      // cleanup：反轉返（預設唔收）
      await tkwChecks.first().click();
      await new Promise((r) => setTimeout(r, 1500));
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t276") {
      // cwi-realtime-fix T3：通知來源留痕 — socket 事件 → fireNotify（debug log "notify: socket:message:new"）；
      // refetch 路徑（focus → refetchDelta）零 fireNotify（t265 嘅 log 版強化）。
      if (!convU) throw new Error("t276 要 --conv-u");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      // (a) socket 事件 → fireNotify + 來源 log
      await publishAndRing(a.P, "t276 socket", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-t276-s" })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      let dbg = (await spyMeta(a.P)).debugLogs;
      if (!dbg.some((l) => l.includes("notify:") && l.includes("socket:message:new"))) fail(`t276: socket 路徑應有 "notify: socket:message:new" log（debugLogs=${JSON.stringify(dbg.slice(-4))}）`);
      // (b) refetch 路徑（focus）→ 零 notify: + 零新通知
      const baseN = (await spy(a.P)).notifications.length;
      const dbgCount = dbg.length;
      await dispatchFocus(a.P);
      await new Promise((r) => setTimeout(r, 5000));
      const s2 = await spy(a.P);
      if (s2.notifications.length > baseN) fail(`t276: refetch 路徑唔應該彈通知（Δ=${s2.notifications.length - baseN}）`);
      dbg = (await spyMeta(a.P)).debugLogs;
      const newNotify = dbg.slice(dbgCount).filter((l) => l.includes("notify:"));
      if (newNotify.length > 0) fail(`t276: refetch 路徑零 fireNotify（new=${JSON.stringify(newNotify)}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t279") {
      // cwi-realtime-fix T5（SW 更新策略）：★ file-swap（dev server 每次 request 讀盤 — 實測）。
      // Playwright route 攔唔到 SW script fetch（browser process 層）— 改直接換 public/sw.js 內容。
      // byte 變 → reg.update()（updateViaCache:none + no-cache header）→ 新版 install（skipWaiting）
      // → activate（clients.claim）→ controllerchange → 「已更新新版本」提示 + 版本查詢 a2 → a3。
      // ★ cwi-realtime-v2：sw.js 版本由 cwi-routing-20260906 bump 咗 a1→a2 — 本 scenario 跟住用 a2→a3。
      const v1file = readSwFile();
      if (!v1file.includes("2026-09-07-a2")) fail("t279: public/sw.js 現行版本唔係 2026-09-07-a2（檔案被改過？）");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      await waitForSwReady(a.P);
      const v1 = await swVersionQuery(a.P);
      if (v1 !== "2026-09-07-a2") fail(`t279: 初始版本應 a2，actual=${v1}`);
      try {
        writeSwFile(v1file.replace("2026-09-07-a2", "2026-09-07-a3"));
        await new Promise((r) => setTimeout(r, 300)); // 落盤 settle
        await a.P.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => (r ? r.update() : null)).catch(() => null));
        const t0 = Date.now();
        for (;;) {
          const toast = await a.P.getByText("已更新新版本").count();
          if (toast > 0) break;
          if (Date.now() - t0 > 45_000) fail(`t279: 45s 冇「已更新新版本」提示（SW file update 失敗？v1=${v1}）`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        if ((await a.P.getByText("重載").count()) < 1) fail("t279: 提示應有 [重載] 掣");
        await new Promise((r) => setTimeout(r, 2000)); // 新 SW activate 完
        const v2 = await swVersionQuery(a.P);
        if (v2 !== "2026-09-07-a3") fail(`t279: 更新後版本應 = 2026-09-07-a3，actual=${v2}`);
      } finally {
        writeSwFile(v1file); // 還原（失敗都還 — 唔污染 repo）
      }
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t280") {
      // cwi-realtime-fix T5：SW 更新唔會令 push subscription 失效。
      // ★ 環境限制（實測）：headless datacenter Chromium 嘅 push service 唔可用
      //   （pushManager.subscribe → AbortError: permission denied，grantPermissions 都係）—
      //   故斷言採 adaptive：subscription 得返就做真 endpoint 不變斷言；唔得就斷
      //   （a）app 訂閱 flow 有行（vapid key fetch）（b）SW 更新後 pushManager 照可用
      //   （c）SW 照 active（d）endpoint 唔會由有變無。
      const v1file = readSwFile();
      if (!v1file.includes("2026-09-07-a2")) fail("t280: public/sw.js 現行版本唔係 2026-09-07-a2");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      await waitForSwReady(a.P);
      const getSubEp = (P: PageLike) =>
        P.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
          if (!reg) return null;
          const s = await reg.pushManager.getSubscription().catch(() => null);
          return s ? s.endpoint : null;
        }) as Promise<string | null>;
      const ep1 = await getSubEp(a.P);
      // 等 app 訂閱 flow（sw:activated hook → ensurePushSubscription → vapid fetch）
      await new Promise((r) => setTimeout(r, 6000));
      const vapidFetches = (await spyMeta(a.P)).fetchUrls.filter((u) => u.includes("/api/push/vapid-key")).length;
      if (vapidFetches < 1) fail(`t280: app 應該行過訂閱 flow（vapid key fetch=0）`);
      try {
        writeSwFile(v1file.replace("2026-09-07-a2", "2026-09-07-a3"));
        await new Promise((r) => setTimeout(r, 300));
        await a.P.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => (r ? r.update() : null)).catch(() => null));
        const t0 = Date.now();
        for (;;) {
          const toast = await a.P.getByText("已更新新版本").count();
          if (toast > 0) break;
          if (Date.now() - t0 > 45_000) fail("t280: SW update 提示未出（45s）");
          await new Promise((r) => setTimeout(r, 1000));
        }
        await new Promise((r) => setTimeout(r, 2000));
        const post = (await a.P.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
          if (!reg) return { ep: null, state: "none", pushMgr: false };
          const s = await reg.pushManager.getSubscription().catch(() => null);
          return { ep: s ? s.endpoint : null, state: reg.active ? "active" : "none", pushMgr: typeof reg.pushManager.getSubscription === "function" };
        })) as { ep: string | null; state: string; pushMgr: boolean };
        if (!post.pushMgr) fail("t280: SW 更新後 pushManager 應該照可用");
        if (post.state !== "active") fail(`t280: SW 更新後應照 active，actual=${post.state}`);
        if (ep1 && post.ep !== ep1) fail(`t280: subscription endpoint 唔應該變（ep1=${ep1.slice(0, 60)}… ep2=${post.ep ? post.ep.slice(0, 60) : "null"}…）`);
        if (ep1 && !post.ep) fail("t280: SW 更新後 subscription 唔應該失效（endpoint 由有變無）");
      } finally {
        writeSwFile(v1file);
      }
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t287") {
      // cwi-realtime-fix §4 第 3 步（原 t281 — v2 重編號：新 T281–T285 讓位）：背景（visibility 假裝）期間兩條訊息 → 前台兩條都喺、
      // 無重複（socket append + 前台 refetchDelta/catchUp merge）+ catchUp log。
      // ★ 訊息要 DB-backed（raw INSERT 固定 id + Conversation.lastMessageAt 推進）—
      //   純合成 socket 事件唔入 DB → 對話列表 delta（refetchDelta 嘅前置）返空 → 唔行 catchUp。
      //   socket 事件同 DB 行用同一 message id → by-id 去重驗證真實 merge 路徑。
      if (!bodyT2873 || !bodyT2874) throw new Error("t287 要 --b3 --b4");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      await waitForConvOpen(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      const M3 = "e2et287m3";
      const M4 = "e2et287m4";
      dbq(`DELETE FROM "Message" WHERE id IN ('${M3}','${M4}')`);
      await cycleVisibility(a.P, "hidden"); // 背景
      await new Promise((r) => setTimeout(r, 2000));
      // msg 3：DB 行 + 同 id 合成 socket 事件
      const ts3 = new Date(Date.now() + 5000).toISOString();
      const ins3 = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp") VALUES ('${M3}','${convU}','rtt287m3','IN','API','text','${bodyT2873}','RECEIVED','${ts3}')`,
      );
      if (ins3.startsWith("ERR")) fail(`t287: M3 INSERT 失敗（${ins3.slice(0, 150)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${ts3}' WHERE id='${convU}'`);
      await publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: bodyT2873, ts: ts3, id: M3 }));
      await new Promise((r) => setTimeout(r, 3000));
      // msg 4：同上
      const ts4 = new Date(Date.now() + 10_000).toISOString();
      const ins4 = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp") VALUES ('${M4}','${convU}','rtt287m4','IN','API','text','${bodyT2874}','RECEIVED','${ts4}')`,
      );
      if (ins4.startsWith("ERR")) fail(`t287: M4 INSERT 失敗（${ins4.slice(0, 150)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${ts4}' WHERE id='${convU}'`);
      await publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 2, contact: false, body: bodyT2874, ts: ts4, id: M4 }));
      await new Promise((r) => setTimeout(r, 3000));
      await cycleVisibility(a.P, "visible"); // 前台 → refetchDelta（列表 delta 有行 → catchUp）+ fetchMessagesLatest
      const t0 = Date.now();
      for (;;) {
        const n3 = await a.P.locator(`#msg-${M3}`).count();
        const n4 = await a.P.locator(`#msg-${M4}`).count();
        if (n3 === 1 && n4 === 1) break;
        if (Date.now() - t0 > 15_000) {
          const n3 = await a.P.locator(`#msg-${M3}`).count();
          const n4 = await a.P.locator(`#msg-${M4}`).count();
          fail(`t287: 背景訊息前台應該兩條都喺（M3=${n3} M4=${n4}）`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      await new Promise((r) => setTimeout(r, 2000)); // catchUp log 落定
      const dbg = (await spyMeta(a.P)).debugLogs;
      if (!dbg.some((l) => l.includes("[rt] catchUp"))) fail(`t287: 前台 catchUp 應該有 log（debugLogs=${JSON.stringify(dbg.slice(-4))}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t288") {
      // cwi-realtime-fix §4 第 4 步（原 t282 — v2 重編號）：tab 「閂咗」期間送咗訊息（driver 真 webhook 路徑 — 已入 DB）
      // → 重開新瀏覽器 → 訊息喺度。
      if (!bodyA5) throw new Error("t288 要 --body-a5");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.getByText(bodyA5, { exact: true }).count();
        if (n >= 1) break;
        if (Date.now() - t0 > 30_000) fail("t288: 重開後 30s 訊息仍未喺（?conv= 首屏 fetch 失敗？）");
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t281") {
      // cwi-realtime-v2 T281 §1：跨店 assignee（MF staff 唔綁定 TKW）經 staff: room 收 message:new；
      //   同店 assignee（TKW staff）收兩次（clinic + staff room）→ client seenEventIds 去重 = 只彈一次。
      // 真 worker 路徑（mock-inbound → inbound.worker notifyNewMessage → publishNotify + publishStaffNotify）。
      if (!staffMfId || !staffTkwId || !waA || !bodyT281a || !bodyT281b) throw new Error("t281 要 --staff-mf --staff-tkw --wa --b-a --b-b");
      const wamidA = `rtwv2a${Date.now()}`;
      // (a) 跨店：assignee = MF staff
      dbq(`UPDATE "Conversation" SET "assigneeId"='${staffMfId}' WHERE id='${convU}'`);
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", ""); // MF staff
      browsers.push(a.B);
      await waitForListReady(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000)); // socket 註冊 + room join
      // MF staff 嘅列表應該見到呢行（跨店指派俾我）+ 跨店 badge
      const nCross = await a.P.getByText("↔ 跨店").count();
      if (nCross < 1) fail(`t281a: MF staff 列表應該有「↔ 跨店」badge（actual=${nCross}）`);
      mockInbound("TKW", waA, bodyT281a, wamidA);
      const tA = Date.now();
      for (;;) {
        if ((await a.P.getByText(bodyT281a, { exact: true }).count()) > 0) break;
        if (Date.now() - tA > 25_000) fail("t281a: 跨店 assignee 25s 未收到 message:new（staff: room 補推失敗？）");
        await new Promise((r) => setTimeout(r, 1000));
      }
      // 開對話 → thread 嗰行（MF staff 只喺 staff room — 收一次）
      await a.P.getByText(listWaitName, { exact: true }).first().click();
      await waitForConvOpen(a.P, listWaitName, 30_000); // click 失敗（banner 擋 / re-render）→ 呢度快 fail
      const idA1 = dbqGet(`SELECT "id" m FROM "Message" WHERE "waMessageId"='${wamidA}'`, "m");
      if (!idA1) fail("t281a: 訊息未落 DB（mock-inbound 失敗？）");
      const tA1 = Date.now();
      for (;;) {
        const n = await a.P.locator(`#msg-${idA1}`).count();
        if (n === 1) break;
        if (Date.now() - tA1 > 15_000) {
          const n = await a.P.locator(`#msg-${idA1}`).count();
          const diag = await a.P.evaluate(() => ({
            convParam: new URLSearchParams(location.search).get("conv"),
            msgRows: document.querySelectorAll('[id^="msg-"]').length,
            rowIds: Array.from(document.querySelectorAll('[id^="msg-"]')).slice(0, 5).map((el) => el.id),
          }));
          const meta = await spyMeta(a.P);
          const msgFetches = meta.fetchUrls.filter((u) => u.includes("/messages"));
          fail(`t281a: thread 應該恰有 1 行（actual=${n}; diag=${JSON.stringify(diag)}; msgFetches=${JSON.stringify(msgFetches.slice(-3))}）`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      // (b) 同店去重：assignee = TKW staff；對話唔 selectable（active conversation 會壓通知）
      dbq(`UPDATE "Conversation" SET "assigneeId"='${staffTkwId}' WHERE id='${convU}'`);
      const b = await openBrowser(exe, cookieBFile, `${base}/inbox`, "granted", ""); // TKW staff
      browsers.push(b.B);
      await waitForListReady(b.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      const wamidB = `rtwv2b${Date.now()}`;
      mockInbound("TKW", waA, bodyT281b, wamidB);
      const tB = Date.now();
      for (;;) {
        if ((await b.P.getByText(bodyT281b, { exact: true }).count()) > 0) break;
        if (Date.now() - tB > 25_000) fail("t281b: 同店 assignee 25s 未收到 message:new");
        await new Promise((r) => setTimeout(r, 1000));
      }
      await new Promise((r) => setTimeout(r, 3000)); // 兩次事件（clinic + staff room）都到齊
      const sp = await spy(b.P);
      const nNotify = sp.notifications.filter((n) => n.tag === convU).length;
      if (nNotify !== 1) fail(`t281b: 同店 assignee 應該恰彈 1 次通知（去重；actual=${nNotify}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t282") {
      // cwi-realtime-v2 T282 §2：IN 訊息 waTimestamp 比 cursor 早 5 分鐘（慢鐘）—
      //   socket 靜音變體（raw INSERT 無 socket 事件）→ 必經 catchUp 攞到（createdAt 游標）+ 排序排最尾。
      if (!bodyA5) throw new Error("t282 要 --body-a5");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      await waitForConvOpen(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      const M = "e2ev2t282";
      dbq(`DELETE FROM "Message" WHERE id='${M}'`);
      const createdTs = new Date().toISOString();
      const waTs = new Date(Date.now() - 5 * 60_000).toISOString(); // 慢鐘：waTimestamp 早 5 分鐘
      const ins = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp","createdAt") VALUES ('${M}','${convU}','rtwv2t282','IN','API','text','${bodyA5}','RECEIVED','${waTs}','${createdTs}')`,
      );
      if (ins.startsWith("ERR")) fail(`t282: INSERT 失敗（${ins.slice(0, 150)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${createdTs}' WHERE id='${convU}'`);
      await dispatchFocus(a.P); // → refetchDelta → catchUp（createdAt 游標）
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.locator(`#msg-${M}`).count();
        if (n >= 1) break;
        if (Date.now() - t0 > 25_000) {
          const n = await a.P.locator(`#msg-${M}`).count();
          fail(`t282: catchUp（createdAt 游標）未攞到慢鐘訊息（count=${n}）`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      // 排序：createdAt 主序 → 新 createdAt 排最尾（waTimestamp 雖舊）
      await new Promise((r) => setTimeout(r, 1500)); // sort 安定
      const { idx, total } = await msgDomOrder(a.P, M);
      if (total < 2) fail(`t282: thread 應該 >=2 行（total=${total}）`);
      if (idx !== total - 1) fail(`t282: 慢鐘訊息應該排最尾（idx=${idx} total=${total}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t283") {
      // cwi-realtime-v2 T283 §2：HISTORY（匯入舊訊息）createdAt=匯入時間（新）但 waTimestamp=歷史（舊）
      //   → 排序例外必須生效：排最舊（唔會插去最新）。
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      await waitForConvOpen(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      const M = "e2ev2t283";
      dbq(`DELETE FROM "Message" WHERE id='${M}'`);
      const createdTs = new Date().toISOString(); // 匯入 = 而家
      const waTs = new Date(Date.now() - 3 * 86_400_000).toISOString(); // 訊息 = 3 日前
      const ins = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp","createdAt") VALUES ('${M}','${convU}','rtwv2t283','IN','HISTORY','text','e2e-v2-t283-history','RECEIVED','${waTs}','${createdTs}')`,
      );
      if (ins.startsWith("ERR")) fail(`t283: INSERT 失敗（${ins.slice(0, 150)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${createdTs}' WHERE id='${convU}'`);
      await dispatchFocus(a.P); // catchUp（createdAt 游標）攞到（createdAt 新）→ merge 排序要排最舊
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.locator(`#msg-${M}`).count();
        if (n >= 1) break;
        // 12s 未現 → 補一次 focus（用戶重新點入 window 嘅真實行為）
        if (Date.now() - t0 > 12_000) {
          await dispatchFocus(a.P).catch(() => {});
        }
        if (Date.now() - t0 > 25_000) {
          const n = await a.P.locator(`#msg-${M}`).count();
          const meta = await spyMeta(a.P);
          const rtLogs = meta.debugLogs.filter((l) => l.includes("[rt]")).slice(-8);
          const convFetches = meta.fetchUrls.filter((u) => u.includes("/conversations") || u.includes("/messages")).slice(-6);
          fail(`t283: catchUp 未攞到 HISTORY 訊息（count=${n}; rtLogs=${JSON.stringify(rtLogs)}; fetches=${JSON.stringify(convFetches)}）`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      await new Promise((r) => setTimeout(r, 1500));
      const { idx, total } = await msgDomOrder(a.P, M);
      if (total < 2) fail(`t283: thread 應該 >=2 行（total=${total}）`);
      if (idx !== 0) fail(`t283: HISTORY 應該排最舊（idx=${idx} total=${total}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t284") {
      // cwi-realtime-v2 T284 §3：socket 靜音（raw INSERT 唔派事件）→ 20s reconcile 安全網必須攞到
      //   + `[rt] reconcile added 1` log（唔 trigger focus/visibility — 唯一路徑就係 reconcile tick）。
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox?conv=${convU}`, "granted", "");
      browsers.push(a.B);
      await waitForConvOpen(a.P, listWaitName);
      await new Promise((r) => setTimeout(r, 3000));
      const M = "e2ev2t284";
      dbq(`DELETE FROM "Message" WHERE id='${M}'`);
      const ts = new Date().toISOString();
      const ins = dbq(
        `INSERT INTO "Message" (id,"conversationId","waMessageId",direction,channel,type,body,status,"waTimestamp","createdAt") VALUES ('${M}','${convU}','rtwv2t284','IN','API','text','e2e-v2-t284-reconcile','RECEIVED','${ts}','${ts}')`,
      );
      if (ins.startsWith("ERR")) fail(`t284: INSERT 失敗（${ins.slice(0, 150)}）`);
      dbq(`UPDATE "Conversation" SET "lastMessageAt"='${ts}' WHERE id='${convU}'`);
      // 唔 dispatch 任何 focus/visibility — 等 20s reconcile tick
      const t0 = Date.now();
      for (;;) {
        const n = await a.P.locator(`#msg-${M}`).count();
        if (n >= 1) break;
        if (Date.now() - t0 > 50_000) {
          const n = await a.P.locator(`#msg-${M}`).count();
          fail(`t284: reconcile（20s）未攞到 socket 靜音訊息（count=${n}）`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 1500)); // log 落定
      const dbg = (await spyMeta(a.P)).debugLogs;
      if (!dbg.some((l) => l.includes("[rt] reconcile added"))) fail(`t284: 缺 [rt] reconcile log（debugLogs=${JSON.stringify(dbg.slice(-6))}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t285") {
      // cwi-realtime-v2 T285 §4：ADMIN 列表唔顯示「跨店」badge（只店名 badge）；STAFF 真跨店照顯示。
      if (!waM || !nameM || !staffTkwId) throw new Error("t285 要 --wa-m --name-m --staff-tkw");
      // 1) 造 MF 店對話（真 webhook 路徑）+ 指派 TKW staff（對佢係真跨店：線唔喺佢綁定店）
      const wamidM = `rtwv2m${Date.now()}`;
      mockInbound("MF", waM, "e2e-v2-t285", wamidM, nameM);
      let convM = "";
      const t0 = Date.now();
      for (;;) {
        convM = dbqGet(`SELECT "conversationId" c FROM "Message" WHERE "waMessageId"='${wamidM}'`, "c");
        if (convM) break;
        if (Date.now() - t0 > 25_000) fail("t285: MF 對話未落 DB（mock-inbound 失敗？）");
        await new Promise((r) => setTimeout(r, 1000));
      }
      dbq(`UPDATE "Conversation" SET "assigneeId"='${staffTkwId}' WHERE id='${convM}'`);
      // 2) TKW staff：MF 店嘅行應該顯示「↔ 跨店 · MF」
      const s = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(s.B);
      await waitForListReady(s.P, nameM);
      const nStaff = await s.P.getByText("↔ 跨店 · MF").count();
      if (nStaff < 1) fail(`t285: STAFF 真跨店應該顯示「↔ 跨店 · MF」badge（actual=${nStaff}）`);
      // 3) ADMIN：冇「跨店」字樣；「全部診所」視圖照顯示店名 badge
      const d = await openBrowser(exe, cookieCFile, `${base}/inbox`, "granted", ""); // ADMIN
      browsers.push(d.B);
      await waitForListReady(d.P, listWaitName);
      const nCross = await d.P.getByText("跨店").count();
      if (nCross !== 0) fail(`t285: ADMIN 列表唔應該有「跨店」（actual=${nCross}）`);
      const nTkwBadge = await d.P.getByText("TKW", { exact: true }).count();
      if (nTkwBadge < 1) fail(`t285: ADMIN 全店視圖應該有店名 badge TKW（actual=${nTkwBadge}）`);
      console.log("NOTIFY-UI-OK");
    } else {
      throw new Error(`unknown scenario: ${scenario}`);
    }
  } catch (e) {
    const r = e instanceof Error ? e.message : String(e);
    console.log(`NOTIFY-UI-FAIL: ${failReason ?? r}`);
    process.exitCode = 1;
  } finally {
    await closeAll();
  }
}

void main();
