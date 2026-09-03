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
 * - FakeNotification（permission = granted|denied 可控制）— 記錄 title/body
 * - AudioContext 構造計數 = playChime 次數（WebAudio beep）
 * - HTMLMediaElement.play 計數 + src = urgent mp3（第二音）
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
import { readFileSync, readdirSync } from "node:fs";
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
const prefPreset = arg("--prefs"); // JSON（t167 預設 mutedClinics）
const cookieAFile = arg("--cookie");
const cookieBFile = arg("--cookie2");
const cookieCFile = arg("--cookie3");

const PII_NAME = "PII 張三 E2E";
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
  notifications: { title: string; body: string; t: number }[];
  mediaPlays: { src: string; t: number }[];
  ctxCreations: number;
  errors: unknown[];
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
        window.__spy.notifications.push({ title: title, body: this.body, t: Date.now() });
      }
    }
    window.Notification = FakeNotification;
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

function messagePayload(conv: string, clinicId: string, opts: { unread?: number; body?: string; contact?: boolean; direction?: string }): unknown {
  const t = nowIso();
  return {
    conversationId: conv,
    clinicId,
    contact: opts.contact
      ? { id: "e2enotifyct1", waId: PII_PHONE, profileName: PII_NAME, labels: [] }
      : null,
    message: {
      id: nextMsgId(),
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

async function openBrowser(exe: string, cookieFile: string, url: string, mode: "granted" | "denied", prefPreset: string): Promise<{ B: unknown; C: CtxLike; P: PageLike }> {
  const sessionValue = readSession(cookieFile);
  if (!sessionValue) throw new Error(`cookie 檔搵唔到 wa_inbox_session: ${cookieFile}`);
  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<{ newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> }> }).launch({
    headless: true,
    executablePath: exe,
  })) as unknown as { newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> };
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  await C.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();
  await P.addInitScript(spyInitScript(mode, prefPreset));
  await P.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  return { B, C, P };
}

/** 讀 spy snapshot */
async function spy(P: PageLike): Promise<{ notifications: { title: string; body: string }[]; mediaPlays: { src: string }[]; ctxCreations: number }> {
  return await P.evaluate(() => window.__spy) as never;
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

// ── scenarios ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const exe = findChromium();
  const browsers: unknown[] = [];
  const closeAll = async () => {
    for (const b of browsers) {
      await (b as { close: () => Promise<void> }).close().catch(() => {});
    }
  };

  try {
    if (scenario === "t160") {
      // 未指派 → 全店 STAFF 響（A + B 兩瀏覽器都收）
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      const b = await openBrowser(exe, cookieBFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B, b.B);
      await waitForListReady(a.P, PII_NAME);
      await waitForListReady(b.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000)); // socket connect
      const sA = await publishAndRing(a.P, "A（assignee 無 → 全店）", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1 })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      const sB = await publishAndRing(b.P, "B（assignee 無 → 全店）", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1 })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      if (sA.ctxCreations < 1) fail("t160 A: 冇 chime（ctxCreations=0）");
      if (sB.ctxCreations < 1) fail("t160 B: 冇 chime（ctxCreations=0）");
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
      const sA = await publishAndRing(a.P, "A（assignee）", () => publish(clinic, "message:new", messagePayload(convA, clinic, { unread: 1, contact: false, body: "e2e-notify-t161-a" })), (s) => titleMatches(s, `新訊息 · ${CLINIC_SHORT}`));
      if (sA.ctxCreations < 1) fail("t161 A: 冇 chime");
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
    } else if (scenario === "t163") {
      // 30 秒節流（同 conv）+ 全域 10s 最多 3 次音
      if (convsT.length < 5) throw new Error("t163 要 --convs-t 5 個");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, "E2E N3-a");
      await new Promise((r) => setTimeout(r, 3000));
      const [t1, t2, t3, t4, t5] = convsT;
      // Part 1：同 conv 第二條（<30s）→ 抑制
      const s1 = await publishAndRing(a.P, "t163 part1 第一條", () => publish(clinic, "message:new", messagePayload(t1, clinic, { unread: 1, contact: false, body: "e2e-n3-1" })), (s) => s.notifications.length >= 1);
      if (s1.notifications.length !== 1) fail(`t163 part1: 期望 1 通知，actual=${s1.notifications.length}`);
      await new Promise((r) => setTimeout(r, 2000));
      await publish(clinic, "message:new", messagePayload(t1, clinic, { unread: 1, contact: false, body: "e2e-n3-2" }));
      await assertNoNew(a.P, "t163 part1 同 conv 30s 內第二條", { notifications: s1.notifications.length, mediaPlays: s1.mediaPlays.length, ctxCreations: s1.ctxCreations });
      // Part 2：30s 後同 conv 第三條 → 回復
      console.log("  (t163 等 30s 節流窗過咗...)");
      await new Promise((r) => setTimeout(r, 30_000));
      const s2 = await publishAndRing(a.P, "t163 part2 30s 後", () => publish(clinic, "message:new", messagePayload(t1, clinic, { unread: 1, contact: false, body: "e2e-n3-3" })), (s) => s.notifications.length >= 2);
      if (s2.notifications.length !== 2) fail(`t163 part2: 期望 2 通知，actual=${s2.notifications.length}`);
      if (s2.ctxCreations < 2) fail(`t163 part2: 期望 ≥2 chime，actual=${s2.ctxCreations}`);
      // Part 3：全域 10s 最多 3 次音（4 個不同 conv 連發）— 先等 part2 嘅音老化出 10s 滾動窗（否則計數會偏 2）
      console.log("  (t163 等 11s 清空全域音窗...)");
      await new Promise((r) => setTimeout(r, 11_000));
      const before = s2.ctxCreations;
      for (const t of [t2, t3, t4, t5]) {
        await publish(clinic, "message:new", messagePayload(t, clinic, { unread: 1, contact: false, body: `e2e-n3-${t}` }));
        await new Promise((r) => setTimeout(r, 1200));
      }
      const s3 = await waitForSpy(a.P, (s) => s.notifications.length >= 6, "t163 part3 四條通知", 12_000);
      if (s3.notifications.length !== 6) fail(`t163 part3: 期望 6 通知（OS 唔受限流），actual=${s3.notifications.length}`);
      const soundsInPart3 = s3.ctxCreations - before;
      if (soundsInPart3 !== 3) fail(`t163 part3: 10s 內期望 3 次音，actual=${soundsInPart3}`);
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
      // 設定面板存在（B.3）：齒輪 → 面板 + 灰字
      await a.P.locator('[aria-label="通知設定"]').first().click();
      const panel = await a.P.getByText("分頁閂咗就收唔到通知").count();
      if (panel < 1) fail("t165: 設定面板灰字缺");
      const desktopToggle = await a.P.getByText("桌面通知", { exact: true }).count();
      if (desktopToggle < 1) fail("t165: 設定面板「桌面通知」toggle 缺");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t166") {
      // urgent → 第二音（notify-urgent.mp3），唔係 playChime
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      const s = await publishAndRing(a.P, "t166 urgent", () => publish(clinic, "urgent:escalation", urgentPayload(convU, { contactName: PII_NAME })), (sp) => sp.mediaPlays.some((m) => m.src.includes("notify-urgent.mp3")) || titleMatches(sp, `⚠ 緊急 · ${CLINIC_SHORT}`));
      if (!s.mediaPlays.some((m) => m.src.includes("notify-urgent.mp3"))) fail(`t166: 冇 play notify-urgent.mp3（mediaPlays=${JSON.stringify(s.mediaPlays)}）`);
      if (s.ctxCreations > 0) fail(`t166: urgent 唔應該行 playChime（ctxCreations=${s.ctxCreations}）`);
      if (!titleMatches(s, `⚠ 緊急 · ${CLINIC_SHORT}`)) fail(`t166: OS 通知 title 錯（${JSON.stringify(s.notifications)}）`);
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t167") {
      // 多店逐店靜音（C = TKW+MF；預設 mute TKW）
      const a = await openBrowser(exe, cookieCFile, `${base}/inbox`, "granted", prefPreset);
      browsers.push(a.B);
      await waitForListReady(a.P, PII_NAME);
      await new Promise((r) => setTimeout(r, 3000));
      // TKW（muted）→ 靜（交付證明：列表 preview 更新 — 防事件丟失假綠）
      await publishUntilSeen(a.P, "t167 TKW 交付", () => publish(clinic, "message:new", messagePayload(convU, clinic, { unread: 1, contact: false, body: "e2e-notify-t167-tkw" })), "e2e-notify-t167-tkw");
      {
        const s = await spy(a.P);
        if (s.notifications.length > 0 || s.ctxCreations > 0 || s.mediaPlays.length > 0) fail(`t167 TKW（muted）應該靜（spy=${JSON.stringify(s)}）`);
      }
      // MF（未 mute）→ 響
      if (!clinicM) throw new Error("t167 要 --clinic-m");
      const s = await publishAndRing(a.P, "t167 MF（未 mute）", () => publish(clinicM, "message:new", messagePayload(convM, clinicM, { unread: 1, contact: false, body: "e2e-notify-t167-mf" })), (sp) => titleMatches(sp, `新訊息 · ${MF_SHORT}`));
      if (s.ctxCreations < 1) fail("t167 MF: 冇 chime");
      // 設定面板：逐店靜音 section 存在（多店）— C 嘅 SSR 首屏 clinics=[TKW]（legacy 限制）→ 只斷言基本面板
      await a.P.locator('[aria-label="通知設定"]').first().click();
      if ((await a.P.getByText("分頁閂咗就收唔到通知").count()) < 1) fail("t167: 設定面板灰字缺");
      console.log("NOTIFY-UI-OK");
    } else if (scenario === "t168") {
      // mention 迴歸：bell badge + chime + 彈屏（同事名保留）+ 定向（staff room）
      if (!staffA || !staffB) throw new Error("t168 要 --staff-a --staff-b");
      if (!convA) throw new Error("t168 要 --conv-a");
      const a = await openBrowser(exe, cookieAFile, `${base}/inbox`, "granted", "");
      browsers.push(a.B);
      await waitForListReady(a.P, "E2E 李四");
      await new Promise((r) => setTimeout(r, 3000));
      const s = await publishAndRing(a.P, "t168 mention", () => publish(clinic, "notify:mention", { conversationId: convA, clinicId: clinic, messageId: "e2enotifymsg-mention-1", fromStaffId: staffB }, staffA), (sp) => titleMatches(sp, "WA Inbox @mention"));
      if (s.ctxCreations < 1) fail(`t168: 冇 chime（ctxCreations=${s.ctxCreations}）`);
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
      if ((await adm.P.getByText("逐店靜音").count()) < 1) fail("t169: 逐店靜音 section 缺（ADMIN 3 店應見）");
      // Phase 3：opt-in TKW → 收
      const tkwChecks = adm.P.locator('label:has-text("TKW") input[type="checkbox"]');
      const nChecks = await tkwChecks.count();
      if (nChecks < 1) fail("t169: 搵唔到 TKW checkbox");
      // 最后一个 TKW checkbox = ADMIN opt-in section（逐店靜音 section 冇 ADMIN 先見到 — ADMIN 兩者都有；opt-in 喺後面）
      await tkwChecks.last().click();
      const s = await publishAndRing(adm.P, "t169 opt-in 後", () => publish(clinic, "message:new", messagePayload(convA, clinic, { unread: 1, contact: false, body: "e2e-notify-t169" })), (sp) => titleMatches(sp, `新訊息 · ${CLINIC_SHORT}`));
      if (s.ctxCreations < 1) fail("t169 opt-in: 冇 chime");
      // Phase 4：urgent 預設收（MF 未 opt-in 都收 — 急症安全網）
      if (!clinicM) throw new Error("t169 要 --clinic-m");
      const s4 = await publishAndRing(adm.P, "t169 urgent 預設", () => publish(clinicM, "urgent:escalation", urgentPayload(convM, { contactName: PII_NAME })), (sp) => titleMatches(sp, `⚠ 緊急 · ${MF_SHORT}`));
      if (!s4.mediaPlays.some((m) => m.src.includes("notify-urgent.mp3"))) fail("t169 urgent: 冇第二音");
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
