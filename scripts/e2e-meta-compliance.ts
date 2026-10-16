/**
 * e2e-meta-compliance — Meta App Review 合規（wa-meta-compliance-20261016）整合 e2e
 *
 * 🔴 全部 mock/local 驗證 — 未經真實 WhatsApp Cloud API 驗證（WA_MOCK=1 + AI_MOCK=1）
 *
 * 涵蓋（工單 B/C/D 之 e2e 部分）：
 *   M1  inbound opt-out 偵測（「停止聯絡」→ flag + audit + staff notice）
 *   M4  opt-in 回覆偵測（「可以繼續發」→ ContactConsent 三要素 + 清旗）
 *   M2  worker 層最後一刻攔截（競態：queue delay + opt-out 後寫 → CANCELLED PROACTIVE_OPT_OUT）
 *   M2b 對照：無 opt-out 嘅 proactive 訊息照發（mock SENT）
 *   M3  AI AUTO 被 opt-out 擋（AUTO 店 + opted-out 病人 → 零自動發 + draft PROPOSED）
 *   M3b 對照：無 opt-out 嘅 AUTO 店 → AI 自動發（SENT_AUTO + proactive=true）— 防回歸
 *   M6  真人升級（「我要同職員傾」→ patientRequestedHuman + notice + audit；後續普通訊息仍擋；
 *       staff「交返 AI」清旗 → 恢復自動）
 *   M5  staff 重新啟用：無 consent = 400；帶 consent = ContactConsent(STAFF_MANUAL) + 清旗
 *   M7  24h 窗口後端強制（過窗 free-form = 422；過窗 utility template OK；過窗未審批 template = 400；
 *       窗內 free-form OK）
 *   M8  緊急 + opt-out：紅旗訊息（「痛到瞓唔著」）→ URGENT_ESCALATION 唔被 opt-out 擋（安全軌獨立）
 *
 * 前置：dev stack 運行（wa-dev-3100 / wa-devdb-15432 / wa-worker）+ AI_MOCK=1 WA_MOCK=1
 * 用法（repo root）：npx tsx scripts/e2e-meta-compliance.ts
 * 輸出：MC-OK / MC-FAIL: <n>
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { outboundQueue, closeRedis } from "../src/lib/queue";

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const BASE = `http://127.0.0.1:${process.env.PORT ?? "3100"}`;

// ── 冪等 fixture ids（25 位 cuid 形 — normalizeRoute 兼容）────────────────────────────
const CLINIC_A = "e2emcclinicA0000000000001"; // DRAFT 店（opt-out / 窗口 / 緊急測試）
const CLINIC_B = "e2emcclinicB0000000000001"; // AUTO 店（AI 自動發測試）
const CODE_A = "E2EMC";
const CODE_B = "E2EMAUTO";
const CT = {
  m1: "e2emcct10000000000000001", // M1/M4/M5 opt-out 生命週期
  m2: "e2emcct20000000000000001", // M2 worker 競態（opted-out）
  m2b: "e2emcct2b00000000000001", // M2b 對照（無 opt-out）
  m3: "e2emcct30000000000000001", // M3 AUTO + opted-out
  m3b: "e2emcct40000000000000001", // M3b AUTO 對照
  m6: "e2emcct50000000000000001", // M6 真人升級
  m7a: "e2emcct60000000000000001", // M7 過窗
  m7b: "e2emcct70000000000000001", // M7 窗內
  m8: "e2emcct80000000000000001", // M8 緊急 + opt-out
} as const;
const WA: Record<keyof typeof CT, string> = {
  m1: "85260100001",
  m2: "85260100002",
  m2b: "85260100003",
  m3: "85260100004",
  m3b: "85260100005",
  m6: "85260100006",
  m7a: "85260100007",
  m7b: "85260100008",
  m8: "85260100009",
};
const CONV = (k: keyof typeof CT) => `e2emcconv${k.replace("m", "")}000000000000001` as string; // 25 位 cuid 形
// 每 run 獨一 nonce — BullMQ jobId 冪等：同 jobId 嘅 completed job 會留喺 queue → 重跑 add 會 reject（M2/M2b 卡死源）
const RUN = Math.random().toString(36).slice(2, 8);
const MSG2 = `e2emcmsg2${RUN}a00000001`;
const MSG2B = `e2emcmsg2b${RUN}00000001`;
const STAFF = "e2emcstaff00000000000001";
const STAFF_EMAIL = "e2emc@e2e.local";
const STAFF_PASS = "e2emcpass123";

const prisma = new PrismaClient();

let FAILS = 0;
const EVIDENCE: string[] = [];
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(name);
  else fail(`${name}${detail !== undefined ? `（${JSON.stringify(detail).slice(0, 300)}）` : ""}`);
}
function evidence(label: string, val: unknown): void {
  EVIDENCE.push(`[${label}] ${JSON.stringify(val).slice(0, 500)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollDb<T>(label: string, fn: () => Promise<T | null | false>, timeoutMs = 30000, intervalMs = 1000): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

function mockInbound(clinicCode: string, from: string, text: string): void {
  const r = spawnSync("npx", ["tsx", "scripts/mock-inbound.ts", "message", "--clinic", clinicCode, "--from", from, "--text", text], {
    encoding: "utf8",
    timeout: 60000,
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  });
  if (r.status !== 0) throw new Error(`mock-inbound fail: ${r.stdout?.slice(-300)} ${r.stderr?.slice(-300)}`);
}

async function lastInMsg(convId: string, since?: Date) {
  return prisma.message.findFirst({
    where: { conversationId: convId, direction: "IN", channel: "API", ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

// ── cleanup（waId sweep — 洗到齊 worker 自建殘留）────────────────────────────────────
async function cleanup(): Promise<void> {
  const waIds = Object.values(WA);
  const keys = Object.keys(CT) as (keyof typeof CT)[];
  const sweepIds = [CLINIC_A, CLINIC_B, STAFF, MSG2, MSG2B, ...keys.map((k) => CT[k] as string), ...keys.map((k) => CONV(k))];
  await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "entityId" IN (${sweepIds.map((x) => `'${x}'`).join(",")})`);
  await prisma.$executeRawUnsafe(`
    DELETE FROM "Message" WHERE "id" IN (SELECT m.id FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId" JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" IN (${waIds.map((w) => `'${w}'`).join(",")}))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AiDraft" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" IN (${waIds.map((w) => `'${w}'`).join(",")}))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "FollowupTask" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" IN (${waIds.map((w) => `'${w}'`).join(",")}))`);
  await prisma.$executeRawUnsafe(`DELETE FROM "StaffNotice" WHERE "clinicId" IN ('${CLINIC_A}','${CLINIC_B}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "ContactConsent" WHERE "contactId" IN (${Object.values(CT).map((c) => `'${c}'`).join(",")})`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "contactId" IN (${Object.values(CT).map((c) => `'${c}'`).join(",")})`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" IN (${Object.values(CT).map((c) => `'${c}'`).join(",")})`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN (${waIds.map((w) => `'${w}'`).join(",")})`);
  await prisma.automationPolicy.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
  await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
  await prisma.staffClinic.deleteMany({ where: { staffId: STAFF } });
  await prisma.staffUser.deleteMany({ where: { id: STAFF } });
  // queue 殘留 job（如有）— 防下個 e2e 撞 jobId
  await outboundQueue.remove(MSG2).catch(() => undefined);
  await outboundQueue.remove(MSG2B).catch(() => undefined);
}

async function main(): Promise<void> {
  // ── pre-checks ─────────────────────────────────────────────────────
  console.log("[pre] 環境檢查...");
  const workerUp = spawnSync("pgrep", ["-f", "[w]orkers/index.ts"], { encoding: "utf8" }).stdout.trim() !== "";
  check("dev worker 運行中", workerUp);
  if (!workerUp) throw new Error("worker 冇起 — 無法驗證（先起 wa-worker）");
  const webRes = await fetch(`${BASE}/healthz`).catch(() => null);
  check("web (3100) 回應", webRes !== null && webRes.status < 500, webRes?.status);
  check("AI_MOCK=1（.env）", (process.env.AI_MOCK ?? "") === "1", process.env.AI_MOCK);
  check("WA_MOCK=1（.env）", (process.env.WA_MOCK ?? "") === "1", process.env.WA_MOCK);
  if (FAILS > 0) throw new Error("pre-check 失敗 — 唔入正文");

  await cleanup();
  console.log("[setup] seed fixture...");
  await prisma.clinic.create({
    data: { id: CLINIC_A, code: CODE_A, name: "MC 測試店 A（DRAFT）", waPhoneNumberId: "119990000000011", waDisplayNumber: "+852 3001 9011", aiMode: "DRAFT", waBusinessAccountId: "waba-e2emc-a" },
  });
  await prisma.clinic.create({
    data: { id: CLINIC_B, code: CODE_B, name: "MC 測試店 B（AUTO）", waPhoneNumberId: "119990000000012", waDisplayNumber: "+852 3001 9012", aiMode: "AUTO", waBusinessAccountId: "waba-e2emc-b" },
  });
  // AUTO 店 level：冇 policy row → resolver fallback（AUTO → L2）= AI_DRAFT minLevel 滿足（零行，唔改共享狀態）

  // staff（login 用）
  const pwHash = await argon2.hash(STAFF_PASS);
  await prisma.staffUser.create({
    data: { id: STAFF, email: STAFF_EMAIL, passwordHash: pwHash, name: "MC E2E Staff", role: "STAFF", scopeType: "CLINICS" },
  });
  await prisma.staffClinic.create({ data: { staffId: STAFF, clinicId: CLINIC_A, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: STAFF, clinicId: CLINIC_B, isPrimary: false } });

  // contacts + conversations（窗口開：lastInboundAt = now-1h）
  const inboundAt = new Date(Date.now() - 3_600_000);
  for (const k of Object.keys(CT) as (keyof typeof CT)[]) {
    const clinicId = k === "m3" || k === "m3b" || k === "m6" ? CLINIC_B : CLINIC_A;
    await prisma.contact.create({ data: { id: CT[k], clinicId, waId: WA[k], profileName: `MC${k}`, labels: [] } });
    await prisma.conversation.create({
      data: { id: CONV(k), contactId: CT[k], clinicId, status: "OPEN", lastInboundAt: inboundAt, lastMessageAt: inboundAt },
    });
  }
  // M7a 過窗對話
  const oldInbound = new Date(Date.now() - 25 * 3_600_000);
  await prisma.$executeRawUnsafe(`UPDATE "Conversation" SET "lastInboundAt" = '${oldInbound.toISOString()}', "lastMessageAt" = '${oldInbound.toISOString()}' WHERE id = '${CONV("m7a")}'`);
  ok("fixture seeded（9 contact / 9 conv / 2 clinic / 1 staff）");

  // login（cookie）
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE }, // 同站 origin — CSRF 檢查（同 authz-matrix shim 口徑）
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASS }),
  });
  const cookie = (loginRes.headers.get("set-cookie") ?? "").match(/wa_inbox_session=[^;]+/)?.[0] ?? null;
  check("staff login（cookie）", loginRes.status === 200 && !!cookie, loginRes.status);
  if (!cookie) throw new Error("login 失敗");
  const authed = (init: RequestInit) => ({
    ...init,
    headers: { origin: BASE, ...(init.headers as Record<string, string>), cookie },
  });

  // ══ M1：inbound opt-out 偵測 ════════════════════════════════════════
  console.log("\n[M1] inbound opt-out 偵測（「停止聯絡」）");
  mockInbound(CODE_A, WA.m1, "停止聯絡");
  const m1Msg = await pollDb("m1 inbound msg", () => lastInMsg(CONV("m1")));
  check("M1 病人訊息落庫", m1Msg !== null, m1Msg?.id);
  const m1Flag = await pollDb("m1 opt-out flag", async () => {
    const c = await prisma.contact.findUnique({ where: { id: CT.m1 } });
    return c?.followupOptOut ? c : null;
  });
  check("M1 followupOptOut=true", m1Flag?.followupOptOut === true);
  check("M1 optOutSource=auto", m1Flag?.optOutSource === "auto", m1Flag?.optOutSource);
  const m1Audit = await prisma.auditLog.findFirst({ where: { action: "FOLLOWUP_OPT_OUT", entityId: CT.m1 } });
  check("M1 audit FOLLOWUP_OPT_OUT", m1Audit !== null);
  const m1Notice = await prisma.staffNotice.findFirst({ where: { clinicId: CLINIC_A, meta: { path: ["contactId"], equals: CT.m1 } } });
  check("M1 staff notice（自動偵測確認）", m1Notice !== null, m1Notice?.title);
  evidence("M1", { msgId: m1Msg?.id, optOutAt: m1Flag?.optOutAt?.toISOString() });

  // ══ M4：opt-in 回覆偵測（同 contact 接力）══════════════════════════
  console.log("\n[M4] opt-in 回覆偵測（「可以繼續發」→ ContactConsent 三要素）");
  const beforeM4 = Date.now();
  mockInbound(CODE_A, WA.m1, "可以繼續發");
  const m4Msg = await pollDb("m4 inbound msg", () => lastInMsg(CONV("m1"), new Date(beforeM4)));
  check("M4 病人訊息落庫", m4Msg !== null, m4Msg?.id);
  const m4Cleared = await pollDb("m4 flag cleared", async () => {
    const c = await prisma.contact.findUnique({ where: { id: CT.m1 } });
    return c && !c.followupOptOut ? c : null;
  });
  check("M4 followupOptOut 清回 false", m4Cleared !== null);
  const m4Consent = await prisma.contactConsent.findFirst({ where: { contactId: CT.m1, source: "WHATSAPP_MESSAGE" } });
  check("M4 ContactConsent 存在", m4Consent !== null, m4Consent?.id);
  check("M4 consent.sourceMessageId = 觸發訊息", m4Consent?.sourceMessageId === m4Msg?.id, { consent: m4Consent?.sourceMessageId, msg: m4Msg?.id });
  check("M4 consent.purpose 非空（用途）", !!m4Consent?.purpose && m4Consent.purpose.length > 0, m4Consent?.purpose);
  check("M4 consent.createdAt 落庫（時間）", m4Consent?.createdAt != null, m4Consent?.createdAt?.toISOString());
  const m4Audit = await prisma.auditLog.findFirst({ where: { action: "FOLLOWUP_OPT_IN", entityId: CT.m1 } });
  check("M4 audit FOLLOWUP_OPT_IN", m4Audit !== null);

  // 重置 CT.m1 為 opted-out（M2/M5 用）
  await prisma.contact.update({ where: { id: CT.m1 }, data: { followupOptOut: true, optOutAt: new Date(), optOutSource: "manual" } });

  // ══ M2：worker 層最後一刻攔截（競態）══════════════════════════════
  console.log("\n[M2] worker 層 opt-out 攔截（queue 已排 + opt-out 後寫 → 發送前最後一刻取消）");
  // 模擬「scan 喺 opt-out 寫入前排咗 queue」：先建 QUEUED proactive 訊息（opt-out 已 true — 上游失守情境）
  await prisma.message.create({
    data: { id: MSG2, conversationId: CONV("m2"), direction: "OUT", channel: "API", type: "text", body: "MC 術後跟進提醒（mock）", status: "QUEUED", sentByStaffId: null, proactive: true, waTimestamp: new Date() },
  });
  await outboundQueue.add("send", { messageId: MSG2 }, { jobId: MSG2, delay: 2500 });
  await sleep(500);
  // 競態：opt-out 喺 job delay 期間先寫入（模擬病人喺排程後先講 stop — 上游失守情境）
  await prisma.contact.update({ where: { id: CT.m2 }, data: { followupOptOut: true, optOutAt: new Date(), optOutSource: "manual" } });
  const m2MsgBefore = await prisma.message.findUnique({ where: { id: MSG2 } });
  check("M2 排程時訊息仍 QUEUED（未發）", m2MsgBefore?.status === "QUEUED", m2MsgBefore?.status);
  const m2Result = await pollDb("m2 cancelled", async () => {
    const m = await prisma.message.findUnique({ where: { id: MSG2 } });
    return m?.status === "CANCELLED" ? m : null;
  }, 30000);
  check("M2 訊息 CANCELLED（發送前攔截）", m2Result?.status === "CANCELLED", m2Result?.status);
  check("M2 errorCode=PROACTIVE_OPT_OUT", m2Result?.errorCode === "PROACTIVE_OPT_OUT", m2Result?.errorCode);
  const m2Audit = await prisma.auditLog.findFirst({ where: { action: "PROACTIVE_BLOCKED_OPT_OUT", entityId: MSG2 } });
  check("M2 audit PROACTIVE_BLOCKED_OPT_OUT", m2Audit !== null);
  const m2Notice = await prisma.staffNotice.findFirst({ where: { clinicId: CLINIC_A, meta: { path: ["reason"], equals: "PROACTIVE_OPT_OUT" } } });
  check("M2 staff notice（攔截通知）", m2Notice !== null, m2Notice?.title);
  const m2Sent = await prisma.message.count({ where: { conversationId: CONV("m2"), direction: "OUT", status: { in: ["SENT", "DELIVERED", "READ"] } } });
  check("M2 零已發 OUT（病人冇收到）", m2Sent === 0, m2Sent);

  // ══ M2b：對照 — 無 opt-out 嘅 proactive 照發 ═══════════════════════
  console.log("\n[M2b] 對照：無 opt-out → proactive 訊息正常發出（mock）");
  await prisma.message.create({
    data: { id: MSG2B, conversationId: CONV("m2b"), direction: "OUT", channel: "API", type: "text", body: "MC 術後跟進提醒（mock control）", status: "QUEUED", sentByStaffId: null, proactive: true, waTimestamp: new Date() },
  });
  await outboundQueue.add("send", { messageId: MSG2B }, { jobId: MSG2B });
  const m2bSent = await pollDb("m2b sent", async () => {
    const m = await prisma.message.findUnique({ where: { id: MSG2B } });
    return m && ["SENT", "DELIVERED", "READ"].includes(m.status) ? m : null;
  }, 30000);
  check("M2b 訊息已發（mock SENT）", m2bSent !== null, m2bSent?.status);
  check("M2b mock wamid", m2bSent?.waMessageId?.startsWith("mock-wamid-") === true, m2bSent?.waMessageId);

  // ══ M3：AI AUTO 被 opt-out 擋 ══════════════════════════════════════
  console.log("\n[M3] AI AUTO + opted-out → 零自動發（draft 留 staff）");
  await prisma.contact.update({ where: { id: CT.m3 }, data: { followupOptOut: true, optOutAt: new Date(), optOutSource: "manual" } });
  const m3Before = Date.now();
  mockInbound(CODE_B, WA.m3, "你好，想問下洗牙幾耐做一次");
  const m3In = await pollDb("m3 inbound", () => lastInMsg(CONV("m3"), new Date(m3Before)));
  check("M3 訊息落庫", m3In !== null, m3In?.id);
  // 等 AI job 完成（draft 出現）
  const m3Draft = await pollDb("m3 draft", () =>
    prisma.aiDraft.findFirst({ where: { conversationId: CONV("m3"), inReplyToMessageId: m3In?.id }, select: { id: true, status: true } })
  );
  check("M3 AI draft 生成（PROPOSED — 留 staff 審批）", m3Draft?.status === "PROPOSED", m3Draft?.status);
  await sleep(4000); // 俾足 AUTO 路徑跑完（gate 應擋）
  const m3Auto = await prisma.message.count({ where: { conversationId: CONV("m3"), direction: "OUT", aiAutoSent: true } });
  check("M3 零 AI 自動發（opt-out 擋）", m3Auto === 0, m3Auto);

  // ══ M3b：對照 — AUTO 店正常自動發（防回歸）═════════════════════════
  console.log("\n[M3b] 對照：AUTO 店 + 無 opt-out → AI 自動發（proactive=true）");
  const m3bBefore = Date.now();
  mockInbound(CODE_B, WA.m3b, "你好");
  const m3bIn = await pollDb("m3b inbound", () => lastInMsg(CONV("m3b"), new Date(m3bBefore)));
  check("M3b 訊息落庫", m3bIn !== null, m3bIn?.id);
  const m3bAuto = await pollDb("m3b auto sent", async () => {
    const m = await prisma.message.findFirst({ where: { conversationId: CONV("m3b"), direction: "OUT", aiAutoSent: true, replyToMessageId: m3bIn?.id } });
    return m && ["QUEUED", "SENDING", "SENT", "DELIVERED", "READ"].includes(m.status) ? m : null;
  }, 30000);
  check("M3b AI 自動發訊息存在", m3bAuto !== null, m3bAuto?.id);
  check("M3b proactive=true（入攔截網）", m3bAuto?.proactive === true, m3bAuto?.proactive);
  const m3bDraft = await prisma.aiDraft.findFirst({ where: { conversationId: CONV("m3b"), inReplyToMessageId: m3bIn?.id }, select: { status: true } });
  check("M3b draft → SENT_AUTO", m3bDraft?.status === "SENT_AUTO", m3bDraft?.status);

  // ══ M6：真人升級 ═══════════════════════════════════════════════════
  console.log("\n[M6] 真人升級（「我要同職員傾」→ AI 全停 → staff 交返 → 恢復）");
  const m6Before = Date.now();
  mockInbound(CODE_B, WA.m6, "我要同職員傾");
  const m6In = await pollDb("m6 inbound", () => lastInMsg(CONV("m6"), new Date(m6Before)));
  check("M6 訊息落庫", m6In !== null, m6In?.id);
  const m6Flag = await pollDb("m6 patientRequestedHuman", async () => {
    const c = await prisma.conversation.findUnique({ where: { id: CONV("m6") } });
    return c?.patientRequestedHuman ? c : null;
  });
  check("M6 patientRequestedHuman=true", m6Flag?.patientRequestedHuman === true);
  check("M6 patientRequestedHumanAt 落庫", m6Flag?.patientRequestedHumanAt != null, m6Flag?.patientRequestedHumanAt?.toISOString());
  const m6Notice = await prisma.staffNotice.findFirst({ where: { clinicId: CLINIC_B, meta: { path: ["reason"], equals: "PATIENT_REQUESTED_HUMAN" } } });
  check("M6 staff notice（病人要求真人）", m6Notice !== null, m6Notice?.title);
  const m6Audit = await prisma.auditLog.findFirst({ where: { action: "PATIENT_REQUESTED_HUMAN", entityId: CONV("m6") } });
  check("M6 audit PATIENT_REQUESTED_HUMAN", m6Audit !== null);
  await sleep(4000);
  const m6Auto = await prisma.message.count({ where: { conversationId: CONV("m6"), direction: "OUT", aiAutoSent: true } });
  check("M6 零 AI 自動覆（要求真人訊息本身）", m6Auto === 0, m6Auto);

  // M6b：後續普通訊息 → 仍然零自動（flag 持久 — 唔係一次性）
  const m6bBefore = Date.now();
  mockInbound(CODE_B, WA.m6, "你好");
  const m6bIn = await pollDb("m6b inbound", () => lastInMsg(CONV("m6"), new Date(m6bBefore)));
  const m6bDraft = await pollDb("m6b draft", () =>
    prisma.aiDraft.findFirst({ where: { conversationId: CONV("m6"), inReplyToMessageId: m6bIn?.id }, select: { status: true } })
  );
  check("M6b 後續訊息 draft 照出（PROPOSED）", m6bDraft?.status === "PROPOSED", m6bDraft?.status);
  await sleep(4000);
  const m6bAuto = await prisma.message.count({ where: { conversationId: CONV("m6"), direction: "OUT", aiAutoSent: true, replyToMessageId: m6bIn?.id } });
  check("M6b 後續訊息仍零自動（flag 持久生效）", m6bAuto === 0, m6bAuto);

  // M6c：staff「交返 AI」清旗
  const m6cRes = await fetch(`${BASE}/api/conversations/${CONV("m6")}/patient-requested-human`, authed({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clear: true }),
  }));
  const m6cBody = (await m6cRes.json().catch(() => ({}))) as { ok?: boolean; changed?: boolean };
  check("M6c 交返 AI → 200 changed", m6cRes.status === 200 && m6cBody.changed === true, { status: m6cRes.status, body: m6cBody });
  const m6cConv = await prisma.conversation.findUnique({ where: { id: CONV("m6") } });
  check("M6c flag 清回 false", m6cConv?.patientRequestedHuman === false, m6cConv?.patientRequestedHuman);
  const m6cAudit = await prisma.auditLog.findFirst({ where: { action: "HUMAN_REQUEST_CLEARED", entityId: CONV("m6"), staffId: STAFF } });
  check("M6c audit HUMAN_REQUEST_CLEARED（staff 落痕）", m6cAudit !== null);

  // M6d：交返後 → AI 自動恢復（對照）
  const m6dBefore = Date.now();
  mockInbound(CODE_B, WA.m6, "你好，多謝");
  const m6dIn = await pollDb("m6d inbound", () => lastInMsg(CONV("m6"), new Date(m6dBefore)));
  const m6dAuto = await pollDb("m6d auto sent", async () => {
    const m = await prisma.message.findFirst({ where: { conversationId: CONV("m6"), direction: "OUT", aiAutoSent: true, replyToMessageId: m6dIn?.id } });
    return m ? m : null;
  }, 30000);
  check("M6d 交返後 AI 自動恢復（SENT_AUTO 流程）", m6dAuto !== null, m6dAuto?.status);

  // ══ M5：staff 重新啟用（consent 必帶）══════════════════════════════
  console.log("\n[M5] staff 重新啟用 opt-out：consent 三要素");
  const m5aRes = await fetch(`${BASE}/api/followups/contacts/${CT.m1}/opt-out`, authed({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ optOut: false }),
  }));
  check("M5a 無 consent → 400 拒", m5aRes.status === 400, m5aRes.status);
  const m5aStill = await prisma.contact.findUnique({ where: { id: CT.m1 }, select: { followupOptOut: true } });
  check("M5a flag 未被改（fail-closed）", m5aStill?.followupOptOut === true, m5aStill?.followupOptOut);
  const m5bRes = await fetch(`${BASE}/api/followups/contacts/${CT.m1}/opt-out`, authed({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ optOut: false, consent: { purpose: "e2e 測試 — 病人 10/16 電話同意再收術後跟進" } }),
  }));
  const m5bBody = (await m5bRes.json().catch(() => ({}))) as { changed?: boolean };
  check("M5b 帶 consent → 200 changed", m5bRes.status === 200 && m5bBody.changed === true, { status: m5bRes.status });
  const m5bConsent = await prisma.contactConsent.findFirst({ where: { contactId: CT.m1, source: "STAFF_MANUAL" } });
  check("M5b ContactConsent STAFF_MANUAL 落庫", m5bConsent !== null, m5bConsent?.id);
  check("M5b consent.staffId 落庫", m5bConsent?.staffId === STAFF, m5bConsent?.staffId);
  check("M5b consent.purpose = staff 填寫", m5bConsent?.purpose?.startsWith("e2e 測試") === true, m5bConsent?.purpose);
  const m5bAudit = await prisma.auditLog.findFirst({ where: { action: "FOLLOWUP_OPT_OUT_CLEARED", entityId: CT.m1 } });
  check("M5b audit FOLLOWUP_OPT_OUT_CLEARED", m5bAudit !== null);

  // ══ M7：24h 窗口後端強制 ═══════════════════════════════════════════
  console.log("\n[M7] 24h 窗口後端強制（staff send route）");
  // M7a：過窗 free-form → 422
  const m7aRes = await fetch(`${BASE}/api/messages/send`, authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: CONV("m7a"), body: "你好，想問下" }),
  }));
  const m7aBody = (await m7aRes.json().catch(() => ({}))) as { error?: string; templates?: { name: string }[] };
  check("M7a 過窗 free-form → 422 window_closed", m7aRes.status === 422 && m7aBody.error === "window_closed", { status: m7aRes.status, error: m7aBody.error });
  check("M7a 回應帶 APPROVED+UTILITY template 名單", Array.isArray(m7aBody.templates) && m7aBody.templates.some((t) => t.name === "appt_reminder_zh"), m7aBody.templates);
  const m7aMsg = await prisma.message.count({ where: { conversationId: CONV("m7a"), direction: "OUT" } });
  check("M7a 零 Message 落庫（後端拒 — 唔係 UI 擋）", m7aMsg === 0, m7aMsg);
  // M7b：過窗 utility template → 合法（QUEUED → mock SENT）
  const m7bRes = await fetch(`${BASE}/api/messages/send`, authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: CONV("m7a"),
      templateName: "appt_reminder_zh",
      templateParams: { requestedDate: "2026-10-20", requestedTime: "10:30", providerName: "陳醫生" },
    }),
  }));
  const m7bBody = (await m7bRes.json().catch(() => ({}))) as { ok?: boolean; error?: string; messageId?: string };
  check("M7b 過窗 UTILITY template → 2xx", m7bRes.status >= 200 && m7bRes.status < 300, { status: m7bRes.status, body: m7bBody });
  const m7bMsg = await pollDb("m7b template msg sent", async () => {
    const m = await prisma.message.findFirst({ where: { conversationId: CONV("m7a"), direction: "OUT", type: "template" } });
    return m && ["SENT", "DELIVERED", "READ"].includes(m.status) ? m : null;
  }, 30000);
  check("M7b template 已發（mock SENT）", m7bMsg !== null, m7bMsg?.status);
  check("M7b billingCategory=UTILITY（計費口徑）", m7bMsg?.billingCategory === "UTILITY", m7bMsg?.billingCategory);
  check("M7b proactive=false（staff 掣 — 唔入 opt-out 網）", m7bMsg?.proactive === false, m7bMsg?.proactive);
  // M7c：過窗未審批 template → 400
  const m7cRes = await fetch(`${BASE}/api/messages/send`, authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: CONV("m7a"),
      templateName: "new_arrival_intro", // PENDING — 唔喺 APPROVED 名單
      templateParams: { requestedDate: "2026-10-20", requestedTime: "10:30", providerName: "陳醫生" },
    }),
  }));
  check("M7c 過窗 PENDING template → 400 拒", m7cRes.status === 400, m7cRes.status);
  // M7d：窗內 free-form → OK
  const m7dRes = await fetch(`${BASE}/api/messages/send`, authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: CONV("m7b"), body: "你好，預約已確認" }),
  }));
  check("M7d 窗內 free-form → 2xx", m7dRes.status >= 200 && m7dRes.status < 300, m7dRes.status);

  // ══ M8：緊急 + opt-out（安全軌獨立）════════════════════════════════
  console.log("\n[M8] 緊急訊號唔受 opt-out 影響（URGENT_ESCALATION 照常）");
  await prisma.contact.update({ where: { id: CT.m8 }, data: { followupOptOut: true, optOutAt: new Date(), optOutSource: "manual" } });
  const m8Before = Date.now();
  mockInbound(CODE_A, WA.m8, "我牙痛到瞓唔著");
  const m8In = await pollDb("m8 inbound", () => lastInMsg(CONV("m8"), new Date(m8Before)));
  check("M8 訊息落庫", m8In !== null, m8In?.id);
  const m8Urgent = await pollDb("m8 urgent flag", async () => {
    const c = await prisma.conversation.findUnique({ where: { id: CONV("m8") } });
    return c?.urgent ? c : null;
  });
  check("M8 conv.urgent=true（紅旗 intake）", m8Urgent?.urgent === true);
  const m8Notice = await pollDb("m8 urgent notice", () =>
    prisma.staffNotice.findFirst({ where: { clinicId: CLINIC_A, kind: "URGENT_ESCALATION", meta: { path: ["wamid"], equals: m8In?.waMessageId ?? "" } } })
  );
  check("M8 URGENT_ESCALATION notice（opt-out 唔擋安全軌）", m8Notice !== null, m8Notice?.title);
  const m8Flag = await prisma.contact.findUnique({ where: { id: CT.m8 }, select: { followupOptOut: true } });
  check("M8 opt-out flag 未被緊急流程改動", m8Flag?.followupOptOut === true, m8Flag?.followupOptOut);
  const m8Auto = await prisma.message.count({ where: { conversationId: CONV("m8"), direction: "OUT" } });
  check("M8 零 AI 自動覆（急症唔出 AI 覆）", m8Auto === 0, m8Auto);

  // ── evidence（report 用 — mock/local）─────────────────────────────
  console.log("\n[evidence] 關鍵軌跡（mock/local — 未經真實 WhatsApp Cloud API 驗證）:");
  for (const line of EVIDENCE) console.log(`  ${line}`);

  await cleanup();
  console.log(`\n[cleanup] fixture 已清理`);
}

main()
  .then(async () => {
    if (FAILS > 0) {
      console.log(`\nMC-FAIL: ${FAILS}`);
      process.exitCode = 1;
    } else {
      console.log("\nMC-OK — 全部通過（mock/local 驗證 — 未經真實 WhatsApp Cloud API 驗證）");
    }
  })
  .catch(async (err) => {
    console.error("\nMC-ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => undefined);
    await prisma.$disconnect();
  });
