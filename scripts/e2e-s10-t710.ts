/**
 * e2e-s10-t710 — cwi-final S1-10 T710：翻開已解決路由對話 → 15 分鐘升級計時器重計（N-4）
 *
 * 設計（spec S1-10 測試 T710）：
 *  - 獨立 fixture：company E2ES10-CO + clinic E2ES10-C1 + G1（第一級組）/ G2（升級組）
 *    + RoutingRule（fixture 店、escalateAfterMin=15、escalateToGroupId=G2）
 *    + 路由對話 RESOLVED 3 日（routedAt/resolvedAt = now-3d，routedRuleId 已設，assigneeId=null）
 *  - 病人再發（mock-inbound 真 webhook 路徑）→ inbound reopen SQL：
 *    status→OPEN + `routedAt = CASE WHEN status='RESOLVED' AND routedRuleId IS NOT NULL THEN now() END`
 *  - 斷言 1（核心回歸）：reopen 後第一輪 routing-escalate sweep（wall-clock 每 5 分鐘，waited ≤5min < 15）
 *    → **唔升級**（escalatedAt 保持 null）。
 *    舊 code（routedAt 唔重設 = 3 日前）→ 第一輪 sweep waitedMin≈4320 ≥15 → 即刻升級 = 紅。
 *  - 斷言 2：waited ≥ 15min 之後嘅 sweep → 升級（escalatedAt 落 + 路由轉 G2 + StaffNotice + INTERNAL 備註 + audit）。
 *
 * 時鐘對齊：webhook 喺「下一個 5 分鐘邊界 -45s」fire（等 ≤5min）→ reopen commit（T0）貼住邊界前
 * → reopen 後 sweep 序列 ≈ T0+0 / +5 / +10 / +15min（BullMQ 每 5 分鐘 cron，wall-clock 邊界觸發）。
 * 測試總時長 ≈ 16-18min（detached setsid 跑）。
 *
 * 前置：dev stack live（server 3100 + worker 帶新 code + DB 15432）；worker log 喺 /tmp/cwi-b9-worker.log。
 * 用法（repo root）：pnpm tsx scripts/e2e-s10-t710.ts
 * 輸出：T710-OK / T710-FAIL: <reason>（exit 1）
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORKER_LOG = process.env.WORKER_LOG ?? "/tmp/cwi-b9-worker.log";
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES10-CO";
const CLINIC_CODE = "E2ES10-C1";
const G1_CODE = "E2ES10G1";
const G2_CODE = "E2ES10G2";
const M_EMAIL = "e2e-s10-m@wa-clinic.local";
const S_EMAIL = "e2e-s10-s@wa-clinic.local";
const PASS = "e2e-s10-pass-2026";
const WA_ID = "99061800";
const WA_PREFIX = "990618";
const ESCALATE_AFTER_MIN = 15;
const D3 = 3 * 24 * 3600 * 1000;

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
let CLINIC = "";
let CONV = "";
let RULE_ID = "";
let G1 = "";
let G2 = "";
let M_ID = "";
let S2_ID = "";

async function cleanup(): Promise<void> {
  if (CONV) {
    await prisma.staffNotice.deleteMany({ where: { conversationId: CONV } });
    await prisma.$executeRawUnsafe(`DELETE FROM "FlowSession" WHERE "conversationId" = '${CONV}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ConversationRead" WHERE "conversationId" = '${CONV}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = '${CONV}' OR "waMessageId" LIKE 'wamid.t710.%'`);
    await prisma.conversation.deleteMany({ where: { id: CONV } });
  }
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: { in: [M_EMAIL, S_EMAIL] } } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: [M_EMAIL, S_EMAIL] } } });
  if (G1 || G2) {
    await prisma.skillGroupMember.deleteMany({ where: { groupId: { in: [G1, G2].filter(Boolean) } } });
    await prisma.skillGroupClinic.deleteMany({ where: { groupId: { in: [G1, G2].filter(Boolean) } } });
  }
  await prisma.skillGroup.deleteMany({ where: { code: { in: [G1_CODE, G2_CODE] } } });
  if (RULE_ID) await prisma.routingRule.deleteMany({ where: { id: RULE_ID } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<void> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES10 CO" } });
  CLINIC = (
    await prisma.clinic.create({
      data: { companyId: company.id, code: CLINIC_CODE, name: "E2ES10 Clinic", waPhoneNumberId: "E2ES10-C1-PH", waDisplayNumber: "+852 0000 7168" },
    })
  ).id;
  G1 = (await prisma.skillGroup.create({ data: { code: G1_CODE, name: "E2ES10 G1 一線組" } })).id;
  G2 = (await prisma.skillGroup.create({ data: { code: G2_CODE, name: "E2ES10 SUPV 升級組" } })).id;
  await prisma.skillGroupClinic.create({ data: { groupId: G1, clinicId: CLINIC } });
  await prisma.skillGroupClinic.create({ data: { groupId: G2, clinicId: CLINIC } });
  const argon2 = (await import("argon2")).default;
  const hash = await argon2.hash(PASS);
  const m = await prisma.staffUser.create({ data: { email: M_EMAIL, name: "E2E S10 M", role: "STAFF", scopeType: "CLINICS", passwordHash: hash } });
  const s = await prisma.staffUser.create({ data: { email: S_EMAIL, name: "E2E S10 S", role: "STAFF", scopeType: "CLINICS", passwordHash: hash } });
  M_ID = m.id;
  S2_ID = s.id;
  await prisma.staffClinic.create({ data: { staffId: M_ID, clinicId: CLINIC, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: S2_ID, clinicId: CLINIC, isPrimary: true } });
  await prisma.skillGroupMember.create({ data: { groupId: G1, staffId: M_ID } });
  await prisma.skillGroupMember.create({ data: { groupId: G2, staffId: S2_ID } });

  RULE_ID = (
    await prisma.routingRule.create({
      data: {
        clinicId: CLINIC,
        name: "E2ES10 T710 升級規則",
        priority: 1,
        enabled: true,
        targetType: "GROUP",
        targetGroupId: G1,
        escalateAfterMin: ESCALATE_AFTER_MIN,
        escalateToGroupId: G2,
        createdBy: M_ID,
      },
    })
  ).id;

  const ct = await prisma.contact.create({ data: { clinicId: CLINIC, waId: WA_ID, profileName: "E2ES10 P0001", labels: [] } });
  const d3 = new Date(Date.now() - D3);
  CONV = (
    await prisma.conversation.create({
      data: {
        clinicId: CLINIC,
        contactId: ct.id,
        status: "RESOLVED",
        assigneeId: null,
        routedRuleId: RULE_ID,
        routedGroupId: G1,
        routedStaffId: M_ID,
        routedAt: d3,
        escalatedAt: null,
        resolvedBy: S2_ID,
        resolvedAt: d3,
        lastMessageAt: d3,
        unreadCount: 0,
      },
    })
  ).id;
}

/** worker log 入 reopen 之後第一次 routing-escalate sweep 嘅 log time（ISO）— 冇 → null */
function firstSweepAfter(afterIso: string): string | null {
  try {
    const lines = readFileSync(WORKER_LOG, "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes("cron: routing-escalate done")) continue;
      const m = line.match(/"time":"([^"]+)"/);
      if (m && m[1] >= afterIso) return m[1];
    }
  } catch {
    /* log 唔存在 → null */
  }
  return null;
}

/** 下一個 5 分鐘邊界（wall-clock）前 fireMs 嘅時刻 */
function nextAlignedFire(fireMs: number): number {
  const now = Date.now();
  const boundary = (Math.floor(now / 300000) + 1) * 300000;
  return boundary - fireMs;
}

async function main(): Promise<void> {
  const tStart = Date.now();
  console.log(`[T710] S1-10 翻開已解決路由對話 → 15min 升級計時器重計 — base=${BASE}`);
  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T710-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  await seed();
  console.log(`  fixture ready（conv=${CONV}）— 等對齊（下一個 5min 邊界 -45s）...`);

  // ── 對齊：webhook 喺 boundary-45s fire（webhook→worker commit 延遲 <45s → T0 貼住邊界前）──
  const fireAt = nextAlignedFire(45000);
  const waitMs = fireAt - Date.now();
  if (waitMs > 0) {
    console.log(`  等 ${Math.round(waitMs / 1000)}s 對齊（fire @ ${new Date(fireAt).toISOString()}）`);
    await sleep(waitMs);
  }
  const wamid = `wamid.t710.${Date.now()}`;
  const tFire = Date.now();
  execSync(`./node_modules/.bin/tsx scripts/mock-inbound.ts message --clinic ${CLINIC_CODE} --from ${WA_ID} --text "t710 reopen check" --wamid ${wamid}`, {
    timeout: 60000,
    stdio: "pipe",
  });
  console.log(`  webhook fired @ ${new Date(tFire).toISOString()}`);

  // ── 等 reopen（status→OPEN + reopenedAt 落）＋ 驗證 routedAt 重設（S1-10 核心）──
  let t0: Date | null = null;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const row = await prisma.conversation.findUnique({ where: { id: CONV } });
    if (row && row.status === "OPEN" && row.reopenedAt) {
      t0 = row.routedAt;
      break;
    }
  }
  if (!t0) {
    const row = await prisma.conversation.findUnique({ where: { id: CONV } });
    console.error(`T710-FAIL: 120s 內 reopen 未完成（status=${row?.status} reopenedAt=${row?.reopenedAt}）— 查 worker log`);
    process.exitCode = 1;
    await cleanup();
    return;
  }
  const ageMs = Date.now() - t0.getTime();
  check("reopen 後 status=OPEN + reopenedAt 落", true);
  check("routedAt 重設 ≈ now（S1-10 CASE 生效；3 日前舊值 = bug）", ageMs < 180000 && ageMs > -60000, { routedAtAgeSec: Math.round(ageMs / 1000) });
  const row0 = await prisma.conversation.findUnique({ where: { id: CONV } });
  check("escalatedAt 初始 = null（sweep 未跑）", row0?.escalatedAt === null, row0?.escalatedAt);
  console.log(`  T0（routedAt 重設）= ${t0.toISOString()} — 斷言 1：reopen 後第一輪 sweep 唔升級`);

  // ── 斷言 1：等 reopen 後第一輪 sweep 跑完 → escalatedAt 保持 null ──
  // 舊 code（routedAt 3 日前）：第一輪 sweep waitedMin≈4320 ≥15 → 即刻升級 → 呢度紅。
  const negDeadline = t0.getTime() + 7 * 60000;
  let sweepSeen = "";
  let negEscalated = (await prisma.conversation.findUnique({ where: { id: CONV }, select: { escalatedAt: true } }))?.escalatedAt ?? null;
  while (Date.now() < negDeadline) {
    sweepSeen = firstSweepAfter(new Date(t0.getTime() + 5000).toISOString()) ?? "";
    if (sweepSeen) break;
    await sleep(15000);
  }
  check("reopen 後有 routing-escalate sweep 跑過（worker log）", sweepSeen !== "", sweepSeen || "無 sweep log");
  if (sweepSeen) {
    await sleep(3000); // sweep log 前讀 row → 稍等沉降
    negEscalated = (await prisma.conversation.findUnique({ where: { id: CONV }, select: { escalatedAt: true } }))?.escalatedAt ?? null;
    const negStatusRow = await prisma.conversation.findUnique({ where: { id: CONV }, select: { status: true } });
    const negStatus = negStatusRow?.status ?? null;
    check("斷言 1：5min sweep 唔升級（escalatedAt=null）— T710 核心回歸", negEscalated === null, negEscalated);
    check("斷言 1：對話仍 OPEN（冇人被接手 / 冇被 resolve）", negStatus === "OPEN", negStatus);
  }

  // ── 斷言 2：waited ≥ 15min 之後嘅 sweep → 升級 ──
  console.log(`  斷言 2：等升級（deadline T0+${Math.round((t0.getTime() + 21 * 60000 - Date.now()) / 60000)}min，每 20s poll）...`);
  const posDeadline = t0.getTime() + 21 * 60000;
  let escalatedRow: Awaited<ReturnType<typeof prisma.conversation.findUnique>> = null;
  while (Date.now() < posDeadline) {
    const r = await prisma.conversation.findUnique({ where: { id: CONV } });
    if (r && r.escalatedAt) {
      escalatedRow = r;
      break;
    }
    await sleep(20000);
  }
  const escRow: NonNullable<typeof escalatedRow> | null = escalatedRow;
  if (!escRow || !escRow.escalatedAt) {
    const r = await prisma.conversation.findUnique({ where: { id: CONV } });
    fail(`斷言 2：T0+21min 內未升級（escalatedAt=${r?.escalatedAt}）— 查 worker log sweep 序列`);
  } else {
    check("斷言 2：≥15min 後 sweep 升級（escalatedAt 落）", true, { waitedMin: Math.round((Date.now() - t0.getTime()) / 60000) });
    check("斷言 2：路由轉升級組 G2（B-2 語義）", escRow.routedGroupId === G2, escRow.routedGroupId);
    check("斷言 2：routedStaffId 清 null（組級接手）", escRow.routedStaffId === null, escRow.routedStaffId);
    const notice = await prisma.staffNotice.findFirst({ where: { conversationId: CONV, kind: "ROUTING_ESCALATION" } });
    check("斷言 2：StaffNotice ROUTING_ESCALATION 落", notice !== null, notice?.title);
    const note = await prisma.message.findFirst({
      where: { conversationId: CONV, direction: "OUT", channel: "INTERNAL", body: { startsWith: "[Routing]" } },
    });
    check("斷言 2：INTERNAL 升級備註落", note !== null, note?.body?.slice(0, 40));
    const audit = await prisma.auditLog.findFirst({ where: { action: "ROUTING_ESCALATED", entityId: CONV } });
    check("斷言 2：audit ROUTING_ESCALATED 落", audit !== null);
  }

  const totalMin = ((Date.now() - tStart) / 60000).toFixed(1);
  await cleanup();
  console.log(FAILS === 0 ? `\nT710-OK（總時長 ${totalMin} min）` : `\nT710-FAIL（${FAILS} 項紅；總時長 ${totalMin} min）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T710-FAIL:", e);
    try {
      void cleanup();
    } catch {
      /* ignore */
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
