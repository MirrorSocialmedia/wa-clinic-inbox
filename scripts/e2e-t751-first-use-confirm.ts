/**
 * e2e-t751-first-use-confirm — cwi-final S0-8：B1 首次啟用確認（N-11）
 *
 * T751（施工單）：B1 規則（BEFORE_APPOINTMENT）PATCH enabled:true 冇 firstUseConfirmed → 409
 *                 FIRST_USE_CONFIRM_REQUIRED。
 * 附加：
 *   b) 409 後規則未變（照 disabled）
 *   c) 帶 firstUseConfirmed:true → 200 + firstUseConfirmedAt 已置
 *   d) 確認過一次 → 再 disable/enable 唔再 409
 *   e) 兼容口徑：firstUseConfirmedAt（ISO 串，v3 UI 現行）→ 200 + 該值入庫
 *
 * 背景：D-1 關咗 legacy 自動提醒之後，B1 建議規則是唯一預約提醒渠道 — 啟用前
 * 要診所確認「冇其他渠道發預約提醒」（防兩渠道重發）。確認一次即記（firstUseConfirmedAt）。
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t751-first-use-confirm.ts
 * 輸出：T751-OK / T751-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const require = createRequire(path.join(process.cwd(), "package.json"));
const argon2 = require("argon2");

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const PASS = "T751-E2E-Pass-789!";
const CLINIC_ID = "e2ev3clinic0000000000001"; // 24 位 cuid 形 — 同 e2e-followup-v3 共用（冪等 upsert）
const USER = "e2et751adminu000000000001";
const EMAIL = "e2et751-admin@e2e.local";
const RULE_1 = "e2et751rulea000000000001"; // cuid 形（normalizeRoute）
const RULE_2 = "e2et751ruleb000000000001";

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
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [RULE_1, RULE_2] } } });
  await prisma.followupRule.deleteMany({ where: { id: { in: [RULE_1, RULE_2] } } });
  await prisma.staffUser.deleteMany({ where: { id: USER } });
}

async function main(): Promise<void> {
  console.log("[setup] seed ADMIN + 2 條 BEFORE_APPOINTMENT 規則...");
  await cleanupFixture();
  await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: { code: "E2EV3" },
    create: { id: CLINIC_ID, code: "E2EV3", name: "V3 E2E 診所", waPhoneNumberId: "109990000000099", waDisplayNumber: "+852 3001 9003" },
  });
  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.create({
    data: { id: USER, email: EMAIL, name: "E2E T751 Admin", passwordHash: pwHash, role: "ADMIN", active: true, scopeType: "ALL" as never },
  });
  const mkRule = async (id: string, name: string): Promise<void> => {
    await prisma.followupRule.create({
      data: {
        id,
        clinicId: CLINIC_ID,
        name,
        enabled: false,
        trigger: "BEFORE_APPOINTMENT",
        delayValue: 24,
        delayUnit: "HOUR",
        reasonCodes: ["0021"],
        templateName: "appointment_reminder",
        level: "L1",
        maxSends: 1,
        createdBy: USER,
      },
    });
  };
  await mkRule(RULE_1, "T751 B1 規則 A");
  await mkRule(RULE_2, "T751 B1 規則 B");
  ok("fixture：ADMIN（ALL）+ 2 條 disabled BEFORE_APPOINTMENT 規則");

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

  const patch = async (ruleId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}/api/admin/followups/rules/${ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${cookie}` },
      body: JSON.stringify(body),
    });
    let bodyOut: any = null;
    try {
      bodyOut = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, body: bodyOut };
  };

  try {
    // ── a) 首啟用冇確認 → 409 FIRST_USE_CONFIRM_REQUIRED ─────────────
    const p1 = await patch(RULE_1, { enabled: true });
    check("T751a B1 規則 PATCH enabled:true 冇確認 → 409", p1.status === 409, p1);
    check("T751a error code = FIRST_USE_CONFIRM_REQUIRED", p1.body?.error === "FIRST_USE_CONFIRM_REQUIRED", p1.body);
    const r1a = await prisma.followupRule.findUnique({ where: { id: RULE_1 }, select: { enabled: true, firstUseConfirmedAt: true } });
    check("T751b 409 後規則未變（照 disabled + 未確認）", r1a?.enabled === false && r1a?.firstUseConfirmedAt === null, r1a);

    // ── c) 帶 firstUseConfirmed:true → 200 + firstUseConfirmedAt ──────
    const p2 = await patch(RULE_1, { enabled: true, firstUseConfirmed: true });
    const r1c = await prisma.followupRule.findUnique({ where: { id: RULE_1 }, select: { enabled: true, firstUseConfirmedAt: true } });
    check("T751c 帶 firstUseConfirmed:true → 200 + enabled + 已確認", p2.status === 200 && r1c?.enabled === true && r1c?.firstUseConfirmedAt != null, { p2status: p2.status, r1c });

    // ── d) 確認過一次 → 再 enable 唔再 409 ────────────────────────────
    const p3 = await patch(RULE_1, { enabled: false });
    const p4 = await patch(RULE_1, { enabled: true });
    check("T751d 確認過一次 → disable/enable 唔再 409", p3.status === 200 && p4.status === 200, { p3status: p3.status, p4status: p4.status });

    // ── e) 兼容口徑：firstUseConfirmedAt（ISO 串）→ 200 + 該值入庫 ────
    const iso = new Date(Date.now() - 60_000).toISOString();
    const p5 = await patch(RULE_2, { enabled: true, firstUseConfirmedAt: iso });
    const r2 = await prisma.followupRule.findUnique({ where: { id: RULE_2 }, select: { enabled: true, firstUseConfirmedAt: true } });
    check(
      "T751e v3 UI 口徑（firstUseConfirmedAt ISO）→ 200 + 該值入庫",
      p5.status === 200 && r2?.enabled === true && r2?.firstUseConfirmedAt != null && Math.abs(r2.firstUseConfirmedAt.getTime() - new Date(iso).getTime()) < 2_000,
      { p5status: p5.status, r2 }
    );
  } finally {
    await cleanupFixture();
    const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ((SELECT count(*) FROM "FollowupRule" WHERE id IN ('${RULE_1}','${RULE_2}'))
        + (SELECT count(*) FROM "AuditLog" WHERE "entityId" IN ('${RULE_1}','${RULE_2}'))
        + (SELECT count(*) FROM "StaffUser" WHERE id = '${USER}'))::int AS n`
    );
    check("cleanup 後零殘留", leftover[0]?.n === 0);
  }

  if (FAILS > 0) {
    console.log(`T751-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("T751-OK");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T751-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
