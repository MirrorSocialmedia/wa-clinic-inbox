/**
 * e2e-s13-t722 — cwi-final S1-13（D-6）T722：雙建立點並發 → PROPOSED ≤ 3 + draft:expired
 *
 * 設計（spec S1-13 測試 T722）：
 *  - 獨立 fixture：company E2ES13E-CO + clinic E2ES13E（aiMode DRAFT）+ STAFF K
 *    + SkillGroup（enabled、服務該店、K 係成員）+ RoutingRule（keywords ["療程"]、
 *    targetType GROUP、autoReplyTemplate）→ 命中 = routing.marked（組標記，唔需要當值）。
 *  - prefill 3 句（無「療程」— 唔命中規則、唔消耗 R-7 原子閘）→ 3 PROPOSED → UI counter /3
 *  - **並發 pair**：兩句含「療程」嘅 IN 同時 mock webhook（同一對話）：
 *      建立點 ① = pipeline AI 草稿（createDraft）
 *      建立點 ② = R-7 療程首覆（applyRoutingFirstReply — 原子閘只俾一個搶到）
 *    兩個 AI job 並行 → capDraftStack advisory lock 串行收窄 →
 *    最終 PROPOSED = 恰 3（新 3 個）+ EXPIRED = 恰 2（最舊 2 個）
 *  - client（socket probe + browser UI）：收齊 2× draft:ready + draft:expired（覆蓋 2 個 EXPIRED id）
 *    → UI 堆疊卡片數 = 3（counter 分母 /3）
 *
 * 前置：dev stack live（server 3100 + worker AI_MOCK=1 + DB 15432 + Redis）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s13-t722.ts
 * 輸出：T722-OK / T722-FAIL: <reason>（exit 1）
 *
 * PII 鐵律：fixture 全 fake（fake waId 8 位、fake 姓名、固定 mock 文案）— 零真病人資料。
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};
const { io } = require("socket.io-client") as {
  io: (url: string, o: Record<string, unknown>) => {
    on: (e: string, cb: (...a: never[]) => void) => void;
    close: () => void;
  };
};
const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES13E-CO";
const CLINIC_CODE = "E2ES13E";
const CLINIC_NAME = "E2ES13E 診所";
const EMAIL = "e2e-s13e@wa-clinic.local";
const PASS = "e2e-s13e-pass-2026";
const WA_ID = "90731403"; // fake 8 位（零 PII）
const P_NAME = "E2ES13E P1"; // fake 姓名
const GROUP_CODE = "E2ES13EG1";
const RULE_NAME = "E2ES13E 療程規則";
const R7_TEMPLATE = "多謝你嘅查詢！療程安排會由專門人員跟進，請稍候。";
// prefill（無「療程」→ 唔命中規則）
const PREFILL = [
  "你好，想問下洗牙之後要注意啲咩", // QUESTION
  "我想預約下星期四", // BOOKING_REQUEST
  "今日支股票會唔會跌", // OUT_OF_SCOPE
];
// 並發 pair（含「療程」→ 命中規則；兩個建立點：R-7 首覆 + pipeline AI 草稿）
const PAIR_A = "想問下咩療程适合我";
const PAIR_B = "療程大概要幾耐先至好";
const TS = Date.now();

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(`${label}${detail !== undefined ? `（${JSON.stringify(detail).slice(0, 300)}）` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

const WAMIDS: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "StaffNotice" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "entity" = 'Conversation' AND "entityId" IN (SELECT id FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AiDraft" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  if (WAMIDS.length > 0) {
    const list = WAMIDS.map((w) => `'${w}'`).join(",");
    await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEvent" WHERE id IN (${list})`);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM "RoutingRule" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SkillGroupClinic" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SkillGroupMember" WHERE "groupId" IN (SELECT id FROM "SkillGroup" WHERE code = '${GROUP_CODE}')`);
  await prisma.skillGroup.deleteMany({ where: { code: GROUP_CODE } });
  await prisma.contact.deleteMany({ where: { waId: WA_ID } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<{ clinicId: string; staffId: string; groupId: string; ruleId: string }> {
  const company = await prisma.company.upsert({
    where: { code: COMPANY_CODE },
    update: {},
    create: { code: COMPANY_CODE, name: "E2ES13E CO" },
  });
  const clinic = await prisma.clinic.upsert({
    where: { code: CLINIC_CODE },
    update: { name: CLINIC_NAME, aiMode: "DRAFT" },
    create: {
      companyId: company.id,
      code: CLINIC_CODE,
      name: CLINIC_NAME,
      waPhoneNumberId: "E2ES13E-PH",
      waDisplayNumber: "+852 0000 7141",
      aiMode: "DRAFT",
    },
  });
  const staff = await prisma.staffUser.upsert({
    where: { email: EMAIL },
    update: { scopeType: "CLINICS", role: "STAFF", active: true },
    create: {
      email: EMAIL,
      name: "E2ES13E staff",
      role: "STAFF",
      scopeType: "CLINICS",
      passwordHash: await argon2.hash(PASS),
      active: true,
    },
  });
  await prisma.staffClinic.upsert({
    where: { staffId_clinicId: { staffId: staff.id, clinicId: clinic.id } },
    update: {},
    create: { staffId: staff.id, clinicId: clinic.id, isPrimary: true },
  });
  // 技能組（enabled + 服務該店 + K 係成員）→ GROUP 標記（唔需要當值 → marked=true）
  const group = await prisma.skillGroup.upsert({
    where: { code: GROUP_CODE },
    update: { enabled: true },
    create: { code: GROUP_CODE, name: "E2ES13E 療程組", enabled: true },
  });
  await prisma.skillGroupMember.create({ data: { groupId: group.id, staffId: staff.id } }).catch(() => undefined);
  await prisma.skillGroupClinic.create({ data: { groupId: group.id, clinicId: clinic.id } }).catch(() => undefined);
  // 規則：keywords ["療程"]（intents 空 = 唔限）、GROUP 目標、R-7 template
  const existingRule = await prisma.routingRule.findFirst({ where: { clinicId: clinic.id, name: RULE_NAME } });
  const rule =
    existingRule ??
    (await prisma.routingRule.create({
      data: {
        clinicId: clinic.id,
        name: RULE_NAME,
        priority: 10,
        enabled: true,
        intents: [],
        keywords: ["療程"],
        treatmentTypes: [],
        targetType: "GROUP",
        targetGroupId: group.id,
        autoReplyTemplate: R7_TEMPLATE,
      },
    }));
  return { clinicId: clinic.id, staffId: staff.id, groupId: group.id, ruleId: rule.id };
}

async function login(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (res.status === 429) {
      console.log(`  [login] 429 限流 — 等 65s 重試（${attempt}/3）`);
      await sleep(65_000);
      continue;
    }
    if (res.status !== 200) throw new Error(`login ${EMAIL} → ${res.status}`);
    const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
    if (!m) throw new Error("login 冇 wa_inbox_session cookie");
    return m[1];
  }
  throw new Error("login 3 次都 429");
}

/** mock inbound（真 webhook 路徑）— spawn pnpm CLI。 */
function mockInbound(text: string, wamid: string): Promise<void> {
  WAMIDS.push(wamid);
  return new Promise((resolve, reject) => {
    const c = spawn("pnpm", ["-s", "mock-inbound", "message", "--clinic", CLINIC_CODE, "--from", WA_ID, "--text", text, "--wamid", wamid, "--name", P_NAME], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mock-inbound exit ${code}: ${err.slice(0, 300)}`))));
  });
}

async function pollDb<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 45_000, intervalMs = 500): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    let v: T | null = null;
    try {
      v = await fn();
    } catch (e) {
      console.log(`    [poll ${what}] transient: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
    }
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`poll timeout: ${what}`);
    await sleep(intervalMs);
  }
}

interface DraftRow {
  id: string;
  status: string;
  model: string;
  draftText: string;
  inReplyToMessageId: string;
}

// ── playwright 最小型別 ─────────────────────────────────────────────────
interface Route {
  continue: () => Promise<void>;
  request: () => { url(): string };
}
interface Loc {
  count: () => Promise<number>;
  first: () => Loc;
  click: (o?: Record<string, unknown>) => Promise<void>;
  fill: (v: string) => Promise<void>;
  inputValue: () => Promise<string>;
  textContent: () => Promise<string | null>;
  isVisible: () => Promise<boolean>;
  waitFor: (o: Record<string, unknown>) => Promise<void>;
}
interface Page {
  route: (pattern: string, handler: (r: Route) => Promise<void>) => Promise<void>;
  goto: (u: string, o: Record<string, unknown>) => Promise<void>;
  locator: (s: string, o?: { hasText?: string }) => Loc;
  evaluate: <T>(fn: unknown, arg?: unknown) => Promise<T>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  close: () => Promise<void>;
}
interface CtxLike {
  addCookies: (c: { name: string; value: string; domain: string; path: string }[]) => Promise<void>;
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
}
interface BrowserLike {
  newContext: (o: Record<string, unknown>) => Promise<CtxLike>;
  close: () => Promise<void>;
}

function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = fsReaddir(baseDir).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到");
}
const fsReaddir = (d: string): string[] => readdirSync(d);

/** Next 15 dev loadManifest race（已知 flake — TOOLS.md）：error page 偵測 + reload 重試。 */
async function gotoRetry(P: Page, url: string, maxTries = 3): Promise<void> {
  for (let i = 1; i <= maxTries; i++) {
    await P.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const errPage = await P.evaluate(() => /Internal Server Error/.test(document.body?.innerText ?? "")) as boolean;
    if (!errPage) return;
    console.log(`  [page flake] error page（loadManifest race？）— reload ${i}/${maxTries}`);
    await sleep(2000);
  }
  throw new Error("3 次 reload 仍 error page（loadManifest race 未癒）");
}

async function main(): Promise<void> {
  console.log(`[T722] S1-13 草稿堆疊：雙建立點並發（pipeline + R-7）→ PROPOSED ≤ 3 + draft:expired — base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T722-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  const { clinicId } = await seed();
  const cookie = await login();
  console.log("[setup] fixture 就緒（clinic DRAFT + 組 + 療程規則 R-7 template）+ login");

  // ── socket probe：client 收事件驗證（同 T712 口徑 — websocket + session cookie）──
  const readyIds: string[] = [];
  const expiredIds: string[] = [];
  let convIdFromEvent = "";
  const socket = io(BASE, {
    transports: ["websocket"],
    extraHeaders: { Cookie: `wa_inbox_session=${cookie}` },
    timeout: 8000,
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (err: { message: string }) => reject(new Error(`socket connect_error: ${err.message}`)));
    setTimeout(() => reject(new Error("socket connect timeout")), 10_000);
  });
  socket.on("draft:ready", (p: { conversationId: string; draftId: string }) => {
    readyIds.push(p.draftId);
    convIdFromEvent = p.conversationId;
  });
  socket.on("draft:expired", (p: { conversationId: string; draftIds: string[] }) => {
    convIdFromEvent = convIdFromEvent || p.conversationId;
    for (const id of p.draftIds ?? []) expiredIds.push(id);
  });

  // ── 瀏覽器開住 /inbox（UI 堆疊卡片數驗證）────────────────────────────────
  const browser: BrowserLike = await (chromium as { launch: (o: Record<string, unknown>) => Promise<BrowserLike> }).launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();
  let convId = "";
  try {
    await gotoRetry(P, `${BASE}/inbox`);
    await sleep(3000); // socket 連線 + 列表首載

    // ── prefill 3 句（無「療程」）→ 3 PROPOSED ──────────────────────────────
    for (let i = 0; i < 3; i++) {
      const wamid = `wamid.e2es13e.${TS}.p${i + 1}`;
      console.log(`  [prefill ${i + 1}/3] ${wamid}`);
      await mockInbound(PREFILL[i], wamid);
      if (i === 0) {
        convId = await pollDb("conversation 建立", async () => {
          const c = await prisma.conversation.findFirst({ where: { clinicId }, select: { id: true } });
          return c ? c.id : null;
        });
        console.log(`  conv=${convId}`);
        const row = P.locator(`button:has-text("${P_NAME}")`).first();
        let opened = false;
        for (let round = 1; round <= 3 && !opened; round++) {
          if ((await row.count().catch(() => 0)) > 0) {
            try {
              await row.click({ timeout: 10_000 });
              opened = true;
            } catch {
              /* 换深鏈路 */
            }
          }
          if (!opened) {
            await gotoRetry(P, `${BASE}/inbox?conv=${convId}`);
            opened = true;
          }
          await sleep(1500);
        }
      }
      const n = i + 1;
      await pollDb(`prefill draft ${n}/3 建立（total≥${n}）`, async () => {
        const c = await prisma.aiDraft.count({ where: { conversationId: convId } });
        return c >= n ? true : null;
      });
      await sleep(800);
    }

    // UI baseline：counter /3
    const card = P.locator('[data-testid="c5-draft-card"]');
    await card.first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    await pollDb("UI baseline counter = x/3", async () => {
      const t = await P.locator('[data-testid="draft-stack-counter"]').textContent().catch(() => null);
      return t && /\/3$/.test(t.trim()) ? true : null;
    }, 30_000);
    ok(`UI baseline counter = /3（conv=${convId.slice(0, 12)}…）`);

    // ── 並發 pair：兩句含「療程」同時發（兩個建立點）────────────────────────
    console.log("\n並發 pair（pipeline + R-7）：");
    const wamidA = `wamid.e2es13e.${TS}.A`;
    const wamidB = `wamid.e2es13e.${TS}.B`;
    await Promise.all([mockInbound(PAIR_A, wamidA), mockInbound(PAIR_B, wamidB)]);

    // 等 DB settled：total=5、PROPOSED=3、EXPIRED=2（cap 冪等收窄 — 最終態確定性）
    const settled = await pollDb(
      "DB settled（5 total / 3 PROPOSED / 2 EXPIRED）",
      async () => {
        const rows = await prisma.$queryRawUnsafe<{ st: string; n: number }[]>(
          `SELECT status AS st, COUNT(*)::int AS n FROM "AiDraft" WHERE "conversationId" = '${convId}' GROUP BY status`
        );
        const p = rows.find((r) => r.st === "PROPOSED")?.n ?? 0;
        const e = rows.find((r) => r.st === "EXPIRED")?.n ?? 0;
        return p === 3 && e === 2 && rows.reduce((s, r) => s + r.n, 0) === 5 ? rows : null;
      },
      60_000
    );
    const cProp = settled.find((r) => r.st === "PROPOSED")?.n ?? 0;
    const cExp = settled.find((r) => r.st === "EXPIRED")?.n ?? 0;
    console.log("\nDB 斷言：");
    check("最終 PROPOSED = 恰 3（≤ 3 上限）", cProp === 3, settled);
    check("最終 EXPIRED = 恰 2（最舊 2 個被擠）", cExp === 2, settled);

    // pair 兩條 IN message id
    const msgA = (await prisma.message.findFirst({ where: { conversationId: convId, waMessageId: wamidA }, select: { id: true } }))!;
    const msgB = (await prisma.message.findFirst({ where: { conversationId: convId, waMessageId: wamidB }, select: { id: true } }))!;
    check("pair 兩條 IN 都落庫", !!msgA && !!msgB, { msgA: msgA?.id, msgB: msgB?.id });

    const all = await prisma.aiDraft.findMany({ where: { conversationId: convId } });
    const pairDrafts = all.filter((d) => d.inReplyToMessageId === msgA.id || d.inReplyToMessageId === msgB.id);
    check("pair 恰 2 個草稿（每條 IN 一個）", pairDrafts.length === 2, pairDrafts.map((d) => ({ id: d.id, model: d.model, inReply: d.inReplyToMessageId.slice(0, 12) })));
    const r7 = pairDrafts.filter((d) => d.model === "routing-r7");
    const ai = pairDrafts.filter((d) => d.model !== "routing-r7");
    check("恰 1 個 R-7 首覆草稿（原子閘 — 兩個建立點之一）", r7.length === 1, pairDrafts.map((d) => d.model));
    check("恰 1 個 pipeline AI 草稿（另一建立點）", ai.length === 1, pairDrafts.map((d) => d.model));
    check("R-7 草稿 = 規則 template 原文", r7[0]?.draftText === R7_TEMPLATE, r7[0]?.draftText?.slice(0, 40));
    const replied = pairDrafts.map((d) => d.inReplyToMessageId).sort();
    check("R-7 同 AI 草稿針對**兩條唔同 IN**", replied[0] !== replied[1], replied.map((s) => s.slice(0, 12)));
    const expiredRows = all.filter((d) => d.status === "EXPIRED");
    const prefillDrafts = all
      .filter((d) => d.inReplyToMessageId !== msgA.id && d.inReplyToMessageId !== msgB.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()); // 最舊 → 最新
    const oldest2 = prefillDrafts.slice(0, 2).map((d) => d.id).sort();
    check("EXPIRED = 最舊 2 個 prefill 草稿", expiredRows.map((d) => d.id).sort().join(",") === oldest2.join(","), { expired: expiredRows.map((d) => d.id).sort(), oldest2 });
    check("pair 兩個草稿都仍 PROPOSED", pairDrafts.every((d) => d.status === "PROPOSED"), pairDrafts.map((d) => d.status));

    // ── client 收事件：probe 收齊 2× draft:ready（pair）+ draft:expired（覆蓋 2 EXPIRED）──
    console.log("\nclient 事件斷言（socket probe）：");
    await pollDb("probe 收齊 pair 2× draft:ready", async () => {
      return pairDrafts.every((d) => readyIds.includes(d.id)) ? true : null;
    }, 30_000);
    ok(`probe 收齊 pair draft:ready（ready=${readyIds.length}）`);
    await pollDb("probe 收齊 draft:expired（覆蓋 2 個 EXPIRED id）", async () => {
      return expiredRows.every((d) => expiredIds.includes(d.id)) ? true : null;
    }, 30_000);
    ok(`probe 收齊 draft:expired（expired=${expiredIds.join(",")}）`);
    check("draft:expired 事件 conversationId 正確", convIdFromEvent === convId, convIdFromEvent);

    // ── UI：client 堆疊卡片數 = 3（counter 分母 /3 — 事件處理後穩定態）──────
    console.log("\nUI 斷言：");
    await sleep(1500); // 事件落地（probe 同 browser 同一 fanout — probe 收齊 = browser 必收齊）
    const counterAfter = await pollDb("UI counter 收復 /3（卡片數 = 3）", async () => {
      const t = await P.locator('[data-testid="draft-stack-counter"]').textContent().catch(() => null);
      return t && /\/3$/.test(t.trim()) ? true : null;
    }, 20_000);
    void counterAfter;
    const c1 = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    await sleep(2000); // 穩定窗（防 transient /3 誤判 — 事件全落地後唔會再變）
    const c2 = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    check("client 堆疊卡片數 = 3（counter 分母 /3 穩定）", c1 === c2 && /\/3$/.test(c1 ?? ""), { first: c1, second: c2 });
  } finally {
    socket.close();
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  // ── cleanup + 零殘留 ──────────────────────────────────────────────────────
  await cleanup();
  const residue = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))
      + (SELECT COUNT(*) FROM "Contact" WHERE "waId" = '${WA_ID}')
      + (SELECT COUNT(*) FROM "StaffUser" WHERE email = '${EMAIL}')
      + (SELECT COUNT(*) FROM "Clinic" WHERE code = '${CLINIC_CODE}')
      + (SELECT COUNT(*) FROM "Company" WHERE code = '${COMPANY_CODE}')
      + (SELECT COUNT(*) FROM "RoutingRule" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))
      + (SELECT COUNT(*) FROM "SkillGroup" WHERE code = '${GROUP_CODE}')
      + (SELECT COUNT(*) FROM "SkillGroupClinic" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))
      + (SELECT COUNT(*) FROM "SkillGroupMember" WHERE "staffId" = (SELECT id FROM "StaffUser" WHERE email = '${EMAIL}'))
      + (SELECT COUNT(*) FROM "StaffNotice" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))
      + (SELECT COUNT(*) FROM "WebhookEvent" WHERE id IN (${WAMIDS.map((w) => `'${w}'`).join(",") || "''"})) AS n`
  );
  check("cleanup 零殘留", Number(residue[0]?.n ?? -1) === 0, `residue=${residue[0]?.n}`);

  console.log(FAILS === 0 ? "\nT722-OK" : `\nT722-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T722-ERR", e instanceof Error ? e.message : e);
    process.exit(2);
  })
  .finally(async () => {
    try {
      await cleanup(); // 崩潰後兜底
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
  });
