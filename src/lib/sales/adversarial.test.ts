/**
 * ★ cwi-sales-20261028：第 1 期對抗式測試（重複／並發／非法輸入／繞過規則）。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/adversarial.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * X1 同一預約重放 10 次（並發）→ 只計一次（rounds、SalesBooking、審計都係 1）
 * X2 同一銷售並發落兩個病人，上限 1 → 只可以有 1 個保護中
 * X3 循環邀約上限唔可以靠「到期延期」繞過（銷售自己喺 Apricot 再 book）
 * X4 兩個 sweep 並發到期 → 只出一次公海、只通知一次
 * X5 冇人覆通知並發 → 只通知一次
 * X6 主管強制接手 → 負責銷售唔可以自己收回（只限 ADMIN）
 * X7 非法日期 / 空 id → 唔記錄、唔 throw
 * X8 老闆指派：病人唔連任何對話 → 拒（防垃圾歸屬）
 * X9 指派守門：鎖住嘅對話唔可以派畀非負責人（PATCH /conversations/[id] 同 assign route 共用）
 * X10 通知／審計零病人資料（只有員工名、id）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function ensureEnv(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const env = readFileSync(path.resolve(__dirname, "../../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    /* fail loud via Prisma */
  }
}
ensureEnv();
process.env.WORKFORCE_MOCK = "1";

const prisma = new PrismaClient();
const PFX = "salx";
const CONTACT = `${PFX}contact000000000000001`;
const CONV = `${PFX}conv00000000000000000001`;
const PIDS = [`${PFX}-p1`, `${PFX}-p2`, `${PFX}-p3`, `${PFX}-p4`, `${PFX}-p5`];
const EMAILS = ["salx-a@salx.local", "salx-b@salx.local", "salx-desk@salx.local", "salx-adm@salx.local"];
const PATIENT_NAME = "陳大文SALX";
let clinicId: string;
let a: string;
let b: string;
let desk: string;
let adm: string;
const NOW = new Date("2026-10-28T04:00:00Z");

async function cleanup(): Promise<void> {
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: [...PIDS, "salx-nobody"] } } });
  await prisma.salesBooking.deleteMany({ where: { patientApricotId: { in: PIDS } } });
  await prisma.salesDelegation.deleteMany({ where: { conversationId: CONV } });
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: CONV }, select: { id: true } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV } });
  await prisma.message.deleteMany({ where: { conversationId: CONV } });
  await prisma.contactPatientLink.deleteMany({ where: { contactId: CONTACT } });
  await prisma.conversation.deleteMany({ where: { id: CONV } });
  await prisma.contact.deleteMany({ where: { id: CONTACT } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entity: "SalesOwnership", entityId: { in: PIDS } }, { entity: "Conversation", entityId: CONV }] } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.salesSettings.deleteMany({ where: { id: "global" } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  clinicId = tkw.id;
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId } }, ...extra } })).id;
  a = await mk(EMAILS[0], "SALX 銷售A", { isSales: true });
  b = await mk(EMAILS[1], "SALX 銷售B", { isSales: true });
  desk = await mk(EMAILS[2], "SALX 前台");
  adm = await mk(EMAILS[3], "SALX 老闆", { role: "ADMIN" });
  await prisma.contact.create({ data: { id: CONTACT, clinicId, waId: "85290003201", profileName: PATIENT_NAME, labels: [] } });
  await prisma.conversation.create({ data: { id: CONV, clinicId, contactId: CONTACT, lastMessageAt: NOW, pinnedPatientApricotId: PIDS[0], pinnedPatientName: PATIENT_NAME } });
  await prisma.contactPatientLink.create({ data: { contactId: CONTACT, patientApricotId: PIDS[0], patientName: PATIENT_NAME, patientCode: "TKW999001", source: "SEARCH" } });
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

const book = async (o: { appt: string; pid: string; actor: string; date?: string }) => {
  const { recordSalesBooking } = await import("./core");
  return recordSalesBooking({ apricotApptId: o.appt, patientApricotId: o.pid, apptDate: o.date ?? "2026-11-01", clinicId, conversationId: CONV, actorStaffId: o.actor, source: "BOOKING", now: NOW });
};

test("X1 同一預約並發重放 10 次 → 只計一次", async () => {
  await Promise.all(Array.from({ length: 10 }, () => book({ appt: "salx-a1", pid: PIDS[0], actor: a })));
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[0] } });
  assert.equal(own?.rounds, 1, "rounds 唔可以被重放加");
  assert.equal(await prisma.salesBooking.count({ where: { apricotApptId: "salx-a1" } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { entityId: PIDS[0], action: "SALES_BOOKING_RECORDED" } }), 1);
});

test("X2 同一銷售並發兩個病人，上限 1 → 最多 1 個保護中", async () => {
  await prisma.salesSettings.upsert({ where: { id: "global" }, create: { id: "global", concurrentCap: 2 }, update: { concurrentCap: 2 } });
  try {
    // A 已經有 P1（X1）；上限 2 → P2、P3 並發只可以有一個成功
    const rs = await Promise.all([book({ appt: "salx-a2", pid: PIDS[1], actor: a }), book({ appt: "salx-a3", pid: PIDS[2], actor: a })]);
    assert.equal(await prisma.salesOwnership.count({ where: { salesStaffId: a, state: "PROTECTED" } }), 2);
    assert.deepEqual(rs.map((r) => r?.outcome).sort(), ["CAP_REACHED", "PROTECTED"]);
  } finally {
    await prisma.salesSettings.update({ where: { id: "global" }, data: { concurrentCap: 30 } });
  }
});

test("X3 循環邀約上限唔可以靠到期延期繞過", async () => {
  const { expireProtections } = await import("./core");
  // P4：A 已經約夠 3 輪
  for (const [i, d] of ["2026-11-01", "2026-11-02", "2026-11-03"].entries()) await book({ appt: `salx-c${i}`, pid: PIDS[3], actor: a, date: d });
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[3] } }))?.rounds, 3);
  // A 自己喺 Apricot 直接 book 第 4 張（inbox 唔知）→ 到期時 sweep 見到之後有預約
  const later = new Date("2026-11-20T04:00:00Z");
  await expireProtections(later, async (pid) => (pid === PIDS[3] ? [{ apricotApptId: "salx-direct", date: "2026-11-25" }] : []));
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[3] } });
  assert.equal(own?.state, "POOL", "已到循環上限 → 唔再延期，出公海");
});

test("X4 兩個 sweep 並發到期 → 只出一次公海、只通知一次", async () => {
  const { expireProtections } = await import("./core");
  await book({ appt: "salx-d1", pid: PIDS[4], actor: b, date: "2026-11-01" });
  const protectedBefore = await prisma.salesOwnership.count({ where: { patientApricotId: { in: PIDS }, state: "PROTECTED" } });
  const p1WasProtected = (await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[0] } }))?.state === "PROTECTED";
  const before = await prisma.staffNotice.count({ where: { conversationId: CONV, title: { contains: "保護期到期" } } });
  const later = new Date("2026-11-20T04:00:00Z");
  const empty = async () => [];
  const [r1, r2] = await Promise.all([expireProtections(later, empty), expireProtections(later, empty)]);
  assert.equal(r1.pooled + r2.pooled, protectedBefore, "兩個 sweep 加埋唔可以重複計");
  assert.equal(await prisma.salesOwnership.count({ where: { patientApricotId: { in: PIDS }, state: "PROTECTED" } }), 0);
  const after = await prisma.staffNotice.count({ where: { conversationId: CONV, title: { contains: "保護期到期" } } });
  // 只有 P1 連住對話 → P1 今次先出公海就通知一次，否則零（X3 已經出咗）
  assert.equal(after - before, p1WasProtected ? 1 : 0, "每個出公海只通知一次");
  for (const pid of PIDS) assert.ok((await prisma.auditLog.count({ where: { entityId: pid, action: "SALES_PROTECTION_EXPIRED" } })) <= 1, pid);
});

test("X5 冇人覆通知並發 → 只通知一次", async () => {
  const { runSalesUnansweredSweep } = await import("./sweep");
  // X4 將所有人放咗公海 → 老闆直接綁返 P1 畀 A（之後 X6 都用）
  await prisma.salesOwnership.update({ where: { patientApricotId: PIDS[0] }, data: { state: "BOUND", salesStaffId: a, lastSalesStaffId: a, protectedUntil: null } });
  const inboundAt = new Date(NOW.getTime() - 40 * 60_000);
  await prisma.conversation.update({ where: { id: CONV }, data: { lastInboundAt: inboundAt, lastOutboundAt: null, salesUnansweredNotifiedAt: null } });
  const rs = await Promise.all([runSalesUnansweredSweep(NOW), runSalesUnansweredSweep(NOW), runSalesUnansweredSweep(NOW)]);
  assert.equal(rs.reduce((n, r) => n + r.notified, 0), 1);
});

test("X6 主管強制接手 → 負責銷售唔可以自己收回", async () => {
  const { forceTakeover, revokeDelegation, SalesActionError } = await import("./handover");
  await forceTakeover({ conversationId: CONV, viewer: { id: adm, role: "ADMIN" }, toStaffId: desk });
  const del = await prisma.salesDelegation.findFirst({ where: { conversationId: CONV, kind: "FORCE", revokedAt: null } });
  assert.ok(del);
  await assert.rejects(revokeDelegation({ conversationId: CONV, viewer: { id: a, role: "STAFF" }, delegationId: del.id }), (e) => e instanceof SalesActionError && e.status === 403);
  await revokeDelegation({ conversationId: CONV, viewer: { id: adm, role: "ADMIN" }, delegationId: del.id });
});

test("X7 非法輸入 → 唔記錄、唔 throw", async () => {
  const { recordSalesBooking } = await import("./core");
  for (const bad of [
    { apricotApptId: "", patientApricotId: PIDS[1], apptDate: "2026-11-01" },
    { apricotApptId: "salx-bad1", patientApricotId: "", apptDate: "2026-11-01" },
    { apricotApptId: "salx-bad2", patientApricotId: PIDS[1], apptDate: "2026-13-45" },
    { apricotApptId: "salx-bad3", patientApricotId: PIDS[1], apptDate: "not-a-date" },
  ]) {
    const r = await recordSalesBooking({ ...bad, clinicId, conversationId: CONV, actorStaffId: a, source: "BOOKING", now: NOW });
    assert.equal(r, null, JSON.stringify(bad));
  }
  assert.equal(await prisma.salesBooking.count({ where: { apricotApptId: { in: ["", "salx-bad1", "salx-bad2", "salx-bad3"] } } }), 0);
});

test("X8 老闆指派：病人唔連任何對話 → 拒", async () => {
  const { assignOwnership } = await import("./admin");
  const { SalesActionError } = await import("./handover");
  await assert.rejects(
    assignOwnership({ byStaffId: adm, patientApricotId: "salx-nobody", toStaffId: a, state: "BOUND" }),
    (e) => e instanceof SalesActionError && e.status === 404
  );
  assert.equal(await prisma.salesOwnership.count({ where: { patientApricotId: "salx-nobody" } }), 0);
});

test("X9 指派守門（assign route 同 PATCH 共用）", async () => {
  const { salesAssignBlocked } = await import("./guard");
  assert.ok(await salesAssignBlocked(CONV, desk), "前台唔可以被派");
  assert.equal(await salesAssignBlocked(CONV, a), null, "負責銷售可以");
  assert.equal(await salesAssignBlocked(CONV, null), null, "放返隊列可以");
});

test("X10 通知／審計零病人資料", async () => {
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: CONV } });
  assert.ok(notices.length > 0);
  for (const n of notices) {
    assert.ok(!n.title.includes(PATIENT_NAME), n.title);
    assert.ok(!n.title.includes("TKW999001"), n.title);
    assert.ok(!JSON.stringify(n.meta ?? {}).includes(PATIENT_NAME));
  }
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ entity: "SalesOwnership", entityId: { in: PIDS } }, { entity: "Conversation", entityId: CONV }] } });
  for (const x of audits) assert.ok(!JSON.stringify(x.meta ?? {}).includes(PATIENT_NAME));
});
