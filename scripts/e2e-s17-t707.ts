/**
 * e2e-s17-t707 — cwi-final S1-7 T707：事件格式契約（unit）+ ids-only conv:updated（e2e）
 *
 * spec 原文（S1-7 測試 T707）：
 *   unit — 每個 emitter 嘅 payload 過 schema；
 *   e2e — emit ids-only `conv:updated` → row 負責人／unread 唔變。
 *
 * UNIT 部分（純 import，無 UI）：
 *   U1 EVENT_SCHEMAS 全部 20 個事件 × 對應該 emitter 真實形態嘅樣本 payload（+eventId）→ parse 全過
 *   U2 `buildMessageNewPayload(<real messageId>)`（message:new 單一來源）→ parse 過
 *   U3 負控：conv:updated 缺 clinicId → parse 必炸（證明 U1 非自證）
 *   U4 負控：message:new 缺 message 體 → parse 必炸
 *   U5 ids-only conv:updated（conversationId + clinicId + eventId，零 patch 欄）→ parse 過（S1-7 契約）
 *
 * E2E 部分（playwright UI）：
 *   E1 初始 row：負責人 chip（● E2E S17 Assn 處理中）+ unread badge 3
 *   E2 emit ids-only conv:updated → row 負責人 chip + unread badge 唔變
 *   E3 liveness 對照：emit conv:updated {unreadCount: 9} → badge 變 9（證明 socket 路徑活 +
 *      前面 ids-only 冇洗走 row／冇阻 handler）；負責人 chip 照舊
 *
 * 前置：dev stack live（server 3100 + DB 15432 + redis 6379）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s17-t707.ts
 * 輸出：T707-OK / T707-FAIL: <reason>（exit 1）
 */
import "./e2e-origin-shim";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { EVENT_SCHEMAS } from "@/lib/realtime-events";
import { buildMessageNewPayload } from "@/lib/realtime-payload";
import { publishConvEvent, convRef } from "@/lib/notify";

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

const COMPANY_CODE = "E2ES17-CO";
const CLINIC_A = "E2ES17-A";
const VIEWER_EMAIL = "e2e-s17v@wa-clinic.local";
const ASSN_EMAIL = "e2e-s17a@wa-clinic.local";
const ASSN_NAME = "E2E S17 Assn";
const PASS = "e2e-s17-pass-2026";
const WA_ID = "99081501";
const WA_PREFIX = "990815";
const CONV_ID = "e2es17conv0000000t707a"; // 23 位 lowercase alnum（cuid 形）
const CONTACT_NAME = "E2ES17 P0001";
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
  else fail(`${label}${detail !== undefined ? `（${JSON.stringify(detail)}）` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_A}'))`);
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: { in: [VIEWER_EMAIL, ASSN_EMAIL] } } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: [VIEWER_EMAIL, ASSN_EMAIL] } } });
  await prisma.clinic.deleteMany({ where: { code: { in: [CLINIC_A] } } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<{ clinicA: string; assnId: string; messageId: string }> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES17 CO" } });
  const ca = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_A, name: "E2ES17 Clinic A", waPhoneNumberId: "E2ES17-A-PH", waDisplayNumber: "+852 0000 7161" },
  });
  const argon2 = (await import("argon2")).default;
  const viewer = await prisma.staffUser.create({
    data: { email: VIEWER_EMAIL, name: "E2E S17 Viewer", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  const assn = await prisma.staffUser.create({
    data: { email: ASSN_EMAIL, name: ASSN_NAME, role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  await prisma.staffClinic.create({ data: { staffId: viewer.id, clinicId: ca.id, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: assn.id, clinicId: ca.id, isPrimary: true } });
  const ct = await prisma.contact.create({
    data: { clinicId: ca.id, waId: WA_ID, profileName: CONTACT_NAME, labels: [] },
  });
  await prisma.conversation.create({
    data: {
      id: CONV_ID,
      clinicId: ca.id,
      contactId: ct.id,
      status: "OPEN",
      assigneeId: assn.id,
      unreadCount: 3,
      lastMessageAt: new Date(TS - 60_000),
    },
  });
  const msg = await prisma.message.create({
    data: {
      conversationId: CONV_ID,
      waMessageId: `wamid.t707.${TS}.1`,
      direction: "IN",
      channel: "API",
      type: "text",
      body: `T707MSG-${TS}`,
      status: "RECEIVED",
      waTimestamp: new Date(TS - 60_000),
      createdAt: new Date(TS - 60_000),
    },
  });
  return { clinicA: ca.id, assnId: assn.id, messageId: msg.id };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}

// ── playwright 最小型別（跟 e2e-s13-t611.ts 慣例）─────────────────────────
interface Loc {
  count: () => Promise<number>;
  first: () => Loc;
  locator: (s: string) => Loc;
  waitFor: (o: Record<string, unknown>) => Promise<void>;
  isVisible: () => Promise<boolean>;
  textContent: () => Promise<string | null>;
}
interface Page {
  goto: (u: string, o: Record<string, unknown>) => Promise<void>;
  locator: (s: string) => Loc;
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
  const dirs = fs.readdirSync(baseDir).filter((d): boolean => d.startsWith("chromium-")).sort().reverse();
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

// ══ UNIT 部分 ════════════════════════════════════════════════════════════════

/** 每事件一份「對應 emitter 真實形態」樣本（欄位跟各 emitter 現行發射 + schema 口徑）。 */
function unitSamples(): Record<string, Record<string, unknown>> {
  const nowIso = "2026-09-21T00:00:00.000Z";
  return {
    "message:new": {
      conversationId: CONV_ID,
      clinicId: "clinic-x",
      contact: { id: "contact-x", waId: "9900000000", profileName: "E2E U", labels: [] },
      message: {
        id: "msg-x",
        conversationId: CONV_ID,
        waMessageId: "wamid.u.1",
        direction: "IN",
        channel: "API",
        type: "text",
        body: "e2e unit",
        mediaPath: null,
        mediaStatus: "READY",
        clientMessageId: null,
        status: "RECEIVED",
        errorCode: null,
        sentByStaffId: null,
        aiAutoSent: false,
        waTimestamp: new Date(nowIso),
        createdAt: new Date(nowIso),
      },
      conversation: { status: "OPEN", unreadCount: 1, lastMessageAt: new Date(nowIso), lastInboundAt: new Date(nowIso), reopenedAt: null },
    },
    "message:status": { conversationId: CONV_ID, clinicId: "clinic-x", waMessageId: "wamid.u.1", status: "SENT", errorCode: null, voidedAt: null },
    "conv:updated": { conversationId: CONV_ID, clinicId: "clinic-x", status: "OPEN", assigneeId: null, assignVersion: 1, unreadCount: 0 },
    "conversation:assigned": { conversationId: CONV_ID, clinicId: "clinic-x", assigneeId: "staff-x", byStaffId: "staff-y", assignVersion: 1 },
    "draft:ready": {
      conversationId: CONV_ID,
      draftId: "draft-x",
      inReplyToMessageId: "msg-x",
      draftText: "unit draft",
      model: "unit-model",
      latencyMs: 10,
      mode: "DRAFT",
      traceJson: null,
    },
    "ai:classified": {
      conversationId: CONV_ID,
      intent: "QUESTION",
      urgency: "NORMAL",
      needsHuman: false,
      urgent: false,
      aiSummary: "unit summary",
      hasDraft: true,
      aiMode: "AUTO",
      autoLevel: "L2",
      autoSent: false,
    },
    "urgent:escalation": { conversationId: CONV_ID, intent: "COMPLAINT", urgency: "HIGH", contactId: "contact-x", contactName: "E2E U", waMessageId: null },
    "notice:new": { conversationId: null, clinicId: "clinic-x", kind: "sla", reason: "unassigned", title: null, count: 1 },
    "note:new": { conversationId: CONV_ID, clinicId: "clinic-x", messageId: "msg-x" },
    "note:read": { conversationId: CONV_ID, clinicId: "clinic-x", messageId: "msg-x", staffId: "staff-x", readAt: nowIso },
    "media:ready": { conversationId: CONV_ID, clinicId: "clinic-x", messageId: "msg-x", mediaPath: "/data/media/unit.jpg" },
    "patient:pinned": { conversationId: CONV_ID, clinicId: "clinic-x", pinnedPatientApricotId: "apricot-u-1" },
    "booking:new": {
      conversationId: CONV_ID,
      clinicId: "clinic-x",
      booking: {
        id: "booking-x",
        providerName: "Dr U",
        requestedDate: "2026-09-22",
        requestedTime: "10:00",
        timeOfDay: "AM",
        precheckPassed: true,
        status: "PENDING",
        createdAt: null,
        apricotApptId: null,
        visitReasonCode: null,
        handledByStaffName: null,
        handledAt: null,
      },
    },
    "booking:updated": {
      conversationId: CONV_ID,
      clinicId: "clinic-x",
      booking: {
        id: "booking-x",
        providerName: null,
        requestedDate: null,
        requestedTime: null,
        timeOfDay: null,
        precheckPassed: null,
        status: "CONFIRMED",
        createdAt: null,
        apricotApptId: "apricot-a-1",
        visitReasonCode: null,
        handledByStaffName: null,
        handledAt: null,
      },
    },
    "booking:changed": { conversationId: CONV_ID, clinicId: "clinic-x", date: "2026-09-22", kind: "reschedule" },
    "routing:assigned": { conversationId: CONV_ID, ruleId: "rule-x", groupId: null, groupName: null, staffId: "staff-x" },
    "routing:escalation": { conversationId: CONV_ID, ruleId: "rule-x", fromGroupId: null, toGroupId: "group-x", groupName: "E2E U 組", escalatedAt: nowIso },
    "notify:mention": { conversationId: CONV_ID, clinicId: "clinic-x", messageId: "msg-x", fromStaffId: null },
    "notify:assigned": { conversationId: CONV_ID, clinicId: "clinic-x", clinicCode: "E2ES17-A", fromStaffId: null },
    "notify:takeover": { conversationId: CONV_ID, clinicId: "clinic-x", actorStaffId: null },
  };
}

function parseThrows(schema: { parse: (v: unknown) => unknown }, value: unknown): boolean {
  try {
    schema.parse(value);
    return false;
  } catch {
    return true;
  }
}

async function runUnit(messageId: string): Promise<void> {
  console.log("UNIT：事件格式契約（realtime-events.ts schema × emitter 樣本）：");
  const samples = unitSamples();
  const names = Object.keys(EVENT_SCHEMAS).sort();
  check("U0 schema 註冊表 = 20 事件", names.length === 20, names.length);
  const missing = Object.keys(samples).filter((k) => !EVENT_SCHEMAS[k]);
  check("U0 樣本覆蓋所有註冊事件", missing.length === 0, missing);

  let allPass = true;
  const bad: string[] = [];
  for (const name of names) {
    const s = samples[name];
    if (!s) {
      bad.push(`${name}（無樣本）`);
      allPass = false;
      continue;
    }
    if (parseThrows(EVENT_SCHEMAS[name], { ...s, eventId: "evt-unit-1" })) {
      bad.push(name);
      allPass = false;
    }
  }
  check("U1 全部 20 事件樣本 payload 過 schema（+eventId）", allPass, bad);

  const real = await buildMessageNewPayload(messageId);
  check("U2 buildMessageNewPayload（real row）過 message:new schema", !parseThrows(EVENT_SCHEMAS["message:new"], { ...real, eventId: "evt-unit-2" }));

  check("U3 負控：conv:updated 缺 clinicId → parse 炸", parseThrows(EVENT_SCHEMAS["conv:updated"], { conversationId: CONV_ID, eventId: "evt-unit-3" }));
  check(
    "U4 負控：message:new 缺 message 體 → parse 炸",
    parseThrows(EVENT_SCHEMAS["message:new"], { conversationId: CONV_ID, clinicId: "clinic-x", contact: null, conversation: { status: "OPEN", unreadCount: 0 }, eventId: "evt-unit-4" }),
  );
  check(
    "U5 ids-only conv:updated（conversationId+clinicId+eventId）過 schema（S1-7 契約）",
    !parseThrows(EVENT_SCHEMAS["conv:updated"], { conversationId: CONV_ID, clinicId: "clinic-x", eventId: "evt-unit-5" }),
  );
}

// ══ E2E 部分 ════════════════════════════════════════════════════════════════

async function runE2e(fx: { clinicA: string; assnId: string }): Promise<void> {
  console.log("E2E：ids-only conv:updated → row 負責人／unread 唔變：");
  const cookie = await login(VIEWER_EMAIL);
  const browser: BrowserLike = await (chromium as { launch: (o: Record<string, unknown>) => Promise<BrowserLike> }).launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();

  await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const row = page.locator(`button:has-text("${CONTACT_NAME}")`).first();
  await row.waitFor({ timeout: 60_000 });
  const badge = row.locator("span.bg-wa.text-white").first(); // 實 unread badge（row 內另有一枚 WhatsApp 小圓點 span.bg-wa 無文字 — 唔好撞）
  const chip = row.locator('[title^="負責人："]').first();
  await badge.waitFor({ timeout: 30_000 });
  await chip.waitFor({ timeout: 30_000 });

  const badgeText0 = (await badge.textContent())?.trim() ?? "";
  const chipText0 = (await chip.textContent())?.trim() ?? "";
  check("E1 初始 row：負責人 chip 顯示 assignee 名", chipText0.includes(ASSN_NAME), chipText0);
  check("E1 初始 row：unread badge = 3", badgeText0 === "3", badgeText0);

  // ── E2：ids-only conv:updated（只 conversationId + clinicId + eventId；零 patch 欄）────
  await publishConvEvent(convRef({ id: CONV_ID, clinicId: fx.clinicA, assigneeId: fx.assnId, routedStaffId: null, routedGroupId: null }), "conv:updated", {
    conversationId: CONV_ID,
    clinicId: fx.clinicA,
    eventId: `evt-t707-ids-${TS}`,
  });
  await sleep(1500);
  const stillThere = (await row.count()) === 1;
  const badgeText1 = (await badge.textContent())?.trim() ?? "";
  const chipText1 = (await chip.textContent())?.trim() ?? "";
  check("E2 ids-only 後 row 照喺（冇消失／冇被洗走）", stillThere);
  check("E2 ids-only 後 unread 唔變（仍 3）", badgeText1 === "3", badgeText1);
  check("E2 ids-only 後負責人 唔變（仍 assignee 名）", chipText1.includes(ASSN_NAME), chipText1);

  // ── E3：liveness 對照 — 真 patch 欄事件要生效（證明 socket 路徑活 + ids-only 冇阻 handler）──
  await publishConvEvent(convRef({ id: CONV_ID, clinicId: fx.clinicA, assigneeId: fx.assnId, routedStaffId: null, routedGroupId: null }), "conv:updated", {
    conversationId: CONV_ID,
    clinicId: fx.clinicA,
    unreadCount: 9,
    eventId: `evt-t707-live-${TS}`,
  });
  const liveStart = Date.now();
  let badgeText2 = "";
  for (;;) {
    badgeText2 = (await badge.textContent())?.trim() ?? "";
    if (badgeText2 === "9" || Date.now() - liveStart > 8000) break;
    await sleep(200);
  }
  const chipText2 = (await chip.textContent())?.trim() ?? "";
  check("E3 liveness：unreadCount=9 事件生效（badge → 9）", badgeText2 === "9", badgeText2);
  check("E3 liveness：負責人 chip 照舊（patch 唔波及其他欄）", chipText2.includes(ASSN_NAME), chipText2);

  await page.close();
  await ctx.close();
  await browser.close();
}

async function main(): Promise<void> {
  console.log(`[T707] S1-7 事件格式契約（unit）+ ids-only conv:updated（e2e）— base=${BASE}`);
  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T707-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  const fx = await seed();

  await runUnit(fx.messageId);
  await runE2e(fx);

  await cleanup();
  const res = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (
      (SELECT count(*) FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code IN ('${CLINIC_A}')))
      + (SELECT count(*) FROM "Contact" WHERE "waId" LIKE '${WA_PREFIX}%')
      + (SELECT count(*) FROM "StaffUser" WHERE email IN ('${VIEWER_EMAIL}','${ASSN_EMAIL}'))
      + (SELECT count(*) FROM "Clinic" WHERE code IN ('${CLINIC_A}'))
      + (SELECT count(*) FROM "Company" WHERE code = '${COMPANY_CODE}')
    )::int AS n`
  );
  check("cleanup 零殘留", res[0]?.n === 0, `residue=${res[0]?.n}`);

  console.log(FAILS === 0 ? "\nT707-OK（U0-U5 + E1-E3 全綠）" : `\nT707-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T707-ERR", e instanceof Error ? e.stack ?? e.message : e);
    process.exit(2);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
  });
