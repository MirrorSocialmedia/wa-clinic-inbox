// T706 — S1-1e（=S1-6）異步回應競態交叉污染：3 場景（send / loadOlder / note）
// 跑法：./node_modules/.bin/tsx scripts/e2e-s11e-t706.ts   （3100 + worker + 15432 需存活）
//
// 每場景 = 用 page.route 將目標請求延遲 3s → 在 pending 期間換到對話 B →
// 斷言 B 嘅 pane 唔含 A 嘅內容；等 delayed 回應落地後再斷一次。
// 舊 code（無 guard / 無 key remount / 無 visible filter）：遲到回應會寫入 B 嘅 state → B pane 見到 A 嘅內容。
import "./e2e-origin-shim";
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import os from "os";
import path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

const prisma = new PrismaClient();
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = process.cwd();
const TS = Date.now();
const WA_A = "62019938";
const WA_B = "62019939";
const NAME_A = `T706-ALPHA-${TS % 100000}`;
const NAME_B = `T706-BETA-${TS % 100000}`;
const MARK_SEND = `T706-SEND-${TS}`;
const MARK_NOTE = `T706-NOTE-${TS}`;
const OLD_PREFIX = `T706OLD-${TS}`; // 55 條 seed 舊訊息 body 前綴
const W_SEED_A = `wamid.t706.seedA.${TS}`;
const W_SEED_B = `wamid.t706.seedB.${TS}`;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function mock(cmd: string): void {
  execSync(`./node_modules/.bin/tsx scripts/mock-inbound.ts ${cmd}`, { timeout: 60000, stdio: "pipe" });
}

function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(baseDir).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try { readFileSync(exe); return exe; } catch { /* next */ }
  }
  throw new Error("chromium binary 搵唔到");
}

function readCredLine(label: string): string {
  const lines = readFileSync(path.join(REPO, ".dev", "credentials.txt"), "utf8").split("\n");
  const l = lines.find((x) => x.startsWith(`${label}:`));
  if (!l) throw new Error(`credentials.txt 冇 ${label}`);
  return l.split(" / ")[1];
}
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 cookie");
  return m[1];
}

interface Route { continue: () => Promise<void>; request: () => { url(): string; method(): string } }
interface Loc {
  count: () => Promise<number>;
  first: () => Loc;
  waitFor: (o: Record<string, unknown>) => Promise<void>;
  click: (o?: Record<string, unknown>) => Promise<void>;
  fill: (t: string) => Promise<void>;
  inputValue: () => Promise<string>;
}
interface Page {
  route: (pattern: string, handler: (r: Route) => Promise<void>) => Promise<void>;
  unroute: (pattern: string) => Promise<void>;
  goto: (u: string, o: Record<string, unknown>) => Promise<void>;
  locator: (s: string, o?: { hasText?: string }) => Loc;
  evaluate: <T>(fn: unknown, arg?: unknown) => Promise<T>;
  close: () => Promise<void>;
}
interface CtxLike { addCookies: (c: { name: string; value: string; domain: string; path: string }[]) => Promise<void>; newPage: () => Promise<Page>; }
interface BrowserLike { newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void>; }

async function main(): Promise<void> {
  console.log(`T706 e2e — base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) { console.error(`T706-ERR server 未 live（status=${probe?.status}）`); process.exit(2); }

  // ── cleanup 舊殘留（冪等）────────────────────────────────────────────────
  const oldConvA = await prisma.$queryRawUnsafe<{ cid: string }[]>(
    `SELECT DISTINCT "conversationId" AS cid FROM "Message" WHERE "waMessageId" LIKE 'wamid.t706.%' OR body LIKE 'T706OLD-%'`
  );
  const cidListA = oldConvA.map((c) => `'${c.cid}'`).join(",");
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "waMessageId" LIKE 'wamid.t706.%' OR body LIKE 'T706OLD-%'`);
  if (cidListA) await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id IN (${cidListA})`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}')`);

  // ── setup：A（55 條舊訊息 → hasMore）+ B（1 條）─────────────────────────
  mock(`message --clinic TY --from ${WA_A} --name "${NAME_A}" --text "t706 seed A" --wamid ${W_SEED_A}`);
  mock(`message --clinic TY --from ${WA_B} --name "${NAME_B}" --text "t706 seed B" --wamid ${W_SEED_B}`);
  // seed 經 webhook → worker 異步落庫：poll 等 conv 建好
  const convRows = await (async () => {
    for (let i = 0; i < 30; i++) {
      const rows = await prisma.$queryRawUnsafe<{ cid: string; wid: string }[]>(
        `SELECT DISTINCT "conversationId" AS cid, "waMessageId" AS wid FROM "Message" WHERE "waMessageId" IN ('${W_SEED_A}','${W_SEED_B}')`
      );
      if (rows.length >= 2) return rows;
      await sleep(1000);
    }
    return [] as { cid: string; wid: string }[];
  })();
  const convA = convRows.find((r) => r.wid === W_SEED_A)?.cid ?? "";
  const convB = convRows.find((r) => r.wid === W_SEED_B)?.cid ?? "";
  if (!convA || !convB) { console.error("T706-ERR conv 未建"); process.exit(2); }
  // A 加 54 條 staggered 舊訊息（55 總 > 50 → hasMore）
  const nowMs = Date.now();
  for (let i = 54; i >= 1; i--) {
    await prisma.message.create({
      data: {
        conversationId: convA,
        waMessageId: `wamid.t706.old${i}.${TS}`,
        direction: "IN",
        channel: "API",
        type: "text",
        body: `${OLD_PREFIX}-${i}`,
        status: "RECEIVED",
        waTimestamp: new Date(nowMs - i * 30_000),
        createdAt: new Date(nowMs - i * 30_000),
      },
    });
  }
  console.log(`  [setup] convA=${convA.slice(0, 8)}…（55 條）convB=${convB.slice(0, 8)}…`);

  // ── browser ─────────────────────────────────────────────────────────────
  const admin = await login("admin@wa-clinic.local", readCredLine("ADMIN"));
  const browser: BrowserLike = await (chromium as { launch: (o: Record<string, unknown>) => Promise<BrowserLike> }).launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "wa_inbox_session", value: admin, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const rowA = page.locator(`button:has-text("${NAME_A}")`).first();
  const rowB = page.locator(`button:has-text("${NAME_B}")`).first();
  await rowA.waitFor({ timeout: 30_000 });
  ok("列表見到 A + B", (await rowB.count()) === 1);

  const msgHas = (mark: string) => page.locator(`[id^="msg-"]:has-text("${mark}")`).count();
  const docHas = (mark: string): Promise<number> => page.evaluate(({ m }: { m: string }) => (document.body.innerText || "").split(m).length - 1, { m: mark });

  // ══ 場景 1：send（optimistic bubble）════════════════════════════════════
  console.log("場景 1：send");
  const SEND_ROUTE = "**/api/messages/send*";
  await page.route(SEND_ROUTE, async (r) => { await sleep(3000); r.continue(); });
  await rowA.click();
  const composer = page.locator('[data-testid="c5-composer"]');
  await composer.waitFor({ timeout: 30_000 });
  await composer.fill(MARK_SEND);
  await page.locator('[data-testid="c5-send-btn"]').click();
  await sleep(600); // pending 中
  await rowB.click();
  await sleep(1500); // B pane 載入
  ok("S1 pending 期間：B pane 無 A 嘅 optimistic 訊息", (await msgHas(MARK_SEND)) === 0, `found=${await msgHas(MARK_SEND)}`);
  await sleep(4500); // delayed 回應落地（guard 應擋）
  ok("S1 delayed 落地後：B pane 仍無 A 訊息", (await msgHas(MARK_SEND)) === 0, `found=${await msgHas(MARK_SEND)}`);
  await page.unroute(SEND_ROUTE);
  const sendRows = await prisma.message.count({ where: { body: MARK_SEND } });
  ok("S1 sanity：send 實際落庫（A）", sendRows === 1, `count=${sendRows}`);

  // ══ 場景 2：loadOlder（keyset page）════════════════════════════════════
  console.log("場景 2：loadOlder");
  const OLD_ROUTE = `**/api/conversations/${convA}/messages*`;
  await page.route(OLD_ROUTE, async (r) => { if (r.request().url().includes("before=")) await sleep(3000); r.continue(); });
  await rowA.click();
  await page.locator('[id^="msg-"]').first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("div.overflow-y-auto")].find((d) => d.querySelector('[id^="msg-"]')) as HTMLElement | undefined;
    if (el) { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); }
  });
  await sleep(500); // loadOlder 請求 pending 中
  await rowB.click();
  await sleep(1500);
  ok("S2 pending 期間：B pane 無 A 舊訊息", (await msgHas(OLD_PREFIX)) === 0, `found=${await msgHas(OLD_PREFIX)}`);
  await sleep(4500); // delayed page 落地（guard 應擋）
  ok("S2 delayed 落地後：B pane 仍無 A 舊訊息", (await msgHas(OLD_PREFIX)) === 0, `found=${await msgHas(OLD_PREFIX)}`);
  await page.unroute(OLD_ROUTE);
  // sanity：返 A 撳一次「載入舊訊息」應該得（beforeId keyset 正常）
  await rowA.click();
  await page.locator('[id^="msg-"]').first().waitFor({ timeout: 30_000 });
  const olderCountBefore: number = await page.evaluate(() => document.querySelectorAll('[id^="msg-"]').length);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("div.overflow-y-auto")].find((d) => d.querySelector('[id^="msg-"]')) as HTMLElement | undefined;
    if (el) { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); }
  });
  await sleep(2500);
  const olderCountAfter: number = await page.evaluate(() => document.querySelectorAll('[id^="msg-"]').length);
  ok("S2 sanity：A 載入舊訊息成功（55 全出）", olderCountAfter >= 55 && olderCountAfter > olderCountBefore, `before=${olderCountBefore} after=${olderCountAfter}`);

  // ══ 場景 3：note（loadNotes 交叉寫入）══════════════════════════════════
  console.log("場景 3：note");
  const NOTE_ROUTE = `**/api/conversations/${convA}/notes*`;
  await page.route(NOTE_ROUTE, async (r) => { if (r.request().method() === "POST") await sleep(3000); r.continue(); });
  const noteInput = page.locator('input[aria-label="新增內部備註"]');
  await noteInput.waitFor({ timeout: 30_000 });
  await noteInput.fill(MARK_NOTE);
  await page.evaluate(() => {
    const inp = document.querySelector('input[aria-label="新增內部備註"]') as HTMLInputElement | null;
    const btn = inp?.parentElement?.querySelector("button") as HTMLButtonElement | null;
    btn?.click();
  });
  await sleep(600); // note POST pending 中
  await rowB.click();
  await sleep(1500);
  ok("S3 pending 期間：B pane 無 A note", (await docHas(MARK_NOTE)) <= 0, `found=${await docHas(MARK_NOTE)}`);
  await sleep(4500); // delayed POST + loadNotes 落地（guard 應擋）
  const noteInB: number = await docHas(MARK_NOTE);
  ok("S3 delayed 落地後：B pane 無 A note", noteInB <= 0, `found=${noteInB}`);
  const noteInputB = await noteInput.inputValue().catch(() => "");
  ok("S3 B 嘅 note draft 乾淨（remount）", noteInputB === "", `draft=${noteInputB}`);
  await page.unroute(NOTE_ROUTE);
  const noteRows = await prisma.message.count({ where: { body: MARK_NOTE, conversationId: convA } });
  ok("S3 sanity：note 實際落庫（A）", noteRows === 1, `count=${noteRows}`);

  await page.close();
  await browser.close();

  // ── cleanup ────────────────────────────────────────────────────────────────
  const cidListB = [`'${convA}'`,`'${convB}'`].join(",");
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "waMessageId" LIKE 'wamid.t706.%' OR body LIKE 'T706OLD-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id IN (${cidListB})`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}')`);
  const residue = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM "Message" WHERE "waMessageId" LIKE 'wamid.t706.%' OR body LIKE 'T706OLD-%'`
  );
  ok("cleanup 零殘留", residue[0].n === 0, `residue=${residue[0].n}`);

  console.log(`\nT706: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("T706-ERR", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
