/**
 * e2e-consult-c5 — cwi-consult-20260910b C5（§8 臨床人員 UI）e2e
 *
 * 範圍（MD §8）：
 *   §8.1 三 tab 設定頁（方案資料 / AI 會點傾 / 進階）+ 簽署 + 預覽
 *   §8.2 側欄 CONSULT 狀態卡（全中文）+ 店員操作（assess / reset / clearSlot / resume）
 *   §8.4 來源標記（adopted vs typed → humanTookOver）
 *   §8.0 零技術詞（醫生可見區域 grep 禁詞）
 *
 * 用例：
 *   S1 fixture：e2ec5 clinic（aiMode 預設 DRAFT）/ 全球 product e2ec5P / 全球 PRICE doc / SUPERVISOR user
 *   S2 簽署：UI 撳確認 → approvedAt 有值 + audit CONSULT_PRODUCT_APPROVED → 改欄位 → approvedAt 清空 + approvalCleared
 *   S3 預覽：API 三核對全綠 + CG-004 紅 ✗（blocked）+ 零寫入（session 數不變）
 *   S4 設定：GET 預設 / PUT rules・discovery・advanced（clinic scope）/ 壞 key 400 / audit
 *   S5 UI：三 tab render + 零技術詞 grep（c5-root 範圍）
 *   S6 非 ADMIN：SUPERVISOR 見唔到進階 + nav 冇入口 + PUT 403
 *   S7 狀態卡：全中文 / adopted 發送（AI_ADOPTED）/ typed 發送（HUMAN_TYPED + 已暫停）/ 交返 AI /
 *      slot chip（appearance）/ 撳 chip 清 slot / 標已評估 / 重設（全部 audit CONSULT_STATE_EDITED）
 *   S8 截圖 + sweep + residue 0
 *
 * 冪等：開場 pre-sweep + 收場 end-sweep + fatal sweep（e2ec5 前綴全洗）。
 * 用法（repo root）：pnpm tsx scripts/e2e-consult-c5.ts [--base http://127.0.0.1:3100]
 * 輸出：C5-OK (N pass) / C5-FAIL: <reason>
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BASE = (process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://127.0.0.1:3100"
).replace(/\/$/, "");

/* host 全局 playwright-core（repo 唔帶依賴）— 同 e2e-schedule-ui.ts 同一 pattern */
/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};
/* eslint-enable @typescript-eslint/no-require-imports */

// ── constants ─────────────────────────────────────────────────────────
const CLINIC_CODE = "e2ec5";
const WA_ID = "85290019501"; // e2e 專用 WA id 範圍（零真 PII）
const PRODUCT_CODE = "e2ec5P";
const DOC_TITLE = "e2ec5 箍牙（矯齒）收費";
const SUP_EMAIL = "e2ec5-sup@wa-clinic.local";
const SUP_PASS = "e2ec5-Sup-pass01!";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function poll<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 45_000, intervalMs = 800): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    let v: T | null = null;
    try {
      v = await fn();
    } catch (e) {
      console.error(`    [poll ${what}] transient: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
    }
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`poll timeout: ${what}`);
    await sleep(intervalMs);
  }
}

// ── API helper ────────────────────────────────────────────────────────
async function login(email: string, pw: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!res.ok) throw new Error(`login ${email} → ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("login: no cookie");
  return cookie;
}
async function api(cookie: string, p: string, method: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

// ── mock inbound ──────────────────────────────────────────────────────
let wamidSeq = 0;
function newWamid(): string {
  wamidSeq += 1;
  return `wamid.MOCKe2ec5${Date.now().toString(36)}${wamidSeq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
function mockInbound(clinic: string, waId: string, text: string, wamid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn("pnpm", ["-s", "mock-inbound", "message", "--clinic", clinic, "--from", waId, "--text", text, "--wamid", wamid], {
      cwd: path.resolve(import.meta.dirname, ".."),
    });
    let err = "";
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mock-inbound exit ${code}: ${err.slice(0, 200)}`))));
  });
}
async function inbound(clinic: string, waId: string, text: string): Promise<{ msgId: string; convId: string }> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wamid = newWamid();
    try {
      await mockInbound(clinic, waId, text, wamid);
      const m = await poll(
        `IN message ${text.slice(0, 12)}`,
        async () => {
          // ★ 按 waMessageId 精確鎖定（e2ec5 前綴 wamid）— 舊版按 body 搜會撞上前 run orphan message（r4 實證）
          const row = await prisma.message.findUnique({ where: { waMessageId: wamid } });
          return row && row.direction === "IN" ? row : null;
        },
        30_000,
      );
      return { msgId: m.id, convId: m.conversationId };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.log(`  （inbound attempt ${attempt} 失敗 — loadManifest flake 重試）`);
      await sleep(2000);
    }
  }
  throw lastErr ?? new Error("inbound failed");
}

// ── sweep ─────────────────────────────────────────────────────────────
let sweepRef: ((label: string) => Promise<void>) | null = null;
async function sweep(label: string): Promise<void> {
  try {
    const clinic = await prisma.clinic.findUnique({ where: { code: CLINIC_CODE } });
    const clinicId = clinic?.id ?? null;
    const contacts = await prisma.contact.findMany({ where: { waId: WA_ID }, select: { id: true } });
    const contactIds = contacts.map((c) => c.id);
    // ★ convs = 真 conversation id（舊版誤用 contact id → conv/msg/draft/session 洗唔到 — r4 實證）
    const convs = (await prisma.conversation.findMany({ where: { contactId: { in: contactIds } }, select: { id: true } })).map((c) => c.id);
    if (convs.length > 0) {
      await prisma.$transaction([
        prisma.aiDraft.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.consultSession.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.message.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.conversation.deleteMany({ where: { id: { in: convs } } }),
      ]);
    }
    const products = await prisma.consultProduct.findMany({ where: { code: PRODUCT_CODE }, select: { id: true } });
    await prisma.contact.deleteMany({ where: { waId: WA_ID } });
    // orphan conv（contact 已冇 — 舊 sweep 漏洗殘留；dev DB 純 e2e 垃圾）連帶洗
    // ★ Conversation 只暴露 contactId（無 relation where）→ 用 code 計算 orphan
    const allConvs = await prisma.conversation.findMany({ select: { id: true, contactId: true } });
    const allContactIds = new Set((await prisma.contact.findMany({ select: { id: true } })).map((c) => c.id));
    const orphans = allConvs.filter((c) => !allContactIds.has(c.contactId)).map((c) => c.id);
    if (orphans.length > 0) {
      await prisma.$transaction([
        prisma.aiDraft.deleteMany({ where: { conversationId: { in: orphans } } }),
        prisma.consultSession.deleteMany({ where: { conversationId: { in: orphans } } }),
        prisma.message.deleteMany({ where: { conversationId: { in: orphans } } }),
        prisma.conversation.deleteMany({ where: { id: { in: orphans } } }),
      ]);
      await prisma.auditLog.deleteMany({ where: { entityId: { in: orphans } } });
    }
    await prisma.consultProduct.deleteMany({ where: { code: PRODUCT_CODE } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: products.map((p) => p.id) } } });
    await prisma.knowledgeDoc.deleteMany({ where: { title: DOC_TITLE } });
    if (clinicId) {
      // settings（clinic scope）+ audit（entityId 對上 / clinic 範圍）
      await prisma.consultSetting.deleteMany({ where: { clinicId } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: clinicId }, { meta: { path: ["clinicId"], equals: clinicId } }] } });
      // staff user（e2ec5 sup — 無 message/assign 先删到）
      const sup = await prisma.staffUser.findUnique({ where: { email: SUP_EMAIL } });
      if (sup) {
        const msgCount = await prisma.message.count({ where: { sentByStaffId: sup.id } });
        const assignCount = await prisma.conversation.count({ where: { assigneeId: sup.id } });
        if (msgCount === 0 && assignCount === 0) {
          await prisma.auditLog.deleteMany({ where: { staffId: sup.id } });
          await prisma.staffUser.delete({ where: { id: sup.id } });
        } else {
          await prisma.staffUser.update({ where: { id: sup.id }, data: { active: false } });
        }
      }
      await prisma.clinic.delete({ where: { id: clinicId } });
    }
    // global row 防泄漏（dev DB 無合法 global consult 設定；e2e 誤帶空 clinicId 會寫 global — 實證 2026-09-11）
    const globalRows = await prisma.consultSetting.findMany({ where: { clinicId: null }, select: { id: true } });
    if (globalRows.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: globalRows.map((g) => g.id) } } });
      await prisma.consultSetting.deleteMany({ where: { clinicId: null } });
    }
    console.log(`[sweep:${label}] 完成`);
  } catch (e) {
    console.error(`[sweep:${label}] FAILED:`, e instanceof Error ? e.message : e);
  }
}
sweepRef = sweep;

/** residue 核數（e2ec5 前綴全洗 — 必 0） */
async function residueCheck(): Promise<number> {
  const rows: Array<[string, number]> = [];
  const [products, docs, clinic] = await Promise.all([
    prisma.consultProduct.count({ where: { code: PRODUCT_CODE } }),
    prisma.knowledgeDoc.count({ where: { title: DOC_TITLE } }),
    prisma.clinic.findUnique({ where: { code: CLINIC_CODE } }),
  ]);
  rows.push(["consultProduct", products], ["knowledgeDoc", docs]);
  if (clinic) {
    const settings = await prisma.consultSetting.count({ where: { clinicId: clinic.id } });
    const audits = await prisma.auditLog.count({ where: { entityId: clinic.id } });
    rows.push(["consultSetting", settings], ["auditLog(clinic)", audits]);
  }
  const sup = await prisma.staffUser.findUnique({ where: { email: SUP_EMAIL } });
  rows.push(["staffUser", sup ? 1 : 0]);
  const contacts = await prisma.contact.count({ where: { waId: WA_ID } });
  rows.push(["contact", contacts]);
  const globalSettings = await prisma.consultSetting.count({ where: { clinicId: null } });
  rows.push(["consultSetting(global)", globalSettings]);
  let total = 0;
  for (const [n, c] of rows) {
    if (c > 0) {
      total += c;
      console.error(`  [residue] ${n} = ${c}`);
    }
  }
  return total;
}

// ── UI helper ─────────────────────────────────────────────────────────
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

interface LocatorLike {
  first: () => LocatorLike;
  nth: (i: number) => LocatorLike;
  count: () => Promise<number>;
  click: (o?: Record<string, unknown>) => Promise<void>;
  textContent: () => Promise<string | null>;
  fill: (v: string) => Promise<void>;
  inputValue: () => Promise<string>;
  selectOption: (v: string | { label?: string; index?: number }) => Promise<void>;
}
interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  getByTestId: (t: string) => LocatorLike;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (r: string, o?: Record<string, unknown>) => LocatorLike;
  locator: (sel: string, o?: Record<string, unknown>) => LocatorLike;
  evaluate: <T>(fn: (...a: unknown[]) => T, ...args: unknown[]) => Promise<T>;
  on: (ev: string, cb: (r: unknown) => void) => void;
  screenshot: (o: { path: string; fullPage?: boolean }) => Promise<void>;
  close: () => Promise<void>;
}
const L = (x: LocatorLike): LocatorLike => x;

// ── main ──────────────────────────────────────────────────────────────
void (async () => {
  await sweep("pre");

  const credsText = readFileSync(new URL("../.dev/credentials.txt", import.meta.url).pathname, "utf8");
  const adminLine = credsText.split("\n").find((l) => l.startsWith("ADMIN:")) ?? "";
  const [adminEmail, adminPw] = adminLine.split(": ").slice(1).join(": ").split(" / ");
  if (!adminEmail || !adminPw) throw new Error("credentials: missing ADMIN");
  const adminCookie = await login(adminEmail, adminPw);

  // ── S1 fixture ─────────────────────────────────────────────────────
  console.log("\n[S1] fixture");
  const clinicRes = await api(adminCookie, "/api/admin/clinics", "POST", {
    code: CLINIC_CODE,
    name: "e2ec5 測試診所",
    waPhoneNumberId: `e2ec5-phone-${Date.now()}`,
    waDisplayNumber: "+852 6000 5501",
    greetingConfig: {},
  });
  check("clinic e2ec5 建立", clinicRes.status === 200 || clinicRes.status === 201, JSON.stringify(clinicRes.json).slice(0, 150));
  const clinicId = (clinicRes.json?.id as string) ?? "";
  if (!clinicId) throw new Error("clinic id missing");

  const docRes = await api(adminCookie, "/api/admin/knowledge", "POST", {
    clinicId: null,
    kind: "PRICE",
    title: DOC_TITLE,
    keywords: ["箍牙", "矯齒", "e2ec5"],
    body: "e2ec5 箍牙收費範圍（測試）",
    disclaimer: "以上費用只係參考，實際費用要視乎牙齒情況，評估後先確認。",
    shortDisclaimer: "以到診評估為準",
    priceMin: 8000,
    priceMax: 30000,
  });
  check("PRICE doc 建立", docRes.status === 200 || docRes.status === 201, JSON.stringify(docRes.json).slice(0, 150));

  const pRes = await api(adminCookie, "/api/admin/consult-products", "POST", {
    clinicId: null,
    workflow: "ORTHODONTIC_CONSULT",
    code: PRODUCT_CODE,
    displayName: "e2ec5 透明托槽",
    category: "CLEAR_ALIGNER",
    approvedWording: "e2ec5 透明托槽，食飯可以拆，唔會明顯見到",
    timeWording: "e2ec5 大約 12 個月",
    avoidPhrases: ["e2ec5 唔會講保證"],
    positioning: "e2ec5 透明、隱形",
    priceDocTitle: DOC_TITLE,
    enabled: true,
  });
  check("product e2ec5P 建立（未簽署）", pRes.status === 200 || pRes.status === 201, JSON.stringify(pRes.json).slice(0, 150));
  const productId = ((pRes.json?.product as { id?: string })?.id ?? (pRes.json?.id as string) ?? "");
  if (!productId) throw new Error("product id missing");

  const supRes = await api(adminCookie, "/api/admin/staff", "POST", {
    name: "e2ec5 主管",
    email: SUP_EMAIL,
    password: SUP_PASS,
    role: "SUPERVISOR",
    clinicId: null,
  });
  check("SUPERVISOR user 建立", supRes.status === 200 || supRes.status === 201, JSON.stringify(supRes.json).slice(0, 150));
  const supCookie = await login(SUP_EMAIL, SUP_PASS).catch((e) => {
    check("SUPERVISOR 登入", false, String(e));
    return "";
  });

  // ── S2 簽署（UI） ──────────────────────────────────────────────────
  console.log("\n[S2] 簽署（UI：確認 → approvedAt；改欄位 → 清空）");
  const browser = (await chromium.launch({ headless: true, executablePath: findChromium() })) as unknown as {
    newContext: (o: Record<string, unknown>) => Promise<{ addCookies: (c: unknown[]) => Promise<void>; newPage: () => Promise<PageLike>; close: () => Promise<void> }>;
    close: () => Promise<void>;
  };
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cookieName = adminCookie.split("=")[0];
  await ctxA.addCookies([{ name: cookieName, value: adminCookie.split("=")[1], domain: "127.0.0.1", path: "/" }]);
  const A = await ctxA.newPage();

  await A.goto(`${BASE}/admin/consult`, { waitUntil: "domcontentloaded" });
  await A.waitForTimeout(2500);
  check("設定頁 render（c5-root）", (await L(A.getByTestId("c5-root")).count()) > 0);

  // 揀中 e2ec5P chip
  const chip = A.getByText("e2ec5 透明托槽", { exact: false });
  await L(chip).first().click();
  await A.waitForTimeout(600);
  check("簽署列（未確認狀態）見「醫生確認：」", (await A.getByText("醫生確認：").count()) > 0);

  // 撳確認
  await L(A.getByTestId("c5-approve-btn")).click();
  await A.waitForTimeout(1500);
  const prodAfterApprove = await api(adminCookie, `/api/admin/consult-products/${productId}`, "GET");
  const prod1 = (prodAfterApprove.json?.product as Record<string, unknown>) ?? {};
  check("UI 撳確認 → approvedAt 有值", prod1.approvedAt != null, JSON.stringify({ approvedAt: prod1.approvedAt, approvedBy: prod1.approvedBy }));
  check("approvedBy = 診所管理員（未填名）", prod1.approvedBy === "診所管理員", String(prod1.approvedBy));
  const apprAudits = await prisma.auditLog.count({ where: { action: "CONSULT_PRODUCT_APPROVED", entityId: productId } });
  check("audit CONSULT_PRODUCT_APPROVED ×1", apprAudits === 1, String(apprAudits));
  await A.screenshot({ path: "/tmp/kairo-consult-c5-tab1-approved.png", fullPage: true });
  check("UI 簽署列顯示「已由 診所管理員 確認」", (await A.getByText("已由 診所管理員 確認", { exact: false }).count()) > 0);

  // 改欄位 → approvedAt 清空
  const dn = L(A.getByTestId("c5-displayName"));
  await dn.fill("e2ec5 透明托槽 v2");
  await A.waitForTimeout(1800); // debounce 600ms + PUT
  const prodAfterEdit = await api(adminCookie, `/api/admin/consult-products/${productId}`, "GET");
  const prod2 = (prodAfterEdit.json?.product as Record<string, unknown>) ?? {};
  check("改 displayName → approvedAt 自動清空", prod2.approvedAt == null, JSON.stringify({ approvedAt: prod2.approvedAt }));
  const woRes = await api(adminCookie, `/api/admin/consult-products/${productId}`, "PUT", {
    approvedWording: "e2ec5 新版講法：透明、可以拆、唔明顯",
  });
  const prod3row = await prisma.consultProduct.findUnique({ where: { id: productId } });
  check("PUT approvedWording → positioning 自動同步", prod3row?.positioning === "e2ec5 新版講法：透明、可以拆、唔明顯", String(prod3row?.positioning));
  check("PUT 回應帶 approvalCleared + approvedAt 清空", woRes.json?.approvalCleared === true && woRes.json?.approvedAt == null, JSON.stringify(woRes.json).slice(0, 200));
  await A.screenshot({ path: "/tmp/kairo-consult-c5-tab1-unapproved.png", fullPage: true });

  // ── S3 預覽 ────────────────────────────────────────────────────────
  console.log("\n[S3] 預覽（真 pipeline 三核對 + CG 紅 ✗ + 零寫入）");
  const sessBefore = await prisma.consultSession.count();
  const prev = await api(adminCookie, "/api/admin/consult/preview", "POST", { workflow: "ORTHODONTIC_CONSULT", clinicId: null });
  const pj = (prev.json ?? {}) as Record<string, unknown>;
  check("preview 200 + draft 非空", prev.status === 200 && typeof pj.draft === "string" && (pj.draft as string).length > 10, JSON.stringify(pj).slice(0, 200));
  const checksArr = (pj.checks as { label: string; pass: boolean }[]) ?? [];
  check("preview 三核對全綠", checksArr.length === 3 && checksArr.every((c) => c.pass), JSON.stringify(checksArr));
  check("preview blocked=false / cgCode=null", pj.blocked === false && pj.cgCode == null);
  check("preview 未簽署產品計數（e2ec5P 已清空 = 至少 1 未確認）", (pj.unapprovedCount as number) >= 1, String(pj.unapprovedCount));

  // CG-004 bait → 紅 ✗
  const prevBait = await api(adminCookie, "/api/admin/consult/preview", "POST", {
    workflow: "ORTHODONTIC_CONSULT",
    clinicId: null,
    demoQuestion: "E2E-CG-004 c5 bait",
  });
  const bj = (prevBait.json ?? {}) as Record<string, unknown>;
  check("preview CG-004 bait → blocked + cgCode=CG-004", bj.blocked === true && bj.cgCode === "CG-004", JSON.stringify({ blocked: bj.blocked, cgCode: bj.cgCode }));
  const bChecks = (bj.checks as { label: string; pass: boolean }[]) ?? [];
  check("CG bait 三核對：保證療程時間 = ✗", bChecks.some((c) => c.label.includes("保證療程時間") && c.pass === false), JSON.stringify(bChecks));

  const sessAfter = await prisma.consultSession.count();
  check("preview 零寫入（session 數不變）", sessBefore === sessAfter, `${sessBefore} → ${sessAfter}`);

  // UI 預覽區（green）
  const draftBox = L(A.getByTestId("c5-preview-draft"));
  try {
    await poll(
      "UI preview draft",
      async () => {
        const t = (await draftBox.textContent()) ?? "";
        return t.length > 10 && !t.includes("思考緊") && !t.includes("載入中") ? t : null;
      },
      20_000,
    );
    check("UI 預覽區有草稿文字", true);
  } catch {
    check("UI 預覽區有草稿文字", false);
  }
  const checkEls = await A.getByText("冇講「你一定要做邊款」").count();
  check("UI 預覽區三核對行顯示", checkEls > 0);
  await A.screenshot({ path: "/tmp/kairo-consult-c5-preview.png", fullPage: true });

  // ── S4 設定 CRUD（API，clinic scope = e2ec5） ──────────────────────
  console.log("\n[S4] 設定 CRUD（clinic scope）");
  const s0 = await api(adminCookie, `/api/admin/consult-settings?clinicId=${clinicId}`, "GET");
  const eff0 = (s0.json?.effective as Record<string, unknown>) ?? {};
  const adv0 = (eff0.advanced as Record<string, unknown>) ?? {};
  const advOk = s0.status === 200 && adv0.maxTurns === 8 && adv0.ctaAfterTurns === 6 && adv0.sessionIdleHours === 48;
  check("GET 預設（無 row）= defaults 8/6/48", advOk, JSON.stringify(adv0));
  if (!advOk) throw new Error("★ 污染：global ConsultSetting row 殘留 — 先清 DB 先重跑");

  const putRules = await api(adminCookie, "/api/admin/consult-settings", "PUT", {
    clinicId,
    key: "rules",
    value: { ortho_appearance: true, ortho_compare: false, ortho_price: true, ortho_booking: true },
  });
  check("PUT rules（ortho_compare=false）200", putRules.status === 200, JSON.stringify(putRules.json).slice(0, 150));
  const s1 = await api(adminCookie, `/api/admin/consult-settings?clinicId=${clinicId}`, "GET");
  const eff1 = (s1.json?.effective as Record<string, unknown>) ?? {};
  check("GET 反映 rules + disabledRules 含 ORTHO-003", (eff1.rules as Record<string, boolean>).ortho_compare === false && (eff1.disabledRules as Record<string, boolean>)["ORTHO-003"] === true, JSON.stringify({ rules: eff1.rules, disabledRules: eff1.disabledRules }));

  const putDisc = await api(adminCookie, "/api/admin/consult-settings", "PUT", {
    clinicId,
    key: "discovery",
    value: {
      questions: [
        { id: "q1", text: "e2ec5 改咗第一問？", enabled: true },
        { id: "q2", text: "你會唔會都比較在意療程快唔快？", enabled: false },
      ],
      askBudget: false,
    },
  });
  check("PUT discovery（改 q1 + 關 q2）200", putDisc.status === 200);
  const s2 = await api(adminCookie, `/api/admin/consult-settings?clinicId=${clinicId}`, "GET");
  const eff2 = (s2.json?.effective as Record<string, unknown>) ?? {};
  const qs = (eff2.discovery as { questions: { id: string; text: string; enabled: boolean }[] }) ?? { questions: [] };
  check("GET 反映 discovery 改動", qs.questions.find((q) => q.id === "q1")?.text === "e2ec5 改咗第一問？" && qs.questions.find((q) => q.id === "q2")?.enabled === false, JSON.stringify(qs));
  check("discoverySkipSlots 含 speedPriority（q2 關）", ((eff2.discoverySkipSlots as string[]) ?? []).includes("speedPriority"), JSON.stringify(eff2.discoverySkipSlots));

  const putAdv = await api(adminCookie, "/api/admin/consult-settings", "PUT", {
    clinicId,
    key: "advanced",
    value: { maxTurns: 10, ctaAfterTurns: 6, sessionIdleHours: 48, extraTriggerWords: [] },
  });
  check("PUT advanced（maxTurns=10）200", putAdv.status === 200);
  const s3 = await api(adminCookie, `/api/admin/consult-settings?clinicId=${clinicId}`, "GET");
  check("GET 反映 maxTurns=10", ((s3.json?.effective as { advanced?: { maxTurns?: number } }).advanced?.maxTurns) === 10);

  const badKey = await api(adminCookie, "/api/admin/consult-settings", "PUT", { clinicId, key: "nope", value: {} });
  check("壞 key → 400", badKey.status === 400, String(badKey.status));

  const settingsAudits = await prisma.auditLog.count({
    where: { action: "CONSULT_SETTINGS_UPDATE", meta: { path: ["clinicId"], equals: clinicId } },
  });
  check("audit CONSULT_SETTINGS_UPDATE ≥3", settingsAudits >= 3, String(settingsAudits));

  // ── S5 UI 三 tab + 零技術詞 ────────────────────────────────────────
  console.log("\n[S5] 三 tab render + 零技術詞");
  // Tab 2（先切 scope = e2ec5 — S4 寫咗 clinic scope 設定，核返 UI 反映）
  await A.locator("select").first().selectOption(clinicId);
  await A.waitForTimeout(1200);
  await L(A.getByText("AI 會點傾", { exact: true })).first().click();
  await A.waitForTimeout(800);
  check("Tab2 render（c5-tab2）", (await L(A.getByTestId("c5-tab2")).count()) > 0);
  check("Tab2 白話規則行（連珠炮）", (await A.getByText("唔會連珠炮發問", { exact: false }).count()) > 0);
  const taCount = await A.locator("textarea").count();
  const q1Val = (await A.locator("textarea").first().inputValue()) ?? "";
  check("Tab2 discovery 兩條問題（textarea）", taCount >= 2, String(taCount));
  check("Tab2 反映 S4 改動（q1 = e2ec5 改咗第一問？）", q1Val === "e2ec5 改咗第一問？", q1Val);
  check("Tab2 問預算 = 診所選擇唔問（鎖定）", (await A.getByText("診所選擇唔問", { exact: false }).count()) > 0);
  await A.screenshot({ path: "/tmp/kairo-consult-c5-tab2.png", fullPage: true });

  // Tab 3（ADMIN）
  await L(A.getByText("進階設定", { exact: true })).first().click();
  await A.waitForTimeout(600);
  check("Tab3 render（c5-tab3，ADMIN 見到）", (await L(A.getByTestId("c5-tab3")).count()) > 0);
  check("Tab3 對話節奏", (await A.getByText("對話節奏", { exact: false }).count()) > 0);
  check("Tab3 安全檢查（一直開緊）", (await A.getByText("安全檢查", { exact: false }).count()) > 0);
  await A.screenshot({ path: "/tmp/kairo-consult-c5-tab3.png", fullPage: true });

  // 零技術詞：醫生可見區域 = c5-root 全部 visible text（三 tab 都核）
  const bannedWords = ["slot", "stage", "rule", "positioning", "candidate", "workflow", "action", "ORTHO-", "IMPLANT-", "CG-", "DISCOVER", "EDUCATE", "PRESENT_OPTIONS", "humanTookOver", "consult"];
  const collectBanned = async (): Promise<string[]> => {
    const texts: string[] = [];
    for (const tabName of ["方案資料", "AI 會點傾", "進階設定"]) {
      await L(A.getByText(tabName, { exact: true })).first().click();
      await A.waitForTimeout(500);
      const t = await A.evaluate((sel) => {
        const el = document.querySelector(String(sel)) as HTMLElement | null;
        return el ? el.innerText : "";
      }, "[data-testid='c5-root']");
      texts.push(t);
    }
    return texts.flatMap((t) => bannedWords.filter((w) => t.toLowerCase().includes(w.toLowerCase())));
  };
  const hits = await collectBanned();
  check("零技術詞（三 tab visible text 無禁詞）", hits.length === 0, JSON.stringify([...new Set(hits)]));

  // Tab 1 截圖（回 global scope + products tab）
  await A.locator("select").first().selectOption("global");
  await A.waitForTimeout(800);
  await L(A.getByText("方案資料", { exact: true })).first().click();
  await A.waitForTimeout(500);
  await A.screenshot({ path: "/tmp/kairo-consult-c5-tab1.png", fullPage: true });

  // ── S6 非 ADMIN（SUPERVISOR） ──────────────────────────────────────
  console.log("\n[S6] 非 ADMIN 唔見到進階");
  if (supCookie) {
    const ctxS = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctxS.addCookies([{ name: cookieName, value: supCookie.split("=")[1], domain: "127.0.0.1", path: "/" }]);
    const S = await ctxS.newPage();
    await S.goto(`${BASE}/admin/consult`, { waitUntil: "domcontentloaded" });
    await S.waitForTimeout(2500);
    const supRoot = await L(S.getByTestId("c5-root")).count();
    check("SUPERVISOR 可以入頁（唯讀）", supRoot > 0);
    check("SUPERVISOR 見唔到「進階設定」", (await S.getByText("進階設定", { exact: true }).count()) === 0);
    const navCount = await S.locator('a[href="/admin/consult"]').count();
    check("SUPERVISOR nav 唔列 AI 傾偈設定", navCount === 0, String(navCount));
    const supPut = await api(supCookie, "/api/admin/consult-settings", "PUT", { clinicId, key: "rules", value: { ortho_appearance: true, ortho_compare: true, ortho_price: true, ortho_booking: true } });
    check("SUPERVISOR PUT settings → 403", supPut.status === 403, String(supPut.status));
    await ctxS.close();
  } else {
    check("SUPERVISOR 段（skip — 登入失敗）", false);
  }

  // ── S7 狀態卡（inbox UI） ──────────────────────────────────────────
  console.log("\n[S7] 側欄狀態卡 + 來源標記");
  // warm-up：耗 R-7 first-reply 閘 + engine turn 1（ASK_DISCOVERY）；DRAFT clinic → draft 落 pending
  const w = await inbound(CLINIC_CODE, WA_ID, "我想箍牙");
  const convId = w.convId;
  await poll(
    "consult session active",
    async () => {
      const s = await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
      return s ?? null;
    },
    60_000,
  );
  check("warm-up → active session（DISCOVER）", true);
  let pending: { status: string; mode: string; draftText: string; model: string } | null = null;
  try {
    pending = await poll(
      "pending AI draft（DRAFT clinic）",
      async () => {
        const d = await prisma.aiDraft.findFirst({ where: { conversationId: convId, status: "PROPOSED" } });
        return d ?? null;
      },
      60_000,
    );
  } catch (e) {
    // ★ 診斷 dump（失敗時先至出）
    const convD = await prisma.conversation.findUnique({ where: { id: convId } });
    const allD = await prisma.aiDraft.findMany({ where: { conversationId: convId }, orderBy: { id: "desc" }, take: 5 });
    const inMsgD = await prisma.message.findFirst({ where: { direction: "IN", body: "我想箍牙" }, orderBy: { id: "desc" } });
    const sessD = await prisma.consultSession.findFirst({ where: { conversationId: convId } });
    console.log("[diag] conv:", JSON.stringify({ id: convD?.id, clinicId: convD?.clinicId, lastInboundAt: convD?.lastInboundAt, humanTookOver: convD?.humanTookOver }));
    console.log("[diag] convId 同 IN msg conv match:", inMsgD?.conversationId === convId, "msgConv:", inMsgD?.conversationId);
    console.log("[diag] session:", JSON.stringify({ st: sessD?.stage, t: sessD?.turnCount, la: sessD?.lastAction }));
    for (const d of allD) console.log("[diag] draft row:", d.status, d.mode, d.model, JSON.stringify(d.draftText).slice(0, 60));
    if (allD.length === 0) console.log("[diag] ★ 冇任何 draft row — canDraft 被 gate 掉（window/takeover/suppress）");
    throw e;
  }
  check("DRAFT clinic → AI 草稿落 pending（未自動發）", pending.status === "PROPOSED");

  await A.goto(`${BASE}/inbox?conv=${convId}`, { waitUntil: "domcontentloaded" });
  await A.waitForTimeout(3000);
  const card = L(A.getByTestId("consult-status-card"));
  await poll("status card render", async () => ((await card.count()) > 0 ? true : null), 30_000);
  check("狀態卡 render", (await card.count()) > 0);
  const cardText0 = (await card.textContent()) ?? "";
  check("卡片有「銷售對話」+「階段」+「了解需求中」", cardText0.includes("銷售對話") && cardText0.includes("階段") && cardText0.includes("了解需求中"), cardText0.slice(0, 120));
  const bannedCard = ["DISCOVER", "EDUCATE", "PRESENT_OPTIONS", "stage", "slot", "rule", "humanTookOver", "turnCount"];
  const cardHits = bannedCard.filter((w2) => cardText0.toLowerCase().includes(w2.toLowerCase()));
  check("狀態卡全中文（無英文 stage/slot/rule 詞）", cardHits.length === 0, JSON.stringify(cardHits));
  // ★ S4 已將 e2ec5 clinic maxTurns 改 10 — 卡顯示 n/10（證明 clinic scope 設定流入 engine + 卡）
  check("卡片有「意向」+「輪數 1 / 10」（S4 maxTurns=10 生效）", cardText0.includes("意向") && cardText0.includes("1 / 10"), cardText0.slice(0, 160));

  // 採用並編輯 → 發送（source adopted）
  const draftCard = L(A.getByTestId("c5-draft-card"));
  await poll("draft card render", async () => ((await draftCard.count()) > 0 ? true : null), 30_000);
  await L(A.getByText("採用並編輯", { exact: true })).first().click();
  await A.waitForTimeout(800);
  const composerVal = (await L(A.getByTestId("c5-composer")).inputValue()) ?? "";
  check("採用並編輯 → composer 填入草稿", composerVal.length > 10, composerVal.slice(0, 60));
  await L(A.getByTestId("c5-send-btn")).click();
  await poll(
    "OUT message (adopted)",
    async () => {
      const m = await prisma.message.findFirst({ where: { conversationId: convId, direction: "OUT" }, orderBy: { createdAt: "desc" } });
      return m ?? null;
    },
    30_000,
  );
  const out1 = await prisma.message.findFirst({ where: { conversationId: convId, direction: "OUT" }, orderBy: { createdAt: "desc" } });
  check("採用發送 → sentVia=AI_ADOPTED", out1?.sentVia === "AI_ADOPTED", String(out1?.sentVia));
  const conv1 = await prisma.conversation.findUnique({ where: { id: convId } });
  check("adopted → humanTookOver 唔會置 true", conv1?.humanTookOver === false);

  // inbound #2 → engine t2（appearance/speed slots）— mock 模式 continuation 要 FLOOR 詞（箍牙）
  await inbound(CLINIC_CODE, WA_ID, "我箍牙唔想俾人見到，越快越好");
  let slotS: { slots?: unknown } | null = null;
  try {
    slotS = await poll(
      "slot appearancePriority=HIGH",
      async () => {
        const s = await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
        const slots = (s?.slots as Record<string, unknown>) ?? {};
        return slots.appearancePriority === "HIGH" ? (s as unknown as { slots?: unknown }) : null;
      },
      60_000,
    );
  } catch (e) {
    // ★ 診斷 dump（失敗時先至出）
    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    const sess = await prisma.consultSession.findFirst({ where: { conversationId: convId } });
    const msgs = await prisma.message.findMany({ where: { conversationId: convId }, orderBy: { createdAt: "desc" }, take: 4 });
    const sets = conv ? await prisma.consultSetting.findMany({ where: { clinicId: conv.clinicId } }) : [];
    const aud = await prisma.auditLog.findMany({ where: { action: { in: ["CONSULT_ENGINE_TURN", "CONSULT_LLM_TURN", "CONSULT_EXTRACT"] }, createdAt: { gt: new Date(Date.now() - 5 * 60000) } }, orderBy: { createdAt: "asc" }, take: 12 });
    console.log("[diag] conv:", JSON.stringify({ id: conv?.id, clinicId: conv?.clinicId, humanTookOver: conv?.humanTookOver, lastOut: conv?.lastOutboundText?.slice(0, 40) }));
    console.log("[diag] clinicId 同 fixture:", clinicId, "match:", conv?.clinicId === clinicId);
    console.log("[diag] session:", JSON.stringify({ t: sess?.turnCount, la: sess?.lastAction, st: sess?.stage, slots: sess?.slots, asked: sess?.askedSlots }));
    for (const m of msgs) console.log("[diag] msg:", m.direction, m.sentVia ?? "-", JSON.stringify(m.body).slice(0, 50));
    for (const s of sets) console.log("[diag] setting:", s.key, JSON.stringify(s.value).slice(0, 120));
    for (const a of aud) console.log("[diag] audit:", a.action, JSON.stringify(a.meta).slice(0, 160));
    throw e;
  }
  check("engine t2 → appearancePriority=HIGH 入庫", ((slotS?.slots as Record<string, unknown>) ?? {}).appearancePriority === "HIGH", JSON.stringify(slotS?.slots));
  // chip 順序跟 slots 插入序（§8.2 冇固定順序）→ data-slot 精確選 appearancePriority chip，唔假設 first（斷言語義不變）
  const apChip = A.locator('[data-testid="c5-card-slot"][data-slot="appearancePriority"]');
  await poll("card slot chip (appearancePriority)", async () => ((await L(apChip).count()) > 0 ? true : null), 20_000);
  check("卡片「已知」chip 出現（重視外觀）", (await L(apChip).count()) > 0);
  const chipText = (await L(apChip).first().textContent()) ?? "";
  check("chip 係白話（重視外觀）", chipText.includes("重視外觀"), chipText);

  // 撳 chip 清 slot（精確撳 appearancePriority 嗰粒）
  await L(apChip).first().click();
  await poll(
    "slot cleared",
    async () => {
      const s = await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
      const slots = (s?.slots as Record<string, unknown>) ?? {};
      return "appearancePriority" in slots ? null : true;
    },
    20_000,
  );
  check("撳 chip → slot 清掉（店員改 slot）", true);

  // 標記為已評估
  await L(A.getByTestId("c5-card-assess")).click();
  await poll(
    "assessed",
    async () => {
      const s = await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
      return (s?.slots as Record<string, unknown>)?.clinicalSuitability === "ASSESSED" ? true : null;
    },
    20_000,
  );
  check("標記為已評估 → clinicalSuitability=ASSESSED", true);
  await A.waitForTimeout(2500); // 卡片 5s poll
  const cardText1 = (await card.textContent()) ?? "";
  check("卡片顯示「已評估」", cardText1.includes("已評估"), cardText1.slice(0, 160));
  await A.screenshot({ path: "/tmp/kairo-consult-c5-statuscard.png", fullPage: true });

  // 自己打字 → typed + AI 已暫停（先清空 composer = 由零重新打字 → 採用旗清）
  await L(A.getByTestId("c5-composer")).fill("");
  await L(A.getByTestId("c5-composer")).fill("e2ec5 人手補充：週五返得嚟");
  await L(A.getByTestId("c5-send-btn")).click();
  await poll(
    "OUT message (typed)",
    async () => {
      const ms = await prisma.message.findMany({ where: { conversationId: convId, direction: "OUT" }, orderBy: { createdAt: "asc" } });
      return ms.some((m) => m.sentVia === "HUMAN_TYPED") ? true : null;
    },
    30_000,
  );
  check("自己打字 → sentVia=HUMAN_TYPED", true);
  const conv2 = await prisma.conversation.findUnique({ where: { id: convId } });
  check("typed → humanTookOver=true", conv2?.humanTookOver === true);
  await poll("card 已暫停 banner", async () => ((await L(A.getByTestId("c5-card-paused")).count()) > 0 ? true : null), 15_000);
  check("卡片顯示「AI 已暫停」+ 交返掣", (await L(A.getByTestId("c5-card-resume")).count()) > 0);

  // 交返 AI 繼續
  await L(A.getByTestId("c5-card-resume")).click();
  await poll(
    "resumed",
    async () => {
      const c2 = await prisma.conversation.findUnique({ where: { id: convId } });
      return c2?.humanTookOver === false ? true : null;
    },
    20_000,
  );
  check("交返 AI 繼續 → humanTookOver=false", true);

  // 重設
  A.on("dialog", ((d: { accept: () => Promise<void> }) => void d.accept()) as (r: unknown) => void);
  await L(A.getByTestId("c5-card-reset")).click();
  await poll(
    "reset",
    async () => {
      const s = await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
      return s && s.turnCount === 0 && Object.keys((s.slots as object) ?? {}).length === 0 ? true : null;
    },
    20_000,
  );
  check("重設 → turnCount=0 + slots 清空", true);

  const stateSession = await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
  const stateAudits = await prisma.auditLog.findMany({
    where: { action: "CONSULT_STATE_EDITED", entityId: stateSession?.id ?? "" },
    select: { meta: true },
  });
  const ops = stateAudits.map((a) => ((a.meta as Record<string, unknown>)?.op as string) ?? "");
  check("audit CONSULT_STATE_EDITED 齊 ops（clearSlot/assess/resume/reset）", ["clearSlot", "assess", "resume", "reset"].every((o) => ops.includes(o)), JSON.stringify(ops));

  // ── S8 sweep + residue ─────────────────────────────────────────────
  console.log("\n[S8] sweep + residue");
  await ctxA.close();
  await browser.close();
  await sweep("end");
  const residue = await residueCheck();
  check("fixture sweep residue = 0", residue === 0);

  console.log(`\n══ C5 結果：${pass} pass / ${fail} fail ══`);
  if (fail > 0) {
    console.error("C5-FAIL");
    process.exitCode = 1;
  } else {
    console.log(`C5-OK (${pass} pass)`);
  }
  await prisma.$disconnect();
  process.exit(process.exitCode ?? 0);
})().catch(async (e) => {
  console.error("C5-FAIL:", e instanceof Error ? e.stack ?? e.message : e);
  try {
    await sweepRef?.("fatal");
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  process.exit(1);
});
