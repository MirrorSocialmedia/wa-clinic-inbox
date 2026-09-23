/**
 * e2e-s13-t721 — cwi-final S1-13（D-6）T721：composer 改字 → 切換確認
 *
 * 設計（spec S1-13 測試 T721）：
 *  - 獨立 fixture：company E2ES13F-CO + clinic E2ES13F（aiMode DRAFT）+ STAFF K（CLINICS scope 只綁呢店）
 *  - 2 句 mock inbound（真 webhook → worker → AI mock）→ 2 PROPOSED → UI counter 1/2
 *  - composer 手改字（≠ 草稿原文）→ 撳 ›（較舊草稿）→ 出 window.confirm「你改緊嘅內容會被換走，確定切換？」
 *  - **取消** → composer 文字保留（改緊嘅原文）+ index 不變（counter 仍 1/2）+ 兩個 draft 都係 PROPOSED（無副作用）
 *  - 正路兜底（同個 switchDraft 函數嘅 confirm 分支）：再撳 › → 確認 → composer = 第 2 個原文 + counter 2/2
 *
 * 前置：dev stack live（server 3100 + worker AI_MOCK=1 + DB 15432 + Redis）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s13-t721.ts
 * 輸出：T721-OK / T721-FAIL: <reason>（exit 1）
 *
 * PII 鐵律：fixture 全 fake（fake waId 8 位、fake 姓名、固定 mock 文案）— 零真病人資料。
 */
import "./e2e-origin-shim";
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

const COMPANY_CODE = "E2ES13F-CO";
const CLINIC_CODE = "E2ES13F";
const CLINIC_NAME = "E2ES13F 診所";
const EMAIL = "e2e-s13f@wa-clinic.local";
const PASS = "e2e-s13f-pass-2026";
const WA_ID = "90731402"; // fake 8 位（零 PII）
const P_NAME = "E2ES13F P1"; // fake 姓名
const MSGS = [
  "你好，想問下洗牙之後要注意啲咩", // QUESTION 兜底
  "我想預約下星期四", // BOOKING_REQUEST（L1 店 → draft）
];
const EDITED_TEXT = "我改緊緊緊（staff 編輯中）";
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
    create: { code: COMPANY_CODE, name: "E2ES13F CO" },
  });
  const clinic = await prisma.clinic.upsert({
    where: { code: CLINIC_CODE },
    update: { name: CLINIC_NAME, aiMode: "DRAFT" },
    create: {
      companyId: company.id,
      code: CLINIC_CODE,
      name: CLINIC_NAME,
      waPhoneNumberId: "E2ES13F-PH",
      waDisplayNumber: "+852 0000 7140",
      aiMode: "DRAFT",
    },
  });
  await prisma.staffUser.upsert({
    where: { email: EMAIL },
    update: { scopeType: "CLINICS", role: "STAFF", active: true },
    create: {
      email: EMAIL,
      name: "E2ES13F staff",
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
  console.log(`[T721] S1-13 草稿堆疊：改字切換確認（取消保留 / 確認換走）— base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T721-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  const { clinicId } = await seed();
  const cookie = await login();
  console.log("[setup] fixture 就緒（clinic DRAFT + STAFF CLINICS scope）+ login");

  const browser: BrowserLike = await (chromium as { launch: (o: Record<string, unknown>) => Promise<BrowserLike> }).launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();

  // dialog 捕獲（window.confirm → Playwright dialog event；dismiss = 取消）
  const dialogs: string[] = [];
  const dialogWaiter = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (dialogs.length > 0) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          resolve(false);
        }
      }, 100);
    });
  P.on("dialog", (d: unknown) => {
    const dlg = d as { message: () => string; dismiss: () => Promise<void> };
    dialogs.push(dlg.message());
    void dlg.dismiss(); // 一律先「取消」— 確認路徑由第二次 click 重新觸發
  });

  let convId = "";
  try {
    await gotoRetry(P, `${BASE}/inbox`);
    await sleep(3000); // socket 連線 + 列表首載

    // 2 句 inbound → 2 PROPOSED
    for (let i = 0; i < 2; i++) {
      const wamid = `wamid.e2es13f.${TS}.${i + 1}`;
      console.log(`  [inbound ${i + 1}/2] ${wamid}`);
      await mockInbound(MSGS[i], wamid);
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
      await pollDb(`draft ${n}/2 建立（total≥${n}）`, async () => {
        const c = await prisma.aiDraft.count({ where: { conversationId: convId } });
        return c >= n ? true : null;
      });
      await sleep(800);
    }

    const drafts = await prisma.aiDraft.findMany({
      where: { conversationId: convId, status: "PROPOSED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    check("DB 恰 2 PROPOSED", drafts.length === 2, drafts.map((d) => d.id));
    const dNew = drafts[0]; // 最新（index 0）
    const dOld = drafts[1]; // 較舊（index 1 — 開對話時頭一個草稿）

    // UI：卡出現 + counter 1/2 + composer = dOld（開對話時首個草稿 auto-fill；
    // composer 非空唔覆蓋 — dNew 到咗唔會再蓋）
    const card = P.locator('[data-testid="c5-draft-card"]');
    await card.first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    check("草稿卡出現", (await card.count()) === 1, `count=${await card.count()}`);
    const comp = P.locator('[data-testid="c5-composer"]');
    let counterObs = "";
    try {
      await pollDb("UI counter = 1/2", async () => {
        counterObs = (await P.locator('[data-testid="draft-stack-counter"]').textContent().catch(() => null))?.trim() ?? "";
        return counterObs === "1/2" ? true : null;
      }, 30_000);
      ok("UI counter = 1/2");
    } catch {
      fail(`UI counter = 1/2（實際: "${counterObs}"）`);
    }
    let compObs = "";
    try {
      await pollDb("composer auto-fill dOld", async () => {
        compObs = await comp.inputValue().catch(() => "");
        return compObs === dOld.draftText ? true : null;
      }, 15_000);
      ok("composer = 首個草稿（dOld）auto-fill 原文（非空唔覆蓋）");
    } catch {
      fail(`composer = 首個草稿（dOld）auto-fill 原文（實際: "${compObs.slice(0, 60)}"）`);
    }

    // ── 核心：改字 → 撳 › → 確認 dialog → 取消 → 文字保留 + index 不變 ─────
    console.log("\n改字切換確認（取消）：");
    await comp.fill(EDITED_TEXT);
    check("composer 已改字", (await comp.inputValue()) === EDITED_TEXT, (await comp.inputValue()).slice(0, 40));
    dialogs.length = 0;
    await P.locator('[data-testid="draft-stack-nav"] button[aria-label="較舊草稿"]').click({ timeout: 10_000 });
    const dialogShown = await dialogWaiter(10_000);
    check("改字後撳 › → 出確認 dialog", dialogShown, `dialogs=${JSON.stringify(dialogs)}`);
    check(
      "dialog 文案 = 「你改緊嘅內容會被換走，確定切換？」",
      dialogs.some((m) => m.includes("你改緊嘅內容會被換走，確定切換？")),
      JSON.stringify(dialogs)
    );
    // dismiss 已喺 handler 即刻行（= 取消）— 等 microtask 落地
    await sleep(500);
    check("取消後 composer 文字保留（改緊嘅原文）", (await comp.inputValue()) === EDITED_TEXT, (await comp.inputValue()).slice(0, 40));
    const counterAfterCancel = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    check("取消後 index 不變（counter 仍 1/2）", counterAfterCancel === "1/2", counterAfterCancel);

    // ── 正路兜底：再撳 › → 確認（accept）→ 換走 + counter 2/2 ──────────────
    console.log("\n確認路徑（accept）：");
    // Playwright 無原生 accept — 用 evaluate 替 window.confirm 回 true，再 click 觸發
    await P.evaluate(() => {
      (window as unknown as { confirm: (msg: string) => boolean }).confirm = (msg: string) => true;
    });
    dialogs.length = 0;
    await P.locator('[data-testid="draft-stack-nav"] button[aria-label="較舊草稿"]').click({ timeout: 10_000 });
    await sleep(800);
    const counterAfterAccept = (await P.locator('[data-testid="draft-stack-counter"]').textContent())?.trim();
    check("確認後 index 跳去 2/2", counterAfterAccept === "2/2", counterAfterAccept);
    check("確認後 composer = 第 2 個（dOld）原文（改緊嘅字被換走）", (await comp.inputValue()) === dOld.draftText, (await comp.inputValue()).slice(0, 60));

    // DB 無副作用：兩個 draft 都仍 PROPOSED
    const after = await prisma.aiDraft.findMany({ where: { conversationId: convId }, select: { id: true, status: true } });
    check("切換（取消/確認）後 DB 無副作用（2 PROPOSED）", after.length === 2 && after.every((d) => d.status === "PROPOSED"), after);
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

  console.log(FAILS === 0 ? "\nT721-OK" : `\nT721-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T721-ERR", e instanceof Error ? e.message : e);
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
