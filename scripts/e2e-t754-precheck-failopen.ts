/**
 * e2e-t754-precheck-failopen — cwi-final F-1：composer precheck fail-open（workforce 出事唔好擋發送）
 *
 * 背景：precheckAdoptedTask → checkCancellations 會打 workforce appointments feed。
 *   engine 內部只對 404/503/網絡錯 fail-soft，其餘（500/401/429）rethrow →
 *   舊 code 無 try/catch → workforce 一出事，「採用跟進建議」全部 500 發唔出。
 *   F-1：send route catch → log warn（零產出分支已 log）→ why=null → 照發。
 *
 * 用例（server 要 WORKFORCE_MOCK=1）：
 *   MODE=failopen（server 帶 WORKFORCE_MOCK_FAIL=1 → fetchAppointmentsByClinic throw WorkforceApiError(500)）
 *     a) 釘咗病人（patientApricotId 有值 → 行 appointments 分支）嘅 SUGGESTED task → 採用並編輯發送
 *        → 202 + Message 建到 + task SENT + log「fail-open 照發（F-1）」
 *     b) 對照組：病人已覆（lastInboundAt > task.createdAt）→ 409 FOLLOWUP_NOT_SENDABLE（reason=REPLIED）
 *        （REPLIED 檢查喺 appointments 分支之前 → workforce 狀態唔影響）
 *   MODE=normal（server 無 fail flag）
 *     a) 同一 task 形 → 202 + SENT，但 log 唔得有 fail-open（precheck 正常路徑未回归）
 *     b) 同一對照 → 409 REPLIED
 *
 * 用法（repo root）：
 *   BASE=http://127.0.0.1:3101 T754_MODE=failopen pnpm tsx scripts/e2e-t754-precheck-failopen.ts
 *   BASE=http://127.0.0.1:3101 T754_MODE=normal  pnpm tsx scripts/e2e-t754-precheck-failopen.ts
 * 輸出：T754-OK / T754-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
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
const MODE = process.env.T754_MODE ?? "failopen"; // failopen | normal
const LOG_FILE = process.env.T754_LOG_FILE ?? "/tmp/wa-inbox-s0fix-3101.log";
const PASS = "T754-E2E-Pass-789!";
const CLINIC_ID = "e2et754clinic0000000000001";
const USER = "e2et754staffu0000000000001";
const EMAIL = "e2et754-staff@e2e.local";
const CT_A = "e2et754ctact00000000000001";
const CT_B = "e2et754ctbct00000000000001";
const CONV_A = "e2et754convact000000000001";
const CONV_B = "e2et754convbct000000000001";
const TASK_A = "e2et754taska00000000000001"; // fail-open case（釘病人、無回覆）
const TASK_B = "e2et754taskb00000000000001"; // 對照 case（釘病人、已覆）

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
const inboundAt = new Date(Date.now() - 3_600_000); // 24h 窗口內、早於 task createdAt
const dueAt = new Date(Date.now() + 3_600_000); // 未到 expiry

async function cleanupFixture(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "entityId" IN ('${TASK_A}','${TASK_B}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN ('${CONV_A}','${CONV_B}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "FollowupTask" WHERE id IN ('${TASK_A}','${TASK_B}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id IN ('${CONV_A}','${CONV_B}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE id IN ('${CT_A}','${CT_B}')`);
  await prisma.staffClinic.deleteMany({ where: { staffId: USER } });
  await prisma.staffUser.deleteMany({ where: { id: USER } });
}

async function main(): Promise<void> {
  console.log(`[setup] T754 MODE=${MODE} BASE=${BASE}`);
  await cleanupFixture();
  const clinic = await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: { code: "E2ET754" },
    create: {
      id: CLINIC_ID,
      code: "E2ET754",
      name: "T754 E2E 診所",
      waPhoneNumberId: "109990000000074",
      waDisplayNumber: "+852 3001 9074",
    },
  });
  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.upsert({
    where: { id: USER },
    update: { active: true, scopeType: "CLINICS" as never },
    create: { id: USER, email: EMAIL, name: "E2E T754 Staff", passwordHash: pwHash, role: "STAFF", active: true, scopeType: "CLINICS" as never },
  });
  await prisma.staffClinic.create({ data: { staffId: USER, clinicId: CLINIC_ID, isPrimary: true } });

  await prisma.contact.upsert({
    where: { id: CT_A },
    update: { clinicId: clinic.id, followupOptOut: false },
    create: { id: CT_A, clinicId: clinic.id, waId: "95000071", profileName: "T754 A", labels: [], followupOptOut: false },
  });
  await prisma.contact.upsert({
    where: { id: CT_B },
    update: { clinicId: clinic.id, followupOptOut: false },
    create: { id: CT_B, clinicId: clinic.id, waId: "95000072", profileName: "T754 B", labels: [], followupOptOut: false },
  });
  for (const [convId, ctId] of [
    [CONV_A, CT_A],
    [CONV_B, CT_B],
  ] as const) {
    await prisma.conversation.upsert({
      where: { id: convId },
      update: { contactId: ctId, clinicId: clinic.id, status: "OPEN", assigneeId: USER, lastInboundAt: inboundAt, lastMessageAt: inboundAt },
      create: { id: convId, contactId: ctId, clinicId: clinic.id, status: "OPEN", assigneeId: USER, lastInboundAt: inboundAt, lastMessageAt: inboundAt },
    });
  }

  const idleRule = await prisma.followupRule.findFirst({ where: { trigger: "CONVERSATION_IDLE", enabled: true } });
  if (!idleRule) throw new Error("CONVERSATION_IDLE rule 搵唔到");
  // 兩 task 都釘病人（patientApricotId 有值 → checkCancellations 行 appointments 分支）
  await prisma.followupTask.create({
    data: {
      id: TASK_A,
      clinicId: clinic.id,
      conversationId: CONV_A,
      patientApricotId: "cpt754-a",
      phoneHashes: phoneHashes("95000071"),
      ruleId: idleRule.id,
      source: "RULE",
      dueAt,
      status: "SUGGESTED",
      templateName: "conversation_followup",
    },
  });
  await prisma.followupTask.create({
    data: {
      id: TASK_B,
      clinicId: clinic.id,
      conversationId: CONV_B,
      patientApricotId: "cpt754-b",
      phoneHashes: phoneHashes("95000072"),
      ruleId: idleRule.id,
      source: "RULE",
      dueAt,
      status: "SUGGESTED",
      templateName: "conversation_followup",
    },
  });
  // 對照組：病人喺 task 建之後覆咗（lastInboundAt > task.createdAt → REPLIED）
  const taskBRow = await prisma.followupTask.findUnique({ where: { id: TASK_B }, select: { createdAt: true } });
  await prisma.conversation.update({ where: { id: CONV_B }, data: { lastInboundAt: new Date(taskBRow!.createdAt.getTime() + 5_000) } });
  ok("fixture：2 對話（A=無回覆 / B=已覆）+ 2 SUGGESTED tasks（皆釘病人）");

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
      body: JSON.stringify({ conversationId: convId, body: "T754 e2e 測試訊息", clientMessageId, source: "adopted", followupTaskId }),
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, body, clientMessageId };
  };

  /** 讀 LOG_FILE 由 startOffset 之後新增嘅 log 行。 */
  const newLogLines = (startOffset: number): string => {
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size <= startOffset) return "";
      return fs.readFileSync(LOG_FILE, "utf8").slice(startOffset);
    } catch {
      return "";
    }
  };

  try {
    // ── a) fail-open / 正常路徑：釘病人 task 採用發送 ──────────────────────
    const logStart = (() => {
      try {
        return fs.statSync(LOG_FILE).size;
      } catch {
        return 0;
      }
    })();
    const a1 = await postSend(CONV_A, TASK_A);
    check(`T754a[${MODE}] 採用發送 → 202`, a1.status === 202 && a1.body?.ok === true, a1);
    const msgCount = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "Message" WHERE "conversationId" = '${CONV_A}' AND direction = 'OUT'`
    );
    check("T754a Message 已建（OUT）", (msgCount[0]?.n ?? 0) >= 1, msgCount);
    const taskA1 = await prisma.followupTask.findUnique({
      where: { id: TASK_A },
      select: { status: true, sentMessageId: true, handledBy: true },
    });
    check("T754a task → SENT + sentMessageId", taskA1?.status === "SENT" && taskA1?.sentMessageId === a1.body?.messageId, taskA1);
    const auditA = await prisma.auditLog.findFirst({ where: { action: "FOLLOWUP_SENT", entityId: TASK_A } });
    check("T754a AuditLog FOLLOWUP_SENT（sentVia=AI_ADOPTED）", auditA != null && ((auditA.meta ?? {}) as Record<string, unknown>).sentVia === "AI_ADOPTED", { meta: auditA?.meta });
    const newLog = newLogLines(logStart);
    const hasFailOpen = newLog.includes("fail-open 照發（F-1）");
    if (MODE === "failopen") {
      check("T754a log 有「fail-open 照發（F-1）」", hasFailOpen && newLog.includes(TASK_A), hasFailOpen ? "ok" : newLog.slice(-500));
    } else {
      check("T754a[normal] log 無 fail-open（precheck 正常路徑）", !hasFailOpen, hasFailOpen ? newLog.slice(-500) : "ok");
    }

    // ── b) 對照組：病人已覆 → 409 FOLLOWUP_NOT_SENDABLE（REPLIED）─────────
    const b1 = await postSend(CONV_B, TASK_B);
    check(
      "T754b 已覆 → 409 FOLLOWUP_NOT_SENDABLE（reason=REPLIED）",
      b1.status === 409 && b1.body?.error === "FOLLOWUP_NOT_SENDABLE" && b1.body?.reason === "REPLIED",
      b1
    );
    const taskB1 = await prisma.followupTask.findUnique({ where: { id: TASK_B }, select: { status: true, cancelReason: true } });
    check("T754b task 已同步轉 CANCELLED/REPLIED", taskB1?.status === "CANCELLED" && taskB1?.cancelReason === "REPLIED", taskB1);
    const bMsgs = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "Message" WHERE "conversationId" = '${CONV_B}'`
    );
    check("T754b 零 Message 落庫（B — 唔該發）", bMsgs[0]?.n === 0, bMsgs);
  } finally {
    await cleanupFixture();
    const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ((SELECT count(*) FROM "Contact" WHERE id IN ('${CT_A}','${CT_B}'))
        + (SELECT count(*) FROM "FollowupTask" WHERE id IN ('${TASK_A}','${TASK_B}'))
        + (SELECT count(*) FROM "Conversation" WHERE id IN ('${CONV_A}','${CONV_B}'))
        + (SELECT count(*) FROM "Message" WHERE "conversationId" IN ('${CONV_A}','${CONV_B}'))
        + (SELECT count(*) FROM "AuditLog" WHERE "entityId" IN ('${TASK_A}','${TASK_B}'))
        + (SELECT count(*) FROM "StaffUser" WHERE id = '${USER}'))::int AS n`
    );
    check("cleanup 後零殘留", leftover[0]?.n === 0);
  }

  if (FAILS > 0) {
    console.log(`T754-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`T754-OK（MODE=${MODE}）`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T754-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
