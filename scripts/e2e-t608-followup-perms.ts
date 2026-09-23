/**
 * e2e-t608-followup-perms — cwi-final S0-5：跟進建議 API 權限（N-7）
 *
 * T608（施工單）：SUPERVISOR POST send／skip → 403；
 *                 STAFF B（對話 assignee = A）POST send → 423、skip → 200。
 *
 * 背景：舊 route 只查 clinic scope — SUPERVISOR 可送/跳跟進建議（唯讀角色越權）、
 * 同店非負責人可「send」（绕过 Send Lock — 負責人以外唔該發 WhatsApp）。
 *
 * fixture（固定 id，冪等）：E2EV3 clinic + STAFF A（assignee）/ STAFF B / SUPERVISOR（ALL）
 *   + 1 對話（assignee=A）+ 1 SUGGESTED CONVERSATION_IDLE task
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t608-followup-perms.ts
 * 輸出：T608-OK / T608-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./e2e-origin-shim";
import path from "node:path";
import { createRequire } from "node:module";
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
const PASS = "T608-E2E-Pass-789!";
const CLINIC_ID = "e2ev3clinic0000000000001"; // 同 e2e-followup-v3 共用（冪等 upsert）
const USER_A = "e2et608staffau000000000001";
const USER_B = "e2et608staffbu000000000001";
const USER_S = "e2et608superu000000000001";
const EMAIL_A = "e2et608-staffa@e2e.local";
const EMAIL_B = "e2et608-staffb@e2e.local";
const EMAIL_S = "e2et608-sup@e2e.local";
const CT_ID = "e2et608contact00000000001";
const CONV_ID = "e2et608conv0000000000001";
const TASK_ID = "e2et608task00000000000001"; // cuid 形（normalizeRoute 20+ lowercase alnum）

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

async function cleanupFixture(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "FollowupTask" WHERE id = '${TASK_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id = '${CONV_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE id = '${CT_ID}'`);
  await prisma.staffClinic.deleteMany({ where: { staffId: { in: [USER_A, USER_B, USER_S] } } });
  await prisma.staffUser.deleteMany({ where: { id: { in: [USER_A, USER_B, USER_S] } } });
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
  const mkStaff = async (id: string, email: string, role: "STAFF" | "SUPERVISOR", scopeType: "CLINICS" | "ALL"): Promise<void> => {
    await prisma.staffUser.upsert({
      where: { id },
      update: { active: true, scopeType: scopeType as never },
      create: { id, email, name: `E2E T608 ${role}`, passwordHash: pwHash, role, active: true, scopeType: scopeType as never },
    });
    if (scopeType === "CLINICS") {
      await prisma.staffClinic.create({ data: { staffId: id, clinicId: CLINIC_ID, isPrimary: true } });
    }
  };
  await mkStaff(USER_A, EMAIL_A, "STAFF", "CLINICS");
  await mkStaff(USER_B, EMAIL_B, "STAFF", "CLINICS");
  await mkStaff(USER_S, EMAIL_S, "SUPERVISOR", "ALL");

  const ct = await prisma.contact.upsert({
    where: { id: CT_ID },
    update: { clinicId: clinic.id, profileName: "T608 權限張" },
    create: { id: CT_ID, clinicId: clinic.id, waId: "94000021", profileName: "T608 權限張", labels: [] },
  });
  const inboundAt = new Date(Date.now() - 3_600_000);
  await prisma.conversation.upsert({
    where: { id: CONV_ID },
    update: { contactId: ct.id, clinicId: clinic.id, status: "OPEN", assigneeId: USER_A, lastInboundAt: inboundAt, lastMessageAt: inboundAt },
    create: {
      id: CONV_ID,
      contactId: ct.id,
      clinicId: clinic.id,
      status: "OPEN",
      assigneeId: USER_A, // ★ assignee = A（STAFF B 非負責人）
      lastInboundAt: inboundAt,
      lastMessageAt: inboundAt,
    },
  });
  const rule = await prisma.followupRule.findFirst({ where: { trigger: "CONVERSATION_IDLE", enabled: true } });
  if (!rule) throw new Error("CONVERSATION_IDLE rule 搵唔到");
  await prisma.followupTask.create({
    data: {
      id: TASK_ID,
      clinicId: clinic.id,
      conversationId: CONV_ID,
      patientApricotId: "cpt608-a",
      phoneHashes: phoneHashes("94000021"),
      ruleId: rule.id,
      source: "RULE",
      dueAt: new Date(Date.now() + 3_600_000),
      status: "SUGGESTED",
      templateName: "conversation_followup",
    },
  });
  ok("fixture：對話（assignee=A）+ SUGGESTED task + 3 用戶");

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
    const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
    if (!m) throw new Error("login 冇 cookie");
    return m[1];
  };
  const cookieS = await login(EMAIL_S);
  const cookieB = await login(EMAIL_B);

  const post = async (cookie: string, action: "send" | "skip"): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}/api/followups/tasks/${TASK_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${cookie}` },
      body: JSON.stringify({ action }),
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, body };
  };

  try {
    // ── SUPERVISOR（ALL scope，無店綁定）：send + skip 都 403（唯讀） ─────
    const s1 = await post(cookieS, "send");
    check("T608a SUPERVISOR POST send → 403", s1.status === 403, s1);
    const s2 = await post(cookieS, "skip");
    check("T608b SUPERVISOR POST skip → 403", s2.status === 403, s2);

    // ── STAFF B（同店，非負責人）：send → 423 SEND_LOCKED；skip → 200 ─────
    const b1 = await post(cookieB, "send");
    check("T608c STAFF B POST send → 423 SEND_LOCKED", b1.status === 423 && b1.body?.error === "SEND_LOCKED", b1);
    const b2 = await post(cookieB, "skip");
    check("T608d STAFF B POST skip → 200（skip 唔受 lock）", b2.status === 200 && b2.body?.ok === true, b2);
    const taskAfter = await prisma.followupTask.findUnique({ where: { id: TASK_ID }, select: { status: true } });
    check("T608e skip 真係行咗（task → SKIPPED）", taskAfter?.status === "SKIPPED", taskAfter);
  } finally {
    await cleanupFixture();
    const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ((SELECT count(*) FROM "Contact" WHERE id = '${CT_ID}')
        + (SELECT count(*) FROM "FollowupTask" WHERE id = '${TASK_ID}')
        + (SELECT count(*) FROM "StaffUser" WHERE id IN ('${USER_A}','${USER_B}','${USER_S}')))::int AS n`
    );
    check("cleanup 後零殘留", leftover[0]?.n === 0);
  }

  if (FAILS > 0) {
    console.log(`T608-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("T608-OK");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T608-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
