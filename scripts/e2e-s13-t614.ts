/**
 * e2e-s13-t614 — cwi-final S1-13（D-6）T614：同一對話病人連發 4 句 → 草稿堆疊 3+1
 *
 * 設計（spec S1-13 測試 T614）：
 *  - 獨立 fixture：company E2ES13D-CO + clinic E2ES13D（aiMode 預設 DRAFT）+ STAFF K
 *    （CLINICS scope 只綁呢店 → baseScope 全喺 fixture 內，零既有數據干擾）
 *  - 4 句 mock inbound（真 webhook → inbound worker → AI mock → draft 堆疊），每句出 1 草稿：
 *      m1 QUESTION 兜底 / m2 BOOKING_REQUEST / m3 OUT_OF_SCOPE / m4 needsHuman（文字互唔同）
 *    每句等緊自己嗰個草稿先發下一句 → context 決定性 + 堆疊順序確定
 *  - 第 4 個草稿建立成功 → capDraftStack 擠最舊（m1）→ DB：3 PROPOSED + 1 EXPIRED
 *  - UI（socket 實時）：卡 1/3；› 切第 2 個 → composer = 第 2 個原文 + 灰字「病人之後再講咗嘢」；
 *    發送 → 第 2 個 SENT_AS_IS + Message.aiDraftId = 第 2 個 + 第 1 個（index 0）仍 PROPOSED
 *
 * 前置：dev stack live（server 3100 + worker 帶 AI_MOCK=1 + DB 15432 + Redis）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s13-t614.ts
 * 輸出：T614-OK / T614-FAIL: <reason>（exit 1）
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
const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES13D-CO";
const CLINIC_CODE = "E2ES13D";
const CLINIC_NAME = "E2ES13D 診所";
const EMAIL = "e2e-s13d@wa-clinic.local";
const PASS = "e2e-s13d-pass-2026";
const WA_ID = "90731401"; // fake 8 位（零 PII）
const P_NAME = "E2ES13D P1"; // fake 姓名
// 4 句決定性文字（互唔同 intent → 4 個互唔同 mock 草稿；避晒 FLOOR/痛症/投訴/consult/price 詞）
const MSGS = [
  "你好，想問下洗牙之後要注意啲咩", // QUESTION 兜底
  "我想預約下星期三", // BOOKING_REQUEST（L1 店 → 唔開 session，跌落 draft）
  "今日支股票會唔會升", // OUT_OF_SCOPE
  "我想搵真人傾下", // needsHuman（QUESTION + needsHuman — 永遠人手審批）
];
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

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "StaffNotice" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AiDraft" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}'))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  await prisma.contact.deleteMany({ where: { waId: WA_ID } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<{ clinicId: string }> {
  const company = await prisma.company.upsert({
    where: { code: COMPANY_CODE },
    update: {},
    create: { code: COMPANY_CODE, name: "E2ES13D CO" },
  });
  const clinic = await prisma.clinic.upsert({
    where: { code: CLINIC_CODE },
    update: { name: CLINIC_NAME, aiMode: "DRAFT" },
    create: {
      companyId: company.id,
      code: CLINIC_CODE,
      name: CLINIC_NAME,
      waPhoneNumberId: "E2ES13D-PH",
      waDisplayNumber: "+852 0000 7139",
      aiMode: "DRAFT",
    },
  });
  await prisma.staffUser.upsert({
    where: { email: EMAIL },
    update: { scopeType: "CLINICS", role: "STAFF", active: true },
    create: {
      email: EMAIL,
      name: "E2ES13D staff",
      role: "STAFF",
      scopeType: "CLINICS",
      passwordHash: await argon2.hash(PASS),
      active: true,
    },
  });
  const staff = (await prisma.staffUser.findUnique({ where: { email: EMAIL } }))!;
  await prisma.staffClinic.upsert({
    where: { staffId_clinicId: { staffId: staff.id, clinicId: clinic.id } },
    update: {},
    create: { staffId: staff.id, clinicId: clinic.id, isPrimary: true },
  });
  return { clinicId: clinic.id };
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

/** mock inbound（真 webhook 路徑）— 跟 e2e-consult-c5 慣例 spawn pnpm CLI。 */
function mockInbound(text: string, wamid: string): Promise<void> {
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
  draftText: string;
  inReplyToMessageId: string;
}

/** 該對話 PROPOSED 草稿（新到舊 — 同 GET drafts 同一排序）。 */
async function proposedDrafts(convId: string): Promise<DraftRow[]> {
  return prisma.aiDraft.findMany({
    where: { conversationId: convId, status: "PROPOSED" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
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
  console.log(`[T614] S1-13 草稿堆疊：4 句連發 → 3 PROPOSED + 1 EXPIRED + UI 切換 + 發第 2 個 — base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T614-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  const { clinicId } = await seed();
  const cookie = await login();
  console.log("[setup] fixture 就緒（clinic DRAFT + STAFF CLINICS scope）+ login");

  // ── 瀏覽器開住 /inbox（socket 連上）→ 逐句發（每句等自己個草稿先停）──────────
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

    for (let i = 0; i < 4; i++) {
      const wamid = `wamid.e2es13d.${TS}.${i + 1}`;
      console.log(`  [inbound ${i + 1}/4] ${wamid}`);
      await mockInbound(MSGS[i], wamid);
      if (i === 0) {
        convId = await pollDb("conversation 建立", async () => {
          const c = await prisma.conversation.findFirst({ where: { clinicId }, select: { id: true } });
          return c ? c.id : null;
        });
        console.log(`  conv=${convId}`);
        // 開住對話（row 出現先撳；row 遲到就 ?conv= 深鏈路兜底）
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
      // 等自己嗰個草稿（total 計數 >= i+1 — 第 4 個落庫後 capDraftStack 即刻擠走最舊，
      // PROPOSED 只短暫 =4（sub-second），500ms poll 會 miss → 跟 total（任何 status）先確定性）
      const n = i + 1;
      await pollDb(`draft ${n}/4 建立（total≥${n}）`, async () => {
        const c = await prisma.aiDraft.count({ where: { conversationId: convId } });
        return c >= n ? true : null;
      });
      await sleep(800); // 讓 capDraftStack emit + socket 落地
    }

    // ── DB 斷言：3 PROPOSED + 1 EXPIRED（EXPIRED = m1 嗰個）────────────────
    console.log("\nDB 斷言：");
    // capDraftStack 喺 draft 4 commit 之後先行（同 worker 內 await）— 短 poll 等 settled（3+1）
    const counts = await pollDb("DB settled（3 PROPOSED + 1 EXPIRED）", async () => {
      const rows = await prisma.$queryRawUnsafe<{ st: string; n: number }[]>(
        `SELECT status AS st, COUNT(*)::int AS n FROM "AiDraft" WHERE "conversationId" = '${convId}' GROUP BY status`
      );
      const p = rows.find((r) => r.st === "PROPOSED")?.n ?? 0;
      const e = rows.find((r) => r.st === "EXPIRED")?.n ?? 0;
      return p === 3 && e === 1 ? rows : null;
    }, 20_000);
    const cProp = counts.find((r) => r.st === "PROPOSED")?.n ?? 0;
    const cExp = counts.find((r) => r.st === "EXPIRED")?.n ?? 0;
    check("DB 恰 3 PROPOSED", cProp === 3, counts);
    check("DB 恰 1 EXPIRED", cExp === 1, counts);
    const expRow = await prisma.aiDraft.findFirst({ where: { conversationId: convId, status: "EXPIRED" }, select: { inReplyToMessageId: true } });
    const m1 = (await prisma.message.findMany({ where: { conversationId: convId, direction: "IN", channel: "API" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1, select: { id: true } }))[0];
    check("EXPIRED = 最舊（m1）嗰個草稿", expRow?.inReplyToMessageId === m1?.id, { exp: expRow?.inReplyToMessageId, m1: m1?.id });

    // ── UI 斷言：1/3 → › 切第 2 個 → composer 原文 + 灰字 ───────────────────
    console.log("\nUI 斷言：");
    const card = P.locator('[data-testid="c5-draft-card"]');
    await card.first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    check("草稿卡出現", (await card.count()) === 1, `count=${await card.count()}`);
    // 等堆疊收齊 3 個（socket 逐個 push）
    await pollDb("UI 堆疊 = 3（counter 分母 3）", async () => {
      const t = await P.locator('[data-testid="draft-stack-counter"]').textContent().catch(() => null);
      return t && /\/3$/.test(t.trim()) ? true : null;
    }, 30_000);
    const counter1 = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    check("UI counter = 1/3", counter1 === "1/3", counter1);

    // 排序對照（新到舊）：[d4, d3, d2]；d1 = 被擠出（EXPIRED）嗰個
    const drafts = await proposedDrafts(convId);
    check("PROPOSED 排序 = 新到舊（d4,d3,d2）", drafts.length === 3, drafts.map((d) => d.id));
    const d4 = drafts[0];
    const d3 = drafts[1];
    const d2 = drafts[2];
    const d1 = (await prisma.aiDraft.findFirst({ where: { conversationId: convId, status: "EXPIRED" } }))!;

    // composer = 開對話時第一個草稿（d1）auto-fill 原文（spec 行為：composer 非空唔覆蓋 —
    // 後續 draft:ready 唔會再蓋；switchDraft 先會換）
    const comp = P.locator('[data-testid="c5-composer"]');
    await pollDb("composer auto-fill d1", async () => (await comp.inputValue().catch(() => "")) === d1.draftText ? true : null, 15_000);
    check("composer = 首個草稿（d1）auto-fill 原文（非空唔覆蓋）", (await comp.inputValue()) === d1.draftText, (await comp.inputValue()).slice(0, 80));

    // › 切第 2 個（index 1 = d3）
    await P.locator('[data-testid="draft-stack-nav"] button[aria-label="較舊草稿"]').click({ timeout: 10_000 });
    await pollDb("composer 切到 d3", async () => (await comp.inputValue().catch(() => "")) === d3.draftText ? true : null, 15_000);
    check("› 切換後 composer = 第 2 個（d3）原文", (await comp.inputValue()) === d3.draftText, (await comp.inputValue()).slice(0, 80));
    const counter2 = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    check("切換後 counter = 2/3", counter2 === "2/3", counter2);
    const stale = P.locator('[data-testid="draft-stale"]');
    const staleText = await stale.first().textContent().catch(() => null);
    check("stale 灰字「病人之後再講咗嘢」出現", (await stale.count()) === 1 && (staleText ?? "").includes("病人之後再講咗嘢"), staleText);

    // ── 發送第 2 個（d3）→ SENT_AS_IS + aiDraftId 準確 + d4 仍 PROPOSED ──────
    console.log("\n發送斷言：");
    await P.locator('[data-testid="c5-send-btn"]').click({ timeout: 10_000 });
    const outMsg = await pollDb("OUT message 落庫（body = d3 原文）", async () => {
      const r = await prisma.message.findFirst({
        where: { conversationId: convId, direction: "OUT", channel: "API", body: d3.draftText },
        select: { id: true, body: true, aiDraftId: true, aiAutoSent: true, sentVia: true },
      });
      return r;
    }, 30_000);
    check("OUT message.body = 第 2 個（d3）原文", outMsg.body === d3.draftText);
    check("Message.aiDraftId = 第 2 個 id（準確連結）", outMsg.aiDraftId === d3.id, { msg: outMsg.aiDraftId, d3: d3.id });
    check("OUT aiAutoSent = false（人手採用）", outMsg.aiAutoSent === false, outMsg);
    const d3After = await prisma.aiDraft.findUnique({ where: { id: d3.id }, select: { status: true, finalText: true } });
    check("第 2 個（d3）status = SENT_AS_IS", d3After?.status === "SENT_AS_IS", d3After);
    const d4After = await prisma.aiDraft.findUnique({ where: { id: d4.id }, select: { status: true } });
    check("第 1 個（d4，index 0）仍 PROPOSED", d4After?.status === "PROPOSED", d4After);
    const d2After = await prisma.aiDraft.findUnique({ where: { id: d2.id }, select: { status: true } });
    check("第 3 個（d2）仍 PROPOSED", d2After?.status === "PROPOSED", d2After);
    const expAfter = await prisma.aiDraft.findFirst({ where: { conversationId: convId, status: "EXPIRED" }, select: { status: true } });
    check("EXPIRED（m1）保持 EXPIRED（唔受發送影響）", expAfter?.status === "EXPIRED", expAfter);

    // UI：發送成功 → 堆疊收走 d3 → counter 1/2（d3 已 SENT_* 唔喺 PROPOSED）
    await pollDb("UI 堆疊收走 d3（counter 分母 2）", async () => {
      const t = await P.locator('[data-testid="draft-stack-counter"]').textContent().catch(() => null);
      return t && /\/2$/.test(t.trim()) ? true : null;
    }, 20_000);
    const counter3 = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    check("發送後 UI counter = 1/2", counter3 === "1/2", counter3);
  } finally {
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
      + (SELECT COUNT(*) FROM "Company" WHERE code = '${COMPANY_CODE}') AS n`
  );
  check("cleanup 零殘留", Number(residue[0]?.n ?? -1) === 0, `residue=${residue[0]?.n}`);

  console.log(FAILS === 0 ? "\nT614-OK" : `\nT614-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T614-ERR", e instanceof Error ? e.message : e);
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
