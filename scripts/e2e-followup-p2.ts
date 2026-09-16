/**
 * e2e-followup-p2.ts — 病人記錄 UI（followup-v2 §3.5 七項 + RBAC + 零殘留）
 *
 * 前置：dev server 127.0.0.1:3100（.env WORKFORCE_MOCK=1）；Postgres 15432；chromium ~/.cache/ms-playwright
 * 跑法：pnpm -s tsx scripts/e2e-followup-p2.ts
 *
 * 決定性：
 *   - mock fixture 對齊 CWM dev stub（cp-std-001 STANDARD / cp-tpl-002 TEMPLATE /
 *     cp-no-003 爽約無 note / cp-zs-005 零欠款兩 visit=舊客）
 *   - syncedAt 用 .dev/workforce-mock-sync.json（offsetHours）；refresh 用 .dev/workforce-mock-refresh.json（mode）
 *   - 「更新緊」/「滯後+自動刷新」瞬態用 page.route 攔截 refresh=1 請求 hold 住先斷言（唔靠 timer race）
 *
 * 斷言：
 *   T2 配對 + chip 數據（summary）｜T3 note 端點（両樣板 + 404 + RBAC）｜T4 刷新五態（API 層）
 *   T5 RBAC（SUPERVISOR 全店 / STAFF 自己範圍）
 *   T6 UI 手機：chip（欠款>0 先顯）+ 抽屜 50vh→90vh 拖 / 掃走 / 獨立捲動 + 首行両樣板 + 展開再 call（audit）
 *   T7 UI 手機：刷新五態各出一次 + 60s 倒數 + >24h 開面板自動靜默刷新
 *   T8 UI 桌面：右側欄 備註／病人記錄／AI 三分頁
 *   T9 零殘留
 *
 * e2e harness：playwright/prisma 動態 payload 型太繁 → 本檔局部 any（src/ 零 any）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");

const BASE = "http://127.0.0.1:3100";
const PASS = "P2-E2E-Pass-123!";
const PFX = "e2ep2";

const SYNC_FLAG = ".dev/workforce-mock-sync.json";
const REFRESH_FLAG = ".dev/workforce-mock-refresh.json";
const RESET_FLAG = ".dev/workforce-mock-refresh-reset";

let passCount = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
    process.exitCode = 1;
  }
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Route = { continue: () => Promise<void>; request: () => { url: () => string } };
type Page = {
  goto: (u: string, o?: unknown) => Promise<void>;
  reload: (o?: unknown) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForSelector: (s: string, o?: unknown) => Promise<unknown>;
  waitForFunction: (fn: string | (() => unknown), arg?: unknown, o?: unknown) => Promise<unknown>;
  locator: (s: string) => unknown;
  getByText: (t: string) => unknown;
  mouse: { move: (x: number, y: number, o?: unknown) => Promise<void>; down: () => Promise<void>; up: () => Promise<void> };
  on: (ev: string, cb: (payload: any) => void) => void;
  off: (ev: string, cb?: (payload: any) => void) => void;
  evaluate: (fn: (el?: HTMLElement) => unknown, arg?: unknown) => Promise<unknown>;
  onNav: (ev: string, cb: () => void) => void;
  offNav: (ev: string, cb: () => void) => void;
  route: (pattern: string, cb: (r: Route) => void) => Promise<void>;
  unroute: (pattern: string) => Promise<void>;
  addCookies: never;
};
type Locator = {
  textContent: () => Promise<string | null>;
  getAttribute: (a: string) => Promise<string | null>;
  boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  click: (opts?: unknown) => Promise<void>;
  count: () => Promise<number>;
  isVisible: () => Promise<boolean>;
  isDisabled: () => Promise<boolean>;
  first: () => Locator;
  evaluate: (fn: (el: HTMLElement) => unknown) => Promise<unknown>;
};

// ── T0 基建 ──────────────────────────────────────────────────────────────
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const pg = spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "15432", "-q"]);
  if (pg.status !== 0) fail("Postgres 15432 唔喺");
  const srv = await fetch(`${BASE}/api/auth/login`, { method: "POST", body: "{}" }).catch(() => null);
  if (!srv) fail("dev server 3100 唔喺");
  void srv;
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const exeDir = fs
    .readdirSync(baseDir)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .pop();
  if (!exeDir) fail("chromium 搵唔到（~/.cache/ms-playwright）");
  const exe = path.join(baseDir, exeDir, "chrome-linux64", "chrome");
  if (!fs.existsSync(exe)) fail(`chromium binary 搵唔到：${exe}`);
  console.log("[T0] 基建 OK");

  // ── 冪等洗（上輪殘留 self-heal）────────────────────────────────────────
  const oldUsers = await prisma.staffUser.findMany({ where: { email: { startsWith: `${PFX}-` } }, select: { id: true } });
  const oldConvIds = (
    await prisma.conversation.findMany({ where: { id: { startsWith: `${PFX}-` } }, select: { id: true } })
  ).map((c) => c.id);
  const oldUserIds = oldUsers.map((u) => u.id);
  {
    await prisma.message.deleteMany({ where: { conversationId: { in: oldConvIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: oldConvIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: oldConvIds } } });
    await prisma.contact.deleteMany({ where: { id: { startsWith: `${PFX}-` } } });
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: oldUserIds } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: oldUserIds } } });
  }

  // ── helpers ───────────────────────────────────────────────────────────
  // .dev flag 檔 = symlink → /tmp（避開 Next dev watcher — 寫 .dev 會觸發 HMR reload 风暴，
  // 實測 browser 開緊時會無限 reload 洗走 selection；readFlag 經 symlink 透明讀）
  const realFlagPath = (rel: string): string => {
    const fp = path.resolve(process.cwd(), rel);
    try {
      if (fs.lstatSync(fp).isSymbolicLink()) return fs.realpathSync(fp);
    } catch {
      /* 冇檔 — 用原路徑 */
    }
    return fp;
  };
  const flag = (rel: string, obj: unknown | null): void => {
    const wp = realFlagPath(rel);
    if (obj === null) {
      try {
        fs.unlinkSync(wp);
      } catch {
        /* noop */
      }
      return;
    }
    fs.writeFileSync(wp, JSON.stringify(obj));
  };
  const touchReset = (): void => {
    const wp = realFlagPath(RESET_FLAG);
    try {
      fs.unlinkSync(wp);
    } catch {
      /* noop */
    }
    fs.writeFileSync(wp, "1");
  };

  const loginCache = new Map<string, string>();
  async function login(email: string): Promise<string> {
    const hit = loginCache.get(email);
    if (hit) return hit;
    let cookieVal: string | null = null;
    for (let att = 0; att < 4 && !cookieVal; att++) {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASS }),
      });
      const text = await res.text().catch(() => "");
      if (res.status === 200) {
        const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
        if (m) cookieVal = m[1];
      } else if (res.status === 500 && text.trimStart().startsWith("<")) {
        await sleep(3000); // loadManifest race — 重試
      } else if (res.status === 429) {
        await sleep(6200); // IP rate limit 5/60s
      } else {
        fail(`login ${email} → ${res.status} ${text.slice(0, 200)}`);
      }
    }
    if (!cookieVal) fail(`login ${email} 冇 cookie`);
    loginCache.set(email, cookieVal);
    return cookieVal;
  }
  async function api(pathname: string, cookie: string): Promise<{ status: number; json: any }> {
    for (let att = 0; ; att++) {
      const res = await fetch(`${BASE}${pathname}`, {
        headers: { cookie: `wa_inbox_session=${cookie}`, "content-type": "application/json" },
      });
      const json = await res.json().catch(() => null);
      // dev 編譯/loadManifest race 瞬態 500（無 JSON body）→ 重試一次
      if (res.status === 500 && json === null && att === 0) {
        await sleep(3000);
        continue;
      }
      return { status: res.status, json };
    }
  }

  // ── fixture：用戶 + 對話（clinic TY + TKW）──────────────────────────────
  const [TY, TKW] = await Promise.all(
    ["TY", "TKW"].map(async (code) => {
      const r = await prisma.clinic.findUnique({ where: { code }, select: { id: true } });
      if (!r) fail(`clinic ${code} 唔喺（dev seed 缺？）`);
      return r.id;
    }),
  );
  const hash = await argon2.hash(PASS);
  const makeUser = async (id: string, email: string, role: "ADMIN" | "STAFF" | "SUPERVISOR", scopeType: string, scopeCompanyId: string | null): Promise<string> => {
    await prisma.staffUser.create({
      data: { id, email, name: id, role, passwordHash: hash, scopeType, scopeCompanyId, active: true },
    });
    return id;
  };
  const SUPER = await makeUser(`${PFX}-super`, `${PFX}-super@e2e.local`, "SUPERVISOR", "ALL", null);
  const STAFF = await makeUser(`${PFX}-staff`, `${PFX}-staff@e2e.local`, "STAFF", "CLINICS", null);
  await prisma.staffClinic.create({ data: { staffId: STAFF, clinicId: TY } }); // 只 TY 範圍

  const makeConv = async (id: string, clinicId: string, waId: string, name: string, pinned: string | null): Promise<string> => {
    const contactId = `${PFX}-ct-${id.slice(-4)}`;
    await prisma.contact.create({ data: { id: contactId, clinicId, waId, profileName: name, labels: [] } });
    await prisma.conversation.create({
      data: { id, clinicId, contactId, lastMessageAt: new Date(), pinnedPatientApricotId: pinned },
    });
    return id;
  };
  // conv-std：pinned cp-std-001（P0001，osAmt 300，STANDARD note）
  const convStd = await makeConv(`${PFX}-conv-std`, TY, "85291234567", "P2-陳大文", "cp-std-001");
  // conv-zs：waId 唯一 = cp-zs-005 嘅號（P0005，osAmt 0，2 visit = 舊客）— 唔 pin，測配對
  const convZs = await makeConv(`${PFX}-conv-zs`, TY, "85223456789", "P2-零欠款", null);
  // conv-tpl：pinned cp-tpl-002（P0002，osAmt 1500，TEMPLATE note）
  const convTpl = await makeConv(`${PFX}-conv-tpl`, TY, "85261234567", "P2-李美玲", "cp-tpl-002");
  // conv-tkw：TKW 店 + pinned cp-no-003（爽約無 note）— RBAC 用
  const convTkw = await makeConv(`${PFX}-conv-tkw`, TKW, "85299900001", "P2-黃志強", "cp-no-003");
  console.log("[T1] fixture OK");

  const superCookie = await login(`${PFX}-super@e2e.local`);
  const staffCookie = await login(`${PFX}-staff@e2e.local`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T2] 配對 + chip 數據（summary）");
  flag(SYNC_FLAG, null);
  {
    const r = await api(`/api/conversations/${convStd}/patient-record?summary=1`, superCookie);
    check("summary 200", r.status === 200, r);
    check("pinned 配對 cp-std-001", r.json?.patient?.patientApricotId === "cp-std-001" && r.json?.patient?.source === "pinned", r.json?.patient);
    check("chip：P0001 + 新客（1 visit）", r.json?.patient?.patientCode === "P0001" && r.json?.patient?.customerType === "new", r.json?.patient);
    check("chip：欠款 300", r.json?.balance?.balance?.osAmt === 300, r.json?.balance);
    check("chip：上次到診 2026-09-14", r.json?.patient?.lastVisitDate === "2026-09-14", r.json?.patient);
    check("summary 唔回預約（輕量）", Array.isArray(r.json?.appointments) && (r.json.appointments as unknown[]).length === 0, r.json?.appointments);

    const rz = await api(`/api/conversations/${convZs}/patient-record?summary=1`, superCookie);
    check("未 pin → phoneHashes 配對 cp-zs-005", rz.json?.patient?.patientApricotId === "cp-zs-005" && rz.json?.patient?.source === "paired", rz.json?.patient);
    check("舊客（2 visit）", rz.json?.patient?.customerType === "returning", rz.json?.patient);
    check("零欠款 osAmt=0", rz.json?.balance?.balance?.osAmt === 0, rz.json?.balance);

    const rt = await api(`/api/conversations/${convTpl}/patient-record?summary=1`, superCookie);
    check("conv-tpl 配對 cp-tpl-002（osAmt 1500）", rt.json?.patient?.patientApricotId === "cp-tpl-002" && rt.json?.balance?.balance?.osAmt === 1500, { p: rt.json?.patient, b: rt.json?.balance });

    const full = await api(`/api/conversations/${convStd}/patient-record`, superCookie);
    check("full：visits[0] firstLine（STANDARD）", full.json?.visits?.[0]?.firstLine === "左上後牙咬痛三星期" && full.json?.visits?.[0]?.noteKind === "STANDARD", full.json?.visits?.[0]);
    check("full：醫生欄有值（providerName 映返或 code）", typeof (full.json?.visits?.[0]?.providerName ?? full.json?.visits?.[0]?.providerCode) === "string" && !!(full.json?.visits?.[0]?.providerName ?? full.json?.visits?.[0]?.providerCode), full.json?.visits?.[0]);
    check("full：appointments 2 筆（含未來 09/22）", full.json?.appointments?.length === 2, full.json?.appointments?.length);
    check("full：syncedAt 有值", typeof full.json?.syncedAt === "string", full.json?.syncedAt);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T3] note 端點（両樣板 + 404）");
  {
    const ns = await api(`/api/conversations/${convStd}/patient-record/note?visitId=cv-std-001-1`, superCookie);
    check("STANDARD note 200", ns.status === 200, ns);
    check(
      "STANDARD 四段齊",
      ns.json?.note?.kind === "STANDARD" &&
        ns.json?.note?.complaints === "左上後牙咬痛三星期" &&
        ns.json?.note?.diagnosis === "Deep caries #26" &&
        !!ns.json?.note?.actions,
      ns.json?.note,
    );

    const nt = await api(`/api/conversations/${convTpl}/patient-record/note?visitId=cv-tpl-002-1`, superCookie);
    check("TEMPLATE note 200", nt.status === 200, nt);
    check(
      "TEMPLATE blocks（口腔檢查）",
      nt.json?.note?.kind === "TEMPLATE" && (nt.json?.note?.blocks ?? []).some((b: { label: string }) => b.label === "口腔檢查"),
      nt.json?.note,
    );

    const nn = await api(`/api/conversations/${convTkw}/patient-record/note?visitId=cv-no-003-1`, superCookie);
    check("無 note（爽約）→ 404", nn.status === 404, nn);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T4] 刷新五態（API 層 — mock flag 控制）");
  {
    touchReset();
    flag(SYNC_FLAG, null);
    let r = await api(`/api/conversations/${convStd}/patient-record?summary=1`, superCookie);
    check("正常態：syncedAt ≈ now-5h", r.status === 200 && Math.abs(Date.now() - Date.parse(r.json.syncedAt)) < 6 * 3600_000, r.json?.syncedAt);

    r = await api(`/api/conversations/${convStd}/patient-record?refresh=1`, superCookie);
    check("refresh ok（syncedAt 拉新）", r.json?.refresh?.state === "ok" && Date.now() - Date.parse(r.json.refresh.syncedAt) < 60_000, r.json?.refresh);

    r = await api(`/api/conversations/${convStd}/patient-record?refresh=1`, superCookie);
    check("60s 桶限流 → rate_limited + retryAfterSec", r.json?.refresh?.state === "rate_limited" && (r.json?.refresh?.retryAfterSec ?? 0) > 0, r.json?.refresh);

    touchReset();
    flag(REFRESH_FLAG, { mode: "fail" });
    r = await api(`/api/conversations/${convStd}/patient-record?refresh=1`, superCookie);
    check("斷線（503）→ refresh.state=failed", r.json?.refresh?.state === "failed", r.json?.refresh);
    check("失敗唔扮成功：舊數據照回", Array.isArray(r.json?.visits) && (r.json.visits as unknown[]).length >= 1, r.json?.visits?.length);
    flag(REFRESH_FLAG, null);

    touchReset();
    flag(REFRESH_FLAG, { mode: "rate", retryAfterSec: 45 });
    r = await api(`/api/conversations/${convStd}/patient-record?refresh=1`, superCookie);
    check("rate mode → rate_limited retryAfterSec=45", r.json?.refresh?.state === "rate_limited" && r.json?.refresh?.retryAfterSec === 45, r.json?.refresh);
    flag(REFRESH_FLAG, null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T5] RBAC（API 層）");
  {
    const nr = await api(`/api/conversations/${convTkw}/patient-record?summary=1`, staffCookie);
    check("STAFF（只 TY）讀 TKW 對話 → 403", nr.status === 403, nr);
    const rs = await api(`/api/conversations/${convStd}/patient-record?summary=1`, staffCookie);
    check("STAFF（只 TY）讀自己店 → 200", rs.status === 200, rs.status);
    const rt2 = await api(`/api/conversations/${convTkw}/patient-record?summary=1`, superCookie);
    check("SUPERVISOR（ALL）讀 TKW → 200（全店唯讀）", rt2.status === 200, rt2.status);
    const nnote = await api(`/api/conversations/${convTkw}/patient-record/note?visitId=cv-no-003-1`, staffCookie);
    check("STAFF 讀外店 note → 403", nnote.status === 403, nnote);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────
  async function launchPw() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pw = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core");
    return (pw as any).chromium;
  }
  /** 手機 viewport 選中對話（列表 button:has-text；喺 chat view 先返回列表） */
  async function selectConv(pg: Page, name: string, diag?: { errors: string[]; apis: string[] }): Promise<void> {
    /** Next 15 dev loadManifest race / 對話列表 API 瞬時 500（已知 flake；fetchConversations 靜默返空）
        → 整段（click + chip-row 斷）重試最多 3 次，中間 reload 2.5s 間隔。harness retry only，零邏輯改動。 */
    let lastErr: unknown = null;
    for (let att = 1; att <= 3; att++) {
      try {
        const back = pg.locator('button[aria-label="返回列表"]') as Locator;
        if (await back.isVisible().catch(() => false)) {
          await back.click();
          await pg.waitForTimeout(400);
        }
        const row = pg.locator(`button:has-text("${name}")`) as unknown as Locator;
        await row.first().click({ timeout: 15000 });
        await pg.waitForSelector('[data-e2e="p2-chip-row"]', { timeout: 15000 });
        return;
      } catch (e) {
        lastErr = e;
        if (diag) {
          const body = await pg.evaluate(() => document.body.innerText.slice(0, 250)).catch(() => "<eval fail>");
          const btnCount = await pg.evaluate(() => document.querySelectorAll("button").length).catch(() => -1);
          console.log(`  [diag] selectConv fail（att ${att}/3）: body=${JSON.stringify(String(body).slice(0, 200))} buttons=${btnCount}`);
          console.log(`  [diag] console errors: ${JSON.stringify(diag.errors.slice(-5))}`);
          console.log(`  [diag] bad apis: ${JSON.stringify(diag.apis.slice(-8))}`);
        }
        if (att < 3) {
          console.log(`  [retry] selectConv "${name}" att ${att} fail → reload 2.5s 後重試`);
          await pg.reload({ waitUntil: "domcontentloaded" });
          await pg.waitForTimeout(2500); // dev recompile 後重試（對齊 loadInbox 口徑）
          await quietBanner(pg).catch(() => {});
        }
      }
    }
    throw lastErr;
  }
  /** loadInbox：Next 15 dev loadManifest race（已知 flake）→ HTML 500 error page；偵測到就重試（最多 3 次） */
  async function loadInbox(pg: Page, reload: boolean): Promise<void> {
    for (let att = 0; att < 3; att++) {
      if (reload) await pg.reload({ waitUntil: "domcontentloaded" });
      else await pg.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
      await pg.waitForTimeout(3000);
      const bad = await pg.evaluate(
        () => document.body.innerText.includes("Internal Server Error") || document.body.innerText.includes("Application error"),
      );
      if (!bad) return;
      await pg.waitForTimeout(2500); // dev recompile 後重試
    }
    fail("loadInbox: 3 次都係 error page（loadManifest race 不斷？）");
  }

  /** 首次登入通知 banner 擋頂部 → 點「唔該」攞走（app localStorage flag，headless 新 profile 必出） */
  async function quietBanner(pg: Page): Promise<void> {
    const b = pg.locator('button:has-text("唔該")') as Locator;
    if ((await b.count()) === 1) await b.click().catch(() => {});
  }

  /** HMR stale queue drain：之前 .dev 寫入會留 stale HMR update → 開頁即无限 auto-reload 洗走 state。
      等頁面喺 window 內冇 navigated 事件先算 settle（最多 rounds 個 window）。 */
  async function settle(pg: Page, rounds = 3, windowMs = 4000): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      let n = 0;
      const h = () => {
        n++;
      };
      pg.onNav("framenavigated", h);
      await pg.waitForTimeout(windowMs);
      pg.offNav("framenavigated", h);
      if (n === 0) return;
    }
  }

  /** 攔截 refresh=1 請求（hold）— 瞬態斷言唔靠 timer race */
  const held: Route[] = [];
  async function holdRefresh(pg: Page): Promise<void> {
    await pg.route("**/patient-record?refresh=1", (r) => {
      held.push(r);
    });
  }
  function releaseHeld(): void {
    while (held.length) void held.pop()!.continue();
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T6] UI 手機（chip + 抽屜 + 首行 + 展開 audit）");
  {
    const chromium = await launchPw();
    const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    });
    await ctx.grantPermissions(["notifications"], { origin: BASE }); // 免「開啟通知」banner 擋按鈕
    await ctx.addCookies([{ name: "wa_inbox_session", value: superCookie, domain: "127.0.0.1", path: "/" }]);
    const page = (await ctx.newPage()) as Page;
    (page as any).onNav = (ev: string, cb: () => void) => (page as any).on(ev, cb);
    (page as any).offNav = (ev: string, cb: () => void) => (page as any).off(ev, cb);
    const noteCalls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/patient-record/note?")) noteCalls.push(req.url());
    });

    await loadInbox(page, false);
    await settle(page, 4, 5000);
    await quietBanner(page);

    // ── conv-std：chip + 抽屜 ──
    await selectConv(page, "P2-陳大文");
    const chipCode = await (page.locator('[data-e2e="p2-chip-code"]') as Locator).textContent();
    check("chip 顯示 P0001 · 新客", !!chipCode && chipCode.includes("P0001") && chipCode.includes("新客"), chipCode);
    const chipOs = await (page.locator('[data-e2e="p2-chip-os"]') as Locator).textContent();
    check("欠款 chip 顯示 $300（>0 先顯）", !!chipOs && chipOs.includes("300"), chipOs);
    const chipLast = await (page.locator('[data-e2e="p2-chip-lastvisit"]') as Locator).textContent();
    check("上次到診 chip 09/14", !!chipLast && chipLast.includes("09/14"), chipLast);

    // 開抽屜
    await (page.locator('[data-e2e="p2-open-record"]') as Locator).click();
    await page.waitForSelector('[data-e2e="p2-drawer"]', { timeout: 10000 });
    let h = await (page.locator('[data-e2e="p2-drawer-sheet"]') as Locator).getAttribute("data-height-vh");
    check("抽屜開 = 50vh（下半屏）", h === "50", h);
    const drawerBox = await (page.locator('[data-e2e="p2-drawer-sheet"]') as Locator).boundingBox();
    const chatBox = await ((page.locator("section") as unknown as Locator).first().boundingBox());
    check("上半對話可見（chat 伸入抽屜之上 >40px）", !!drawerBox && !!chatBox && chatBox.y < drawerBox.y && chatBox.height > drawerBox.y + 40, { chat: chatBox, drawer: drawerBox });

    // 內容獨立捲動容器（overflow-y auto — §3.2 結構）
    const scrollInfo = await ((page.locator('[data-e2e="p2-content"]') as Locator).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { overflowY: cs.overflowY };
    }));
    check("內容區獨立捲動容器（overflow-y:auto）", (scrollInfo as { overflowY: string }).overflowY === "auto", scrollInfo);

    // 首行（STANDARD）+ 狀態 chip
    const fl = await ((page.locator('[data-e2e="p2-first-line"]') as unknown as Locator).first().textContent());
    check("首行顯示正確（STANDARD 樣板）", fl === "左上後牙咬痛三星期", fl);
    const statusChip = await ((page.locator('[data-e2e="p2-status-chip"]') as unknown as Locator).first().textContent());
    check("到診卡狀態 chip 已完成（st=4）", statusChip === "已完成", statusChip);

    // 展開臨床記錄（STANDARD 四段 + 灰字警告 + audit call）
    const before = noteCalls.length;
    await ((page.locator('[data-e2e="p2-expand-note"]') as unknown as Locator).first().click());
    await page.waitForSelector('[data-e2e="p2-note"][data-kind="STANDARD"]', { timeout: 10000 });
    const noteTxt = await (page.locator('[data-e2e="p2-note"][data-kind="STANDARD"]') as Locator).textContent();
    check("展開 STANDARD：四段齊（主訴/癥狀/診斷/跟進）", !!noteTxt && ["主訴", "癥狀", "診斷", "跟進"].every((l) => noteTxt.includes(l)), noteTxt?.slice(0, 120));
    check("灰字警告「請勿轉發」", (await (page.locator('[data-e2e="p2-note-warn"]') as Locator).textContent())?.includes("請勿轉發") ?? false);
    check("展開 = 1 次 note call（CWM audit 來源）", noteCalls.length === before + 1, noteCalls.length - before);

    // 收埋再展開 → 再 call（唔 cache — §3.3 拍板 b）
    await ((page.locator('[data-e2e="p2-expand-note"]') as unknown as Locator).first().click());
    await page.waitForTimeout(500);
    const mid = noteCalls.length;
    await ((page.locator('[data-e2e="p2-expand-note"]') as unknown as Locator).first().click());
    await page.waitForSelector('[data-e2e="p2-note"][data-kind="STANDARD"]', { timeout: 10000 });
    check("收埋再展開 = 再 call（唔 cache）", noteCalls.length === mid + 1, { mid, now: noteCalls.length });

    // 藥物 tab empty-state / 帳單總額卡 / 預約
    await ((page.locator('[data-e2e="p2-tab-meds"]') as Locator).click());
    check("藥物 tab：empty-state 指引", (await (page.locator('[data-e2e="p2-meds-empty"]') as Locator).textContent())?.includes("臨床記錄") ?? false);
    await ((page.locator('[data-e2e="p2-tab-bills"]') as Locator).click());
    const balTxt = await (page.locator('[data-e2e="p2-balance-card"]') as Locator).textContent();
    check("帳單 tab：總額卡（$800 / 欠 $300）", !!balTxt && balTxt.includes("$800") && balTxt.includes("$300"), balTxt);
    await ((page.locator('[data-e2e="p2-tab-appts"]') as Locator).click());
    check("預約 tab：2 筆", (await (page.locator('[data-e2e="p2-appt-row"]') as Locator).count()) === 2);

    // 拖高 → 90vh
    const handle = page.locator('[data-e2e="p2-drawer-handle"]') as Locator;
    const hb = await handle.boundingBox();
    if (!hb) fail("handle boundingBox 冇");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 300, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    h = await (page.locator('[data-e2e="p2-drawer-sheet"]') as Locator).getAttribute("data-height-vh");
    check("拖高 → 90vh", h === "90", h);

    // 向下掃關閉
    const hb2 = await handle.boundingBox();
    if (!hb2) fail("handle boundingBox 冇（掃前）");
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2 + 420, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    check("向下掃 → 抽屜關閉", (await (page.locator('[data-e2e="p2-drawer"]') as Locator).count()) === 0);

    // ── conv-zs：零欠款唔顯示欠款 chip + 舊客 ──
    await selectConv(page, "P2-零欠款");
    check("零欠款：欠款 chip 唔顯示（osAmt=0）", (await (page.locator('[data-e2e="p2-chip-os"]') as Locator).count()) === 0);
    const zsCode = await (page.locator('[data-e2e="p2-chip-code"]') as Locator).textContent();
    check("chip 顯示 P0005 · 舊客（2 visit）", !!zsCode && zsCode.includes("P0005") && zsCode.includes("舊客"), zsCode);

    // ── conv-tpl：TEMPLATE 首行 + 展開 ──
    await selectConv(page, "P2-李美玲");
    await (page.locator('[data-e2e="p2-open-record"]') as Locator).click();
    await page.waitForSelector('[data-e2e="p2-first-line"]', { timeout: 10000 });
    const fl2 = await ((page.locator('[data-e2e="p2-first-line"]') as unknown as Locator).first().textContent());
    check("首行顯示正確（TEMPLATE 病人）", fl2 === "定期洗牙", fl2);
    const before2 = noteCalls.length;
    await ((page.locator('[data-e2e="p2-expand-note"]') as unknown as Locator).first().click());
    await page.waitForSelector('[data-e2e="p2-note"][data-kind="TEMPLATE"]', { timeout: 10000 });
    const nt2 = await (page.locator('[data-e2e="p2-note"][data-kind="TEMPLATE"]') as Locator).textContent();
    check("展開 TEMPLATE：Tx 原文（牙石中度/全口超音波洗牙）", !!nt2 && nt2.includes("牙石中度") && nt2.includes("全口超音波洗牙"), nt2?.slice(0, 120));
    check("TEMPLATE 展開 = 1 次 call", noteCalls.length === before2 + 1, noteCalls.length - before2);
    check("TEMPLATE 灰字警告", (await (page.locator('[data-e2e="p2-note-warn"]') as Locator).count()) >= 1);

    await browser.close();
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T7] UI 手機：刷新五態 + 60s 倒數 + >24h 自動靜默刷新");
  {
    const chromium = await launchPw();
    const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.grantPermissions(["notifications"], { origin: BASE });
    await ctx.addCookies([{ name: "wa_inbox_session", value: superCookie, domain: "127.0.0.1", path: "/" }]);
    const page = (await ctx.newPage()) as Page;
    (page as any).onNav = (ev: string, cb: () => void) => (page as any).on(ev, cb);
    (page as any).offNav = (ev: string, cb: () => void) => (page as any).off(ev, cb);
    const diag7: { errors: string[]; apis: string[] } = { errors: [], apis: [] };
    page.on("console", (m: { type: () => string; text: () => string }) => {
      if (m.type() === "error") diag7.errors.push(m.text().slice(0, 160));
    });
    page.on("response", (r: { status: () => number; url: () => string }) => {
      if (r.url().includes("/api/") && r.status() >= 500) diag7.apis.push(`${r.status()} ${r.url().replace(BASE, "").slice(0, 60)}`);
    });
    const syncbar = () => page.locator('[data-e2e="p2-syncbar"]') as Locator;
    const refreshBtn = () => page.locator('[data-e2e="p2-refresh-btn"]') as Locator;
    const openPanel = async (): Promise<void> => {
      await selectConv(page, "P2-陳大文");
      await (page.locator('[data-e2e="p2-open-record"]') as Locator).click();
      await page.waitForSelector('[data-e2e="p2-syncbar"]', { timeout: 20000 });
    };

    // (a) 正常態（default 5h → 灰「資料截至…」+ [立即更新]）
    touchReset();
    flag(SYNC_FLAG, null);
    await loadInbox(page, false);
    await settle(page, 4, 5000);
    await quietBanner(page);
    await openPanel();
    // 等首載完成（syncbar 初始態 = 「尚未同步」— 唔好喺 fetch 未回時斷言）
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("資料截至"),
      null,
      { timeout: 20000, polling: 100 },
    );
    let syncTxt = await syncbar().textContent();
    check("態1 正常（1–24h 灰）：「資料截至…」", !!syncTxt && syncTxt.includes("資料截至"), syncTxt);
    check("正常態：掣 = 立即更新（enable）", (await refreshBtn().textContent()) === "立即更新" && !(await refreshBtn().isDisabled()));

    // (b) 撳立即更新 → 更新中（hold 住斷言）→ 成功（綠）+ 60s 倒數 disable
    held.length = 0;
    await holdRefresh(page);
    await refreshBtn().click();
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("更新緊"),
      null,
      { timeout: 15000, polling: 100 },
    );
    syncTxt = await syncbar().textContent();
    check("態4 更新中：「更新緊…（由 Apricot 取最新）」", !!syncTxt && syncTxt.includes("更新緊"), syncTxt);
    check("更新中：掣 disable", await refreshBtn().isDisabled());
    releaseHeld();
    await page.unroute("**/patient-record?refresh=1");
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("剛剛更新"),
      null,
      { timeout: 15000 },
    );
    syncTxt = await syncbar().textContent();
    check("態3 剛更新（<1h 綠）：「● 剛剛更新」", !!syncTxt && syncTxt.includes("剛剛更新"), syncTxt);
    const btnTxt = await refreshBtn().textContent();
    check("60s 內：掣倒數 + disable", (await refreshBtn().isDisabled()) && !!btnTxt && /後可再更新/.test(btnTxt), { btnTxt });

    // (c) fresh 態（offset 0.5h — 重開面板唔使刷新）
    touchReset();
    flag(SYNC_FLAG, { offsetHours: 0.5 });
    await loadInbox(page, true);
    await settle(page, 2, 3000);
    await quietBanner(page);
    await openPanel();
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("剛剛更新"),
      null,
      { timeout: 20000, polling: 100 },
    );
    syncTxt = await syncbar().textContent();
    check("態3 fresh（offset 0.5h）：「剛剛更新」", !!syncTxt && syncTxt.includes("剛剛更新"), syncTxt);

    // (d) >24h → 黃「⚠ 資料可能滯後」+ 開面板自動靜默刷新（network 斷言）
    touchReset();
    flag(SYNC_FLAG, { offsetHours: 25 });
    const autoRefresh: string[] = [];
    await page.route("**/patient-record?refresh=1", (r) => {
      autoRefresh.push(r.request().url());
      void r.continue();
    });
    await loadInbox(page, true);
    await settle(page, 2, 3000);
    await quietBanner(page);
    await selectConv(page, "P2-陳大文", diag7);
    await (page.locator('[data-e2e="p2-open-record"]') as Locator).click();
    await page.waitForSelector('[data-e2e="p2-syncbar"]', { timeout: 20000 });
    // 瞬態：等黃（auto refresh 可能快過 — 兜底：黃出現過 或者已經轉綠都算 auto 跑過）
    const staleSeen = await page
      .waitForFunction(
        () => {
          const t = document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "";
          return t.includes("資料可能滯後") ? "stale" : t.includes("剛剛更新") ? "refreshed" : null;
        },
        null,
        { timeout: 20000, polling: 50 },
      )
      .then(() => true)
      .catch(() => false);
    check(">24h 開面板：黃「⚠ 資料可能滯後」出現過", staleSeen, staleSeen);
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("剛剛更新"),
      null,
      { timeout: 15000 },
    );
    check("自動靜默刷新：network 有 1 次 refresh=1", autoRefresh.length === 1, autoRefresh);

    // (e) 失敗態（503）→「Apricot 未接通，顯示緊 {lastSyncedAt} 嘅資料」+ 重試
    touchReset();
    flag(REFRESH_FLAG, { mode: "fail" });
    await loadInbox(page, true);
    await settle(page, 2, 3000);
    await quietBanner(page);
    await openPanel();
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("Apricot 未接通"),
      null,
      { timeout: 20000 },
    );
    syncTxt = await syncbar().textContent();
    check("態5 失敗：「Apricot 未接通，顯示緊…嘅資料」", !!syncTxt && syncTxt.includes("Apricot 未接通") && syncTxt.includes("嘅資料"), syncTxt);
    check("失敗顯示舊數據時間（唔扮更新咗）", !!syncTxt && /\d{2}\/\d{2} \d{2}:\d{2}/.test(syncTxt), syncTxt);
    check("失敗：掣 = 重試（enable）", (await refreshBtn().textContent()) === "重試" && !(await refreshBtn().isDisabled()));
    flag(REFRESH_FLAG, null);

    // (f) 限流態（429）→「Apricot 限流中 — Ns 後可再更新」
    touchReset();
    flag(REFRESH_FLAG, { mode: "rate", retryAfterSec: 37 });
    await loadInbox(page, true);
    await settle(page, 2, 3000);
    await quietBanner(page);
    await openPanel();
    await page.waitForFunction(
      () => (document.querySelector('[data-e2e="p2-syncbar"]')?.textContent ?? "").includes("限流"),
      null,
      { timeout: 20000 },
    );
    syncTxt = await syncbar().textContent();
    check("態6 限流（429）：「Apricot 限流中 — Ns 後可再更新」", !!syncTxt && syncTxt.includes("限流中") && /後可再更新/.test(syncTxt), syncTxt);
    flag(REFRESH_FLAG, null);
    flag(SYNC_FLAG, null);

    await browser.close();
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T8] UI 桌面：右側欄 備註／病人記錄／AI 分頁");
  {
    const chromium = await launchPw();
    const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.grantPermissions(["notifications"], { origin: BASE });
    await ctx.addCookies([{ name: "wa_inbox_session", value: superCookie, domain: "127.0.0.1", path: "/" }]);
    const page = (await ctx.newPage()) as Page;
    (page as any).onNav = (ev: string, cb: () => void) => (page as any).on(ev, cb);
    (page as any).offNav = (ev: string, cb: () => void) => (page as any).off(ev, cb);
    await loadInbox(page, false);
    await settle(page, 4, 5000);
    await quietBanner(page);
    await ((page.locator('button:has-text("P2-陳大文")') as unknown as Locator).first().click());
    await page.waitForSelector('[data-e2e="p2-detail-tabs"]', { timeout: 20000 });
    check("桌面側欄三分頁", (await (page.locator('[data-e2e^="p2-detail-tab-"]') as Locator).count()) === 3);

    // 病人記錄分頁（內容同手機一致）
    await ((page.locator('[data-e2e="p2-detail-tab-patient"]') as Locator).click());
    await page.waitForSelector('[data-e2e="p2-panel"]', { timeout: 20000 });
    const dfl = await ((page.locator('[data-e2e="p2-first-line"]') as unknown as Locator).first().textContent());
    check("桌面病人記錄：首行（同手機一致）", dfl === "左上後牙咬痛三星期", dfl);
    await ((page.locator('[data-e2e="p2-expand-note"]') as unknown as Locator).first().click());
    await page.waitForSelector('[data-e2e="p2-note"][data-kind="STANDARD"]', { timeout: 10000 });
    check("桌面展開臨床記錄 OK（+警告）", (await (page.locator('[data-e2e="p2-note-warn"]') as Locator).count()) >= 1);

    // AI 分頁
    await ((page.locator('[data-e2e="p2-detail-tab-ai"]') as Locator).click());
    await page.waitForTimeout(500);
    const aiVisible = await (page.getByText("AI 分析") as unknown as Locator).first().isVisible();
    check("AI 分頁：AI 分析卡可見", aiVisible);

    // 備註分頁（原有內容）
    await ((page.locator('[data-e2e="p2-detail-tab-notes"]') as Locator).click());
    await page.waitForTimeout(500);
    const notesVisible = await (page.getByText("內部備註") as unknown as Locator).first().isVisible();
    check("備註分頁：原有內容可見（內部備註卡）", notesVisible);

    await browser.close();
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[T9] 零殘留");
  {
    flag(SYNC_FLAG, null);
    flag(REFRESH_FLAG, null);
    try {
      fs.unlinkSync(realFlagPath(RESET_FLAG)); // 清 /tmp target（.dev symlink 保留）
    } catch {
      /* noop */
    }
    const ids = [convStd, convZs, convTpl, convTkw];
    await prisma.message.deleteMany({ where: { conversationId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.conversation.deleteMany({ where: { id: { in: ids } } });
    await prisma.contact.deleteMany({ where: { id: { startsWith: `${PFX}-` } } });
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: [SUPER, STAFF] } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: [SUPER, STAFF] } } });
    const rem =
      (await prisma.conversation.count({ where: { id: { startsWith: `${PFX}-` } } })) +
      (await prisma.contact.count({ where: { id: { startsWith: `${PFX}-` } } })) +
      (await prisma.staffUser.count({ where: { email: { startsWith: `${PFX}-` } } }));
    check("殘留 = 0", rem === 0, rem);
  }

  console.log(`\ne2e-followup-p2: ${passCount} checks passed${process.exitCode ? "（有 fail）" : " — 全綠"}`);
}

main()
  .catch((e) => fail(e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(0, 4).join("\n")}` : String(e)))
  .finally(() => {
    void prisma.$disconnect();
  });
