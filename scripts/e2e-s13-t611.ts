/**
 * e2e-s13-t611 — cwi-final S1-3 T611：唔喺列表嘅對話撳入去空白（N-3）
 *
 * 設計（spec S1-3 / 接盤單 #6）：
 *  - 獨立 fixture：company E2ES13-CO + clinic E2ES13-A（自己店）+ E2ES13-B（外店）
 *    + STAFF K（CLINICS 只綁 A）→ K 嘅 baseScope = 只 A（320 條全部喺 fixture 內，零既有數據）
 *  - 320 條 OPEN conv（A）：lastMessageAt 每 60s 遞減、urgent 全 false、一 conv 一 contact
 *    → 排序 = lastMessageAt desc；第一頁 200 條 = i=0..199；「第 300 條」= i=299（唔喺第一頁、
 *      亦唔喺 RESOLVED tail 100 — 全部係 OPEN）
 *  - B 店 1 條 conv + 1 條訊息 = 外店冇權限 case（?ids= 經 baseScope → 空 items，唔係 403）
 *
 * 斷言：
 *   A0 第一頁（200 條）唔含 conv300（「唔喺第一頁」前提）
 *   A1 ?ids=<conv300> → 200 + 恰 1 條（ensureConversationLoaded 路徑）
 *   A2 ?ids=<convB>  → 200 + 空 items（外店 → guard 失敗路徑）
 *   A3 ?contactId=<contact300> → 200 + 恰 1 條 = conv300（contact: 分支改動）
 *   B1 桌面 ?conv=<conv300> → 訊息正常顯示（≥3 條 T611MSG-），非「揀一個對話開始」
 *   B2 桌面 ?conv=<convB>  → notice「呢個對話你冇權限睇或者已經唔存在」（非空白：列表照見）
 *   C1 手機 viewport ?conv=<conv300>（?ids= 延遲 2.5s）→ 載入中 skeleton（data-testid=s13-conv-loading）
 *      + 返回掣；延遲落地後 → 訊息正常顯示、skeleton 收走
 *
 * 前置：dev stack live（server 3100 + DB 15432）。worker 唔影響（fixture 直接 prisma 落庫，零 webhook）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s13-t611.ts
 * 輸出：T611-OK / T611-FAIL: <reason>（exit 1）
 */
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

const COMPANY_CODE = "E2ES13-CO";
const CLINIC_A = "E2ES13-A"; // 自己店
const CLINIC_B = "E2ES13-B"; // 外店（冇權限 case）
const EMAIL = "e2e-s13@wa-clinic.local";
const PASS = "e2e-s13-pass-2026";
const N_OPEN = 320;
const IDX_300 = 299; // 「第 300 條」（1-based）= i=299（0-based）— 排序 = lastMessageAt desc
const WA_PREFIX = "990713";
const RUN = "t611run"; // 固定後綴：id 冪等 + 全部 ≥20 位 lowercase alnum（cuid 形 — normalizeRoute 可過）
const TS = Date.now();
const NOTICE_TEXT = "呢個對話你冇權限睇或者已經唔存在";

const convId = (i: number): string => `e2es13kconv${String(i).padStart(4, "0")}${RUN}`; // 22 位
const contactId = (i: number): string => `e2es13kct${String(i).padStart(4, "0")}${RUN}`; // 22 位
const CONV_300 = convId(IDX_300);
const CONV_B = `e2es13kconvb000${RUN}`;
const CONTACT_B = `e2es13kctb000${RUN}`;

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
  else fail(`${label}${detail !== undefined ? `（${JSON.stringify(detail)}）` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function cleanup(): Promise<void> {
  // 冪等：由 conv 落返去 contact / staff / clinic / company
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Clinic" cl ON cl.id = c."clinicId" WHERE cl.code IN ('${CLINIC_A}','${CLINIC_B}'))`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_A}','${CLINIC_B}'))`
  );
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: { in: [CLINIC_A, CLINIC_B] } } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<{ clinicA: string; clinicB: string }> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES13 CO" } });
  const cA = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_A, name: "E2ES13 Clinic A", waPhoneNumberId: "E2ES13-A-PH", waDisplayNumber: "+852 0000 7131" },
  });
  const cB = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_B, name: "E2ES13 Clinic B", waPhoneNumberId: "E2ES13-B-PH", waDisplayNumber: "+852 0000 7132" },
  });
  const staff = await prisma.staffUser.create({
    data: { email: EMAIL, name: "E2E S13 staff", role: "STAFF", scopeType: "CLINICS", passwordHash: await (await import("argon2")).default.hash(PASS) },
  });
  await prisma.staffClinic.create({ data: { staffId: staff.id, clinicId: cA.id, isPrimary: true } });

  // 321 個 contact（A 320 + B 1），一 conv 一 contact（Conversation @@unique([clinicId, contactId])）
  for (let o = 0; o < N_OPEN + 1; o += 500) {
    const chunk = Array.from({ length: Math.min(500, N_OPEN + 1 - o) }, (_, k) => {
      const c = o + k;
      return {
        id: c === N_OPEN ? CONTACT_B : contactId(c),
        clinicId: c === N_OPEN ? cB.id : cA.id,
        waId: c === N_OPEN ? `${WA_PREFIX}9999` : `${WA_PREFIX}${String(c).padStart(4, "0")}`,
        profileName: c === N_OPEN ? "E2ES13 EXT P9999" : `E2ES13 P${String(c).padStart(4, "0")}`,
        labels: [] as string[],
      };
    });
    await prisma.contact.createMany({ data: chunk });
  }

  // 320 條 OPEN（A）：ts 每 60s 遞減（i 越大越舊）→ 第一頁 200 = i 0..199；第 300 條 = i=299
  const nowMs = Date.now();
  const data = Array.from({ length: N_OPEN }, (_, i) => ({
    id: convId(i),
    clinicId: cA.id,
    contactId: contactId(i),
    status: "OPEN" as const,
    urgent: false,
    lastMessageAt: new Date(nowMs - (i + 1) * 60_000),
  }));
  for (let o = 0; o < data.length; o += 500) {
    await prisma.conversation.createMany({ data: data.slice(o, o + 500) });
  }
  // B 店 1 條（外店 case）
  await prisma.conversation.create({
    data: {
      id: CONV_B,
      clinicId: cB.id,
      contactId: CONTACT_B,
      status: "OPEN",
      urgent: false,
      lastMessageAt: new Date(nowMs - 30_000),
    },
  });

  // conv300：3 條 IN 訊息（「正常顯示訊息」斷言對象）
  for (let n = 1; n <= 3; n++) {
    await prisma.message.create({
      data: {
        conversationId: CONV_300,
        waMessageId: `wamid.t611.c300.${TS}.${n}`,
        direction: "IN",
        channel: "API",
        type: "text",
        body: `T611MSG-${TS}-${n}`,
        status: "RECEIVED",
        waTimestamp: new Date(nowMs - (3 - n) * 60_000),
        createdAt: new Date(nowMs - (3 - n) * 60_000),
      },
    });
  }
  // convB：1 條 IN 訊息（漏出驗證用 — guard 失敗時唔應該有嘢睇）
  await prisma.message.create({
    data: {
      conversationId: CONV_B,
      waMessageId: `wamid.t611.cb.${TS}.1`,
      direction: "IN",
      channel: "API",
      type: "text",
      body: `T611BMSG-${TS}`,
      status: "RECEIVED",
      waTimestamp: new Date(nowMs - 20_000),
      createdAt: new Date(nowMs - 20_000),
    },
  });

  const nA = await prisma.conversation.count({ where: { clinicId: cA.id } });
  check("fixture 落庫 A=320 / B=1", nA === N_OPEN, nA);
  return { clinicA: cA.id, clinicB: cB.id };
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`login ${EMAIL} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}

interface ItemRow {
  id: string;
}

// ── playwright 最小型別（跟 e2e-s11e-t706.ts 慣例）─────────────────────────
interface Route {
  continue: () => Promise<void>;
  request: () => { url(): string };
}
interface Loc {
  count: () => Promise<number>;
  first: () => Loc;
  waitFor: (o: Record<string, unknown>) => Promise<void>;
  isVisible: () => Promise<boolean>;
}
interface Page {
  route: (pattern: string, handler: (r: Route) => Promise<void>) => Promise<void>;
  goto: (u: string, o: Record<string, unknown>) => Promise<void>;
  locator: (s: string, o?: { hasText?: string }) => Loc;
  evaluate: <T>(fn: unknown, arg?: unknown) => Promise<T>;
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
  const os = require("os") as typeof import("os");
  const fs = require("fs") as typeof import("fs");
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = fs.readdirSync(baseDir).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      fs.readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到");
}

async function main(): Promise<void> {
  console.log(`[T611] S1-3 唔喺列表嘅對話撳入去空白（320 conv fixture）— base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T611-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  await seed();
  const cookie = await login();
  const H = { cookie: `wa_inbox_session=${cookie}` };

  // ── API 層（ensureConversationLoaded / contact: 分支嘅後端路徑）───────────
  console.log("API 層：");
  {
    const r1 = await fetch(`${BASE}/api/conversations`, { headers: H });
    const b1 = (await r1.json()) as { items: ItemRow[] };
    check("A0 第一頁 = 200 條", b1.items.length === 200, b1.items.length);
    check("A0 第一頁唔含 conv300（唔喺第一頁前提）", !b1.items.some((c) => c.id === CONV_300));
  }
  {
    const r = await fetch(`${BASE}/api/conversations?ids=${encodeURIComponent(CONV_300)}`, { headers: H });
    const b = (await r.json()) as { items: ItemRow[] };
    check("A1 ?ids=conv300 → 200 + 恰 1 條", r.status === 200 && b.items.length === 1 && b.items[0].id === CONV_300, { status: r.status, n: b.items.length });
  }
  {
    const r = await fetch(`${BASE}/api/conversations?ids=${encodeURIComponent(CONV_B)}`, { headers: H });
    const b = (await r.json()) as { items: ItemRow[] };
    check("A2 ?ids=convB（外店）→ 200 + 空 items", r.status === 200 && b.items.length === 0, { status: r.status, n: b.items.length });
  }
  {
    const r = await fetch(`${BASE}/api/conversations?contactId=${encodeURIComponent(contactId(IDX_300))}`, { headers: H });
    const b = (await r.json()) as { items: ItemRow[] };
    check("A3 ?contactId=contact300 → 恰 1 條 = conv300", r.status === 200 && b.items.length === 1 && b.items[0].id === CONV_300, { status: r.status, n: b.items.length });
  }

  // ── browser ─────────────────────────────────────────────────────────────
  const browser: BrowserLike = await (chromium as { launch: (o: Record<string, unknown>) => Promise<BrowserLike> }).launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const docHas = (page: Page, mark: string): Promise<number> =>
    page.evaluate(({ m }: { m: string }) => (document.body.innerText || "").split(m).length - 1, { m: mark });

  // ══ B：桌面（1440x900）══════════════════════════════════════════════════
  console.log("桌面 viewport：");
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desk.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const dp = await desk.newPage();

  // B1：?conv=<conv300>（唔喺第一頁）→ 正常顯示訊息
  await dp.goto(`${BASE}/inbox?conv=${CONV_300}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const b1msg = dp.locator(`[id^="msg-"]:has-text("T611MSG-${TS}-")`);
  await b1msg.first().waitFor({ timeout: 60_000 });
  check("B1 conv300（第 300 條）?conv= 開啟 → 訊息正常顯示（≥3 條）", (await b1msg.count()) >= 3, `count=${await b1msg.count()}`);
  check("B1 非「揀一個對話開始」空白", (await docHas(dp, "揀一個對話開始")) === 0);
  check("B1 收結後無 loading skeleton", (await dp.locator('[data-testid="s13-conv-loading"]').count()) === 0);
  await dp.close();

  // B2：?conv=<convB>（外店冇權限）→ notice（非空白：列表照見）
  const dp2 = await desk.newPage();
  await dp2.goto(`${BASE}/inbox?conv=${CONV_B}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const notice = dp2.locator('[data-testid="inbox-notice"]');
  await notice.first().waitFor({ timeout: 45_000 });
  check("B2 外店 id → notice 文案（非空白）", (await docHas(dp2, NOTICE_TEXT)) >= 1);
  const rowA = dp2.locator('button:has-text("E2ES13 P0000")').first();
  check("B2 列表照常可見（桌面非空白）", await rowA.isVisible().catch(() => false));
  check("B2 外店訊息零漏出", (await docHas(dp2, `T611BMSG-${TS}`)) === 0);
  await dp2.close();
  await desk.close();

  // ══ C：手機（390x844）— 載入中 skeleton ════════════════════════════════
  console.log("手機 viewport：");
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mob.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const mp = await mob.newPage();
  // 延遲 ?ids= 補載 2.5s → 攤開 skeleton 窗口（其他 /api/conversations 调用唔延遲）
  await mp.route("**/api/conversations*", async (r) => {
    if (r.request().url().includes("ids=")) await sleep(2500);
    r.continue();
  });
  await mp.goto(`${BASE}/inbox?conv=${CONV_300}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const skel = mp.locator('[data-testid="s13-conv-loading"]');
  await skel.first().waitFor({ timeout: 30_000 });
  check("C1 手機載入中 → skeleton 出現", await skel.first().isVisible().catch(() => false));
  const backBtn = mp.locator('[data-testid="s13-conv-loading"] button[aria-label="返回列表"]');
  check("C1 skeleton 帶「返回」掣（唔係「揀一個對話開始」）", (await backBtn.count()) === 1 && (await docHas(mp, "揀一個對話開始")) === 0);
  const c1msg = mp.locator(`[id^="msg-"]:has-text("T611MSG-${TS}-")`);
  await c1msg.first().waitFor({ timeout: 60_000 });
  check("C1 載入完 → 訊息正常顯示（≥3 條）", (await c1msg.count()) >= 3, `count=${await c1msg.count()}`);
  check("C1 載入完 → skeleton 收走", (await skel.count()) === 0);
  await mp.close();
  await mob.close();

  await browser.close();
  await cleanup();

  const residue = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_A}','${CLINIC_B}'))`
  );
  check("cleanup 零殘留", residue[0]?.n === 0, `residue=${residue[0]?.n}`);

  console.log(FAILS === 0 ? "\nT611-OK" : `\nT611-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T611-ERR", e instanceof Error ? e.message : e);
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
