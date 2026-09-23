/**
 * e2e-t609-claim-gate — cwi-final S0-6：composer 路徑 task claim gate（N-7）
 *
 * T609（施工單）：
 *   a) A 對話嘅 task id 喺 B 對話發 → 400（WRONG_CONVERSATION）
 *   b) 病人 opt-out 後採用發送 → 409 FOLLOWUP_NOT_SENDABLE + 零 Message
 *   c) C 類（AFTER_TREATMENT）採用發送 → postOpFollowupAt 有值 + AuditLog FOLLOWUP_SENT
 *
 * 背景：舊 claim 在建 Message 後即 claim（enqueue fail → task SENT 但訊息 FAILED，撕裂）
 * + 無 precheck（stale task 照發 + 照 claim）。S0-6 加 precheckAdoptedTask 守門，
 * claim 搬到 enqueue 成功之後（條件 SUGGESTED + 同 conversation + audit + C 類 postOp）。
 *
 * fixture（固定 id，冪等）：E2EV3 clinic + 1 STAFF（A/B/C 對話 assignee）
 *   + 對話 A（optOut contact）/ B / C + tasks TA/TB/TC
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t609-claim-gate.ts
 * 輸出：T609-OK / T609-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./e2e-origin-shim";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { phoneHashes } from "../src/lib/phone-hash";

const require = createRequire(path.join(process.cwd(), "package.json"));
const argon2 = require("argon2");

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const PASS = "T609-E2E-Pass-789!";
const CLINIC_ID = "e2ev3clinic0000000000001"; // 同 e2e-followup-v3 共用（冪等 upsert）
const USER = "e2et609staffu000000000001";
const EMAIL = "e2et609-staff@e2e.local";
const CT_A = "e2et609ctact0000000001";
const CT_B = "e2et609ctbct0000000001";
const CT_C = "e2et609ctcct0000000001";
const CONV_A = "e2et609convact0000000001";
const CONV_B = "e2et609convbct0000000001";
const CONV_C = "e2et609convccc0000000001";
const TASK_A = "e2et609taska00000000000001"; // 對話 A 嘅 task（test a 喺 B 發）
const TASK_B = "e2et609taskb00000000000001"; // 對話 A 嘅 task（test b opt-out）
const TASK_C = "e2et609taskc00000000000001"; // 對話 C 嘅 task（test c AFTER_TREATMENT）

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(name);
  else fail(`${name}${detail !== undefined ? "（" + JSON.stringify(detail).slice(0, 300) + "）" : ""}`);
}

const prisma = new PrismaClient();
const inboundAt = new Date(Date.now() - 3_600_000); // 24h 窗口內
const dueAt = new Date(Date.now() + 3_600_000); // 未到 expiry

async function cleanupFixture(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "entityId" IN ('${TASK_A}','${TASK_B}','${TASK_C}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN ('${CONV_A}','${CONV_B}','${CONV_C}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "FollowupTask" WHERE id IN ('${TASK_A}','${TASK_B}','${TASK_C}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id IN ('${CONV_A}','${CONV_B}','${CONV_C}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE id IN ('${CT_A}','${CT_B}','${CT_C}')`);
  await prisma.staffClinic.deleteMany({ where: { staffId: USER } });
  await prisma.staffUser.deleteMany({ where: { id: USER } });
}

async function main(): Promise<void> {
  console.log("[setup] 清舊 fixture + seed...");
  await cleanupFixture();
  const clinic = await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: { code: "E2EV3" },
    create: {
      id: CLINIC_ID,
      code: "E2EV3",
      name: "V3 E2E 診所",
      waPhoneNumberId: "109990000000099",
      waDisplayNumber: "+852 3001 9003",
    },
  });
  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.upsert({
    where: { id: USER },
    update: { active: true, scopeType: "CLINICS" as never },
    create: { id: USER, email: EMAIL, name: "E2E T609 Staff", passwordHash: pwHash, role: "STAFF", active: true, scopeType: "CLINICS" as never },
  });
  await prisma.staffClinic.create({ data: { staffId: USER, clinicId: CLINIC_ID, isPrimary: true } });

  const mkConv = async (convId: string, ctId: string, waId: string, optOut: boolean, postOp: boolean): Promise<void> => {
    await prisma.contact.upsert({
      where: { id: ctId },
      update: { clinicId: clinic.id, followupOptOut: optOut },
      create: { id: ctId, clinicId: clinic.id, waId, profileName: `T609 ${convId.slice(-1).toUpperCase()}`, labels: [], followupOptOut: optOut },
    });
    await prisma.conversation.upsert({
      where: { id: convId },
      update: { contactId: ctId, clinicId: clinic.id, status: "OPEN", assigneeId: USER, lastInboundAt: inboundAt, lastMessageAt: inboundAt },
      create: { id: convId, contactId: ctId, clinicId: clinic.id, status: "OPEN", assigneeId: USER, lastInboundAt: inboundAt, lastMessageAt: inboundAt, ...(postOp ? {} : {}) },
    });
  };
  await mkConv(CONV_A, CT_A, "95000011", true, false); // opt-out contact
  await mkConv(CONV_B, CT_B, "95000012", false, false);
  await mkConv(CONV_C, CT_C, "95000013", false, false);

  const idleRule = await prisma.followupRule.findFirst({ where: { trigger: "CONVERSATION_IDLE", enabled: true } });
  if (!idleRule) throw new Error("CONVERSATION_IDLE rule 搵唔到");
  const postOpRule = await prisma.followupRule.findFirst({ where: { trigger: "AFTER_TREATMENT", enabled: true } });
  if (!postOpRule) throw new Error("AFTER_TREATMENT rule 搵唔到");

  const mkTask = async (id: string, convId: string, ruleId: string, patientApricotId: string, phone: string): Promise<void> => {
    await prisma.followupTask.create({
      data: {
        id,
        clinicId: clinic.id,
        conversationId: convId,
        patientApricotId,
        phoneHashes: phoneHashes(phone),
        ruleId,
        source: "RULE",
        dueAt,
        status: "SUGGESTED",
        templateName: ruleId === postOpRule.id ? "post_op_check" : "conversation_followup",
      },
    });
  };
  await mkTask(TASK_A, CONV_A, idleRule.id, "cpt609-a", "95000011");
  await mkTask(TASK_B, CONV_A, idleRule.id, "cpt609-a", "95000011");
  await mkTask(TASK_C, CONV_C, postOpRule.id, "cpt609-c", "95000013");
  ok("fixture：3 對話（A=optOut）+ 3 SUGGESTED tasks");

  const login = async (): Promise<string> => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);
    const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
    if (!m) throw new Error("login 冇 cookie");
    return m[1];
  };
  const cookie = await login();

  const postSend = async (convId: string, followupTaskId: string): Promise<{ status: number; body: any; clientMessageId: string }> => {
    const clientMessageId = randomUUID();
    const res = await fetch(`${BASE}/api/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${cookie}` },
      body: JSON.stringify({ conversationId: convId, body: "T609 e2e 測試訊息", clientMessageId, source: "adopted", followupTaskId }),
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, body, clientMessageId };
  };

  try {
    // ── a) A 對話嘅 task 喺 B 對話發 → 400 invalid followupTaskId ──────────
    const a1 = await postSend(CONV_B, TASK_A);
    check("T609a 跨對話 task → 400", a1.status === 400 && a1.body?.error === "invalid followupTaskId", a1);
    const taskA1 = await prisma.followupTask.findUnique({ where: { id: TASK_A }, select: { status: true } });
    check("T609a task 未受影響（SUGGESTED）", taskA1?.status === "SUGGESTED", taskA1);
    const bMsgs = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "Message" WHERE "conversationId" = '${CONV_B}'`
    );
    check("T609a 零 Message 落庫（B）", bMsgs[0]?.n === 0, bMsgs);

    // ── b) opt-out 後採用發送 → 409 FOLLOWUP_NOT_SENDABLE + 零 Message ─────
    const b1 = await postSend(CONV_A, TASK_B);
    check(
      "T609b opt-out → 409 FOLLOWUP_NOT_SENDABLE（reason=OPT_OUT）",
      b1.status === 409 && b1.body?.error === "FOLLOWUP_NOT_SENDABLE" && b1.body?.reason === "OPT_OUT",
      b1
    );
    const taskB1 = await prisma.followupTask.findUnique({ where: { id: TASK_B }, select: { status: true, cancelReason: true } });
    check("T609b task 已同步轉 CANCELLED/OPT_OUT", taskB1?.status === "CANCELLED" && taskB1?.cancelReason === "OPT_OUT", taskB1);
    const aMsgs = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "Message" WHERE "conversationId" = '${CONV_A}'`
    );
    check("T609b 零 Message 落庫（A — 唔該發）", aMsgs[0]?.n === 0, aMsgs);

    // ── c) C 類（AFTER_TREATMENT）採用發送 → 202 + SENT + postOp + audit ────
    const c1 = await postSend(CONV_C, TASK_C);
    check("T609c AFTER_TREATMENT 採用發送 → 202", c1.status === 202 && c1.body?.ok === true, c1);
    const taskC1 = await prisma.followupTask.findUnique({
      where: { id: TASK_C },
      select: { status: true, sentMessageId: true, handledBy: true },
    });
    check("T609c task → SENT + sentMessageId", taskC1?.status === "SENT" && taskC1?.sentMessageId === c1.body?.messageId, taskC1);
    const convC1 = await prisma.conversation.findUnique({ where: { id: CONV_C }, select: { postOpFollowupAt: true } });
    check("T609c postOpFollowupAt 已置", convC1?.postOpFollowupAt != null, convC1);
    const audit = await prisma.auditLog.findFirst({ where: { action: "FOLLOWUP_SENT", entityId: TASK_C } });
    const auditMeta = (audit?.meta ?? {}) as Record<string, unknown>;
    check(
      "T609c AuditLog FOLLOWUP_SENT（sentVia=AI_ADOPTED + messageId）",
      audit != null && auditMeta.sentVia === "AI_ADOPTED" && auditMeta.messageId === c1.body?.messageId && auditMeta.trigger === "AFTER_TREATMENT",
      { action: audit?.action, meta: auditMeta }
    );
  } finally {
    await cleanupFixture();
    const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ((SELECT count(*) FROM "Contact" WHERE id IN ('${CT_A}','${CT_B}','${CT_C}'))
        + (SELECT count(*) FROM "FollowupTask" WHERE id IN ('${TASK_A}','${TASK_B}','${TASK_C}'))
        + (SELECT count(*) FROM "Conversation" WHERE id IN ('${CONV_A}','${CONV_B}','${CONV_C}'))
        + (SELECT count(*) FROM "Message" WHERE "conversationId" IN ('${CONV_A}','${CONV_B}','${CONV_C}'))
        + (SELECT count(*) FROM "AuditLog" WHERE "entityId" IN ('${TASK_A}','${TASK_B}','${TASK_C}'))
        + (SELECT count(*) FROM "StaffUser" WHERE id = '${USER}'))::int AS n`
    );
    check("cleanup 後零殘留", leftover[0]?.n === 0);
  }

  if (FAILS > 0) {
    console.log(`T609-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("T609-OK");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T609-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
