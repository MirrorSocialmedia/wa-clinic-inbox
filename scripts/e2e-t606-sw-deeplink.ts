/**
 * e2e-t606 — cwi-final S0-2：Push 通知 deep link 參數（?c= → ?conv=）
 *
 * T606（施工單）：Playwright — 關晒 tab，clients.openWindow 開 /inbox?conv=<id>，
 * 斷言對話已選中。
 *
 * 實作：
 *  (1) 靜態核 dev server 實發嘅 /sw.js：notificationclick 開新窗 URL 精確 = /inbox?conv=<id>（舊 ?c= 死參數已除）
 *  (2) 瀏覽器級：login → /inbox（斷言 SW 真註冊）→ 關晒 tab → 開新窗 /inbox?conv=<id>
 *      （= handler openWindow 分支嘅同一個 URL）→ 斷言對話已選中（pane 有 A 訊息，冇 B 訊息）。
 *  ★ headless 限制（實測 2026-09-18）：notificationclick 觸發嘅 clients.openWindow 需要 transient
 *    activation（OS 通知 click）— headless 無通知 UI + Notification 權限 CDP grant 都 denied →
 *    openWindow 本體無法 headless 觸發；改上面 (1)+(2) 等效覆蓋（URL 精確核 + 無 tab 時開窗行為）。
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + Redis）。
 * fixture：`E2E S2 ` 前綴（8 位 HK waId），段尾 hermetic sweep。
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t606-sw-deeplink.ts
 * 輸出：T606-OK / T606-FAIL: <reason>
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const NAME_A = "E2E S2 陳一";
const NAME_B = "E2E S2 陳二";
const WA_A = "61019001"; // HK 8 位（normalizeHkPhones 只食 8 位 / E.164）
const WA_B = "61019002";
const EPOCH = Date.now().toString().slice(-6);
const WAM_A = `wae2es2a${EPOCH}`;
const WAM_B = `wae2es2b${EPOCH}`;
const TXT_A = `E2E S2 A 對話 canary ${EPOCH}`;
const TXT_B = `E2E S2 B 對話 canary ${EPOCH}`;

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, actual: unknown, expected: unknown): void {
  if (String(actual) === String(expected)) ok(name);
  else fail(`${name}（expected=[${expected}] actual=[${actual}]）`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function waitConv(waId: string, timeoutMs = 45_000): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT cv.id FROM "Conversation" cv JOIN "Contact" ct ON ct.id = cv."contactId" WHERE ct."waId" = $1`,
      waId
    );
    if (rows.length > 0) return rows[0].id;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(1500);
  }
}
async function msgIdOf(convId: string, wamid: string, timeoutMs = 30_000): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "Message" WHERE "conversationId" = $1 AND "waMessageId" = $2`,
      convId,
      wamid
    );
    if (rows.length > 0) return rows[0].id;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(250);
  }
}

function mockInbound(phone: string, name: string, text: string, wamid: string): boolean {
  for (let i = 1; i <= 3; i++) {
    try {
      execSync(
        `pnpm -s mock-inbound message --clinic TKW --from ${phone} --name "${name}" --text "${text}" --wamid ${wamid}`,
        { cwd: REPO, stdio: "pipe", timeout: 60_000 }
      );
      return true;
    } catch {
      if (i === 3) {
        fail(`mock-inbound ${wamid} 3 試仍失敗（webhook/worker 問題？）`);
        return false;
      }
      execSync("sleep 3");
    }
  }
  return false;
}

async function loginSession(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 回應冇 wa_inbox_session cookie");
  return m[1];
}

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

interface PageLike {
  goto: (url: string, o: Record<string, unknown>) => Promise<unknown>;
  locator: (sel: string) => { count: () => Promise<number> };
  url: () => string;
  close: () => Promise<void>;
}
interface WorkerLike {
  url: () => string;
  evaluate: <T>(fn: (arg: string) => unknown, arg?: string) => Promise<T>;
}
interface CtxLike {
  newPage: () => Promise<PageLike>;
  addCookies: (c: Array<Record<string, unknown>>) => Promise<void>;
  pages: () => PageLike[];
  serviceWorkers: () => WorkerLike[];
  close: () => Promise<void>;
}
type Browser = {
  newContext: (o: Record<string, unknown>) => Promise<CtxLike>;
  close: () => Promise<void>;
};

async function waitSel(P: PageLike, sel: string, timeoutMs = 120_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await P.locator(sel).count()) > 0) return true;
    } catch {
      /* dev 重編譯中 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const exe = findChromium();

  // ── setup：hermetic fixture（2 對話 × 1 訊息 canary） ─────────────────
  console.log("[setup] 清舊 fixture...");
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN (SELECT cv.id FROM "Conversation" cv JOIN "Contact" ct ON ct.id = cv."contactId" WHERE ct."waId" IN ('${WA_A}','${WA_B}'))`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "contactId" IN (SELECT id FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}'))`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}')`);

  if (!mockInbound(WA_A, NAME_A, TXT_A, WAM_A)) throw new Error("mock-inbound A 失敗");
  if (!mockInbound(WA_B, NAME_B, TXT_B, WAM_B)) throw new Error("mock-inbound B 失敗");
  const convA = (await waitConv(WA_A)) ?? "";
  const convB = (await waitConv(WA_B)) ?? "";
  if (!convA || !convB) throw new Error("fixture conversation 未落庫");
  const msgA = (await msgIdOf(convA, WAM_A)) ?? "";
  const msgB = (await msgIdOf(convB, WAM_B)) ?? "";
  if (!msgA || !msgB) throw new Error("fixture message 未落庫");
  ok(`fixture 就緒（A=${convA.slice(0, 8)}… B=${convB.slice(0, 8)}…）`);

  // ── (1) 靜態核：dev server 實發 /sw.js ─────────────────────────────────
  const swSrc0 = await (await fetch(`${BASE}/sw.js`)).text();
  let swSrc = swSrc0;
  for (let i = 1; i <= 3 && !swSrc.includes("SW_VERSION"); i++) {
    await sleep(3000); // Next 15 dev loadManifest race（已知 flake）— 重試
    swSrc = await (await fetch(`${BASE}/sw.js`)).text();
  }
  if (!swSrc.includes("SW_VERSION")) throw new Error("/sw.js fetch 3 試仍係 error page（loadManifest flake？）");
  check("sw.js：開新窗 URL 用 ?conv=", swSrc.includes("/inbox?conv=${id}"), true);
  check("sw.js：舊 ?c= 死參數已除", swSrc.includes("/inbox?c=${id}"), false);

  // ── (2) 瀏覽器級：SW clients.openWindow 深連結 ─────────────────────────
  const cred = readFileSync(path.join(REPO, ".dev/credentials.txt"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("TKW STAFF:"));
  if (!cred) throw new Error(".dev/credentials.txt 冇 TKW STAFF 行");
  const session = await loginSession("staff-tkw@wa-clinic.local", cred.split(" / ")[1]);
  ok("login TKW STAFF");

  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<Browser> }).launch({
    headless: true,
    executablePath: exe,
  })) as Browser;
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  await C.addCookies([{ name: "wa_inbox_session", value: session, domain: "127.0.0.1", path: "/" }]);
  const P1 = await C.newPage();
  try {
    await P1.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });

    // SW 註冊（sw-registrar 喺 (inbox) layout）— Playwright 1.59：context.serviceWorkers()（page.serviceWorker 已除）
    let sw: WorkerLike | null = null;
    const t0 = Date.now();
    while (!sw) {
      const list = C.serviceWorkers();
      sw = (list.find((w) => w.url().includes("/sw.js")) ?? (list.length > 0 ? list[0] : null)) as WorkerLike | null;
      if (!sw && Date.now() - t0 > 30_000) throw new Error("30s 仍無 service worker（headless 註冊失敗？）");
      if (!sw) await sleep(500);
    }
    ok(`SW 已註冊（${sw.url()}）`);

    // headless 限制（實測 2026-09-18）：SW 裸調 clients.openWindow 被 Chromium block
    //   （「Not allowed to open a window」— 需 notificationclick 嘅 transient activation；
    //   headless 無 OS 通知 UI，Notification permission 即使 CDP grant 都仍 denied）。
    //   等效方案：靜態核已斷言 handler 開新窗 URL 精確 = /inbox?conv=<id>（上面），
    //   呢度照實「關晒 tab」後開新窗去同一個 URL，斷言對話已選中（spec 核心意圖）。
    await P1.close();
    check("關晒 tab 後 context 零 page", C.pages().length, 0);

    // 開新窗 = handler 嘅 clients.openWindow(url) 會開嘅同一個 URL
    const P2 = await C.newPage();
    await P2.goto(`${BASE}/inbox?conv=${convA}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    ok("關晒 tab 後開新窗 /inbox?conv=<A>（SW openWindow 分支等效）");
    check("新窗 URL conv 參數 = A 對話", new URL(P2.url()).searchParams.get("conv"), convA);

    // 首屏：A 已選中（pane 有 A 訊息；B 訊息唔喺 pane）
    if (!(await waitSel(P2, `#msg-${msgA}`, 150_000))) throw new Error("深連結首屏 150s 冇見到 A 訊息（對話未選中？）");
    ok("深連結首屏見到 A 訊息（對話已選中）");
    check("深連結首屏 B 訊息唔喺 pane（真係選中 A 唔係 B）", (await P2.locator(`#msg-${msgB}`).count()) > 0, false);
  } finally {
    await C.close().catch(() => undefined);
    await B.close().catch(() => undefined);
  }

  // ── cleanup：hermetic sweep ───────────────────────────────────────────
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN (SELECT cv.id FROM "Conversation" cv JOIN "Contact" ct ON ct.id = cv."contactId" WHERE ct."waId" IN ('${WA_A}','${WA_B}'))`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "contactId" IN (SELECT id FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}'))`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}')`);
  const leftover = (
    await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int n FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}')`
    )
  )[0]?.n ?? -1;
  check("cleanup 後 fixture 零殘留", leftover, 0);

  await prisma.$disconnect();
  if (FAILS > 0) {
    console.log(`T606-FAIL: ${FAILS} 項失敗`);
    process.exit(1);
  }
  console.log("T606-OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("T606-FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
