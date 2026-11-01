/**
 * ★ cwi-sales 第 5 期（員工／老闆審視）— 含對抗式測試。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/phase5.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * X1  R1 急症：非急症照鎖；急症 → 可以覆 + 審計 + 通知負責銷售（30 分鐘內唔重複）
 * X2  R2 高價：高價單延長保護期（只延唔縮、冪等、只限自己保護中）；續期用高價日數；出公海清高價標記
 * X3  R2 爽約：-3 → streak；到上限出公海 + 通知；有嚟歸 0；重跑冪等；workforce 唔得跳過；綁定唔放；cap 0 唔放
 * X4  R3／R4 對單：單被修改只可以「已知悉」；批保護外 → 綁定；其他銷售保護中唔搶；前台幫開未綁 → 409；銷售補充只限自己未決定
 * X5  R5 同步停咗：通知老闆一次；同一 run 唔重複；新 run 再通知；太耐冇跑 → 通知
 * X6  R6 揀分店：範圍外 403；範圍內轉店；分店名單跟範圍
 * X7  U1 到期提醒：只喺時段內；每個到期日一次；續期後再提；設 0 唔提
 * X8  U8 負責病人名單：只推保護中／綁定 + 綁咗 Apricot 銷售員
 * X9  U9 冇對話開單：冇搜過 400；其他銷售負責 403；開到（審計 entity Patient）；重放唔重複審計
 * X10 U1／U2／U4 我的銷售：病人（就到期排先）、公海、對單結果（冇病人名）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
const COMMISSION_FILE = path.resolve(__dirname, "../../../.dev/workforce-mock-commission.json");
let commissionBackup: string | null = null;
const PFX = "salp5";
const C1 = `${PFX}contact000000000000000001`;
const CONV1 = `${PFX}conv00000000000000000001`;
const PIDS = Array.from({ length: 12 }, (_, i) => `${PFX}-p${i + 1}`);
const EMAILS = ["salp5-a@salp5.local", "salp5-b@salp5.local", "salp5-desk@salp5.local", "salp5-adm@salp5.local", "salp5-nob@salp5.local"];
let a: string;
let b: string;
let desk: string;
let adm: string;
let nobind: string;
let tkwId: string;

async function cleanup(): Promise<void> {
  await prisma.salesBooking.deleteMany({ where: { patientApricotId: { in: PIDS } } });
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
  const staff = (await prisma.staffUser.findMany({ where: { email: { in: EMAILS } }, select: { id: true } })).map((s) => s.id);
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: [...PIDS, CONV1] } }, { staffId: { in: staff } }, { action: { in: ["SALES_REVIEW_DECIDED", "SALES_REVIEW_NOTE"] }, entityId: { startsWith: PFX } }] },
  });
  await prisma.staffNotice.deleteMany({ where: { OR: [{ conversationId: CONV1 }, ...staff.map((id) => ({ targetStaffIds: { has: id } }))] } });
  await prisma.message.deleteMany({ where: { conversationId: CONV1 } });
  await prisma.contactPatientLink.deleteMany({ where: { contactId: C1 } });
  await prisma.conversation.deleteMany({ where: { id: CONV1 } });
  await prisma.contact.deleteMany({ where: { id: C1 } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.salesSettings.deleteMany({ where: { id: "global" } });
}

before(async () => {
  commissionBackup = existsSync(COMMISSION_FILE) ? readFileSync(COMMISSION_FILE, "utf8") : null;
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  tkwId = tkw.id;
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId: tkw.id, isPrimary: true } }, ...extra } })).id;
  a = await mk(EMAILS[0], "SALP5 銷售A", { isSales: true, salesApricotUserId: `${PFX}-apu-a`, workforceEmployeeId: `${PFX}-emp-a` });
  b = await mk(EMAILS[1], "SALP5 銷售B", { isSales: true, salesApricotUserId: `${PFX}-apu-b` });
  desk = await mk(EMAILS[2], "SALP5 前台");
  adm = (await prisma.staffUser.create({ data: { email: EMAILS[3], name: "SALP5 老闆", role: "ADMIN", scopeType: "ALL", passwordHash: "x", active: true } })).id;
  nobind = await mk(EMAILS[4], "SALP5 未綁", { isSales: true });
  await prisma.contact.create({ data: { id: C1, clinicId: tkw.id, waId: "85290005501", profileName: "SALP5 1", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV1, clinicId: tkw.id, contactId: C1, lastMessageAt: new Date(), pinnedPatientApricotId: PIDS[0] } });
  await prisma.contactPatientLink.createMany({
    data: PIDS.map((p, i) => ({ contactId: C1, patientApricotId: p, patientCode: `TKW96000${i + 1}`, patientName: `SALP5 病人${i + 1}`, source: "SEARCH" })),
  });
  const { _resetMockInvoicesForTest, putCommissionItems } = await import("@/lib/workforce/client");
  _resetMockInvoicesForTest();
  // IMPLANT 3% 高價；SCALING 冇 %
  await putCommissionItems("TKW", [{ feeItemExtId: "mock-fee-TKW-3", ratePct: 3, highValue: true }], adm);
});

after(async () => {
  try {
    await cleanup();
    if (commissionBackup === null) {
      if (existsSync(COMMISSION_FILE)) unlinkSync(COMMISSION_FILE);
    } else writeFileSync(COMMISSION_FILE, commissionBackup);
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

const own = (pid: string) => prisma.salesOwnership.findUniqueOrThrow({ where: { patientApricotId: pid } });
const protect = (pid: string, staff: string, extra: Record<string, unknown> = {}) =>
  prisma.salesOwnership.upsert({
    where: { patientApricotId: pid },
    create: { patientApricotId: pid, state: "PROTECTED", salesStaffId: staff, lastSalesStaffId: staff, protectedUntil: new Date(Date.now() + 3 * 86_400_000), rounds: 1, ...extra },
    update: { state: "PROTECTED", salesStaffId: staff, lastSalesStaffId: staff, protectedUntil: new Date(Date.now() + 3 * 86_400_000), rounds: 1, noShowStreak: 0, highValue: false, expiryRemindedFor: null, ...extra },
  });

test("X1 R1 急症：非急症照鎖；急症可以覆 + 審計 + 通知（唔重複）", async () => {
  const core = await import("./core");
  await protect(PIDS[0], a);
  await prisma.conversation.update({ where: { id: CONV1 }, data: { urgent: false } });
  await assert.rejects(core.assertCanReplyUnderSalesLock(CONV1, desk), (e) => e instanceof core.SalesLockedError);
  await core.assertCanReplyUnderSalesLock(CONV1, a); // 負責銷售一直得
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_LOCK_URGENT_OVERRIDE", entityId: CONV1 } }), 0, "負責人自己覆唔記急症");

  await prisma.conversation.update({ where: { id: CONV1 }, data: { urgent: true } });
  await core.assertCanReplyUnderSalesLock(CONV1, desk);
  await core.assertCanReplyUnderSalesLock(CONV1, desk);
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_LOCK_URGENT_OVERRIDE", entityId: CONV1, staffId: desk } }), 2, "每次覆都審計");
  const notes = await prisma.staffNotice.findMany({ where: { conversationId: CONV1, kind: "SALES_HANDOVER", title: { contains: "急症" } } });
  assert.equal(notes.length, 1, "30 分鐘內只通知一次");
  assert.deepEqual(notes[0].targetStaffIds, [a]);
  assert.ok(!notes[0].title.includes("病人1"), "通知零病人資料");
  await prisma.conversation.update({ where: { id: CONV1 }, data: { urgent: false } });
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: PIDS[0] } });
});

test("X2 R2 高價：延長保護期（只延唔縮、冪等、只限自己）；續期用高價日數", async () => {
  const { extendForHighValue, openSalesInvoice } = await import("./invoice");
  const core = await import("./core");
  const s = await core.getSalesSettings();
  const apptDate = core.protectedUntilFor("2026-12-01", 0).toISOString().slice(0, 10) === "2026-12-01" ? "2026-12-01" : "2026-12-01";
  await protect(PIDS[1], a, { lastApptDate: apptDate, protectedUntil: core.protectedUntilFor(apptDate, s.protectionDays) });
  assert.equal(await extendForHighValue(PIDS[1], b, "inv-x"), false, "唔係自己保護中 → 唔郁");
  assert.equal(await extendForHighValue(PIDS[1], a, "inv-x"), true);
  const o1 = await own(PIDS[1]);
  assert.equal(o1.highValue, true);
  assert.equal(o1.protectedUntil!.getTime(), core.protectedUntilFor(apptDate, Math.max(s.protectionDays, s.highValueProtectionDays)).getTime());
  assert.equal(await extendForHighValue(PIDS[1], a, "inv-y"), false, "已標高價 → 冪等");
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_PROTECTION_HIGH_VALUE", entityId: PIDS[1] } }), 1);

  // 只延唔縮：而家保護期已經好長 → 唔會縮短
  const far = new Date(Date.now() + 60 * 86_400_000);
  await protect(PIDS[2], a, { lastApptDate: apptDate, protectedUntil: far });
  await extendForHighValue(PIDS[2], a, "inv-z");
  assert.equal((await own(PIDS[2])).protectedUntil!.getTime(), far.getTime());

  // 續期（同一銷售再約）→ 用高價日數
  assert.equal(core.protectionDaysFor(s, true), Math.max(s.protectionDays, s.highValueProtectionDays));
  assert.equal(core.protectionDaysFor(s, false), s.protectionDays);

  // 經 openSalesInvoice：保護中 + 高價項目 + 冇收錢 → 延長；有收錢 → 綁定（唔使延）
  await protect(PIDS[3], a, { lastApptDate: apptDate, protectedUntil: core.protectedUntilFor(apptDate, s.protectionDays) });
  const line = { feeItemExtId: "mock-fee-TKW-3", qty: 1, up: 39000, discAmt: 0 };
  const r = await openSalesInvoice({ conversationId: CONV1, staffId: a, requestKey: "salp5-hv-0001", patientApricotId: PIDS[3], practitionerExtId: "mock-pract-TKW-1", lines: [line], payment: null });
  assert.equal(r.highValue, true);
  assert.equal(r.highValueExtended, true);
  assert.equal((await own(PIDS[3])).highValue, true);
  const r2 = await openSalesInvoice({ conversationId: CONV1, staffId: a, requestKey: "salp5-hv-0001", patientApricotId: PIDS[3], practitionerExtId: "mock-pract-TKW-1", lines: [line], payment: null });
  assert.equal(r2.replayed, true);
  assert.equal(r2.highValueExtended, false, "重放唔會再延");

  // 出公海 → 清高價標記
  const { releaseOwnership } = await import("./admin");
  await releaseOwnership({ byStaffId: adm, patientApricotId: PIDS[3] });
  assert.equal((await own(PIDS[3])).highValue, false);
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: [PIDS[1], PIDS[2], PIDS[3]] } } });
});

test("X3 R2 爽約：streak、到上限公海、有嚟歸 0、冪等、跳過、綁定唔放、cap 0", async () => {
  const { runSalesAttendance, attendanceOf } = await import("./attendance");
  const { hkDateOffset } = await import("@/lib/availability");
  assert.equal(attendanceOf(-3), "NO_SHOW");
  assert.equal(attendanceOf(102), "RESCHEDULED");
  assert.equal(attendanceOf(-7), "CANCELLED");
  assert.equal(attendanceOf(0), "SHOWN");
  await prisma.salesSettings.upsert({ where: { id: "global" }, create: { id: "global", noShowCap: 2 }, update: { noShowCap: 2 } });
  const mkBooking = (id: string, pid: string, staff: string, daysAgo: number) =>
    prisma.salesBooking.create({ data: { apricotApptId: id, patientApricotId: pid, salesStaffId: staff, conversationId: CONV1, apptDate: hkDateOffset(-daysAgo), source: "BOOKING", outcome: "PROTECTED" } });
  await protect(PIDS[4], a);
  await mkBooking(`${PFX}-ap1`, PIDS[4], a, 3);
  await mkBooking(`${PFX}-ap2`, PIDS[4], a, 2);
  const statuses: Record<string, number> = { [`${PFX}-ap1`]: -3, [`${PFX}-ap2`]: -3 };
  const lookup = async () => Object.entries(statuses).map(([apricotApptId, bookingStatus]) => ({ apricotApptId, bookingStatus }));

  // workforce 唔得 → 跳過，唔郁
  const skip = await runSalesAttendance(new Date(), async () => null);
  assert.ok(skip.skipped >= 2);
  assert.equal((await own(PIDS[4])).noShowStreak, 0);

  const r1 = await runSalesAttendance(new Date(), lookup);
  assert.equal(r1.pooled, 1, "連續 2 次爽約 → 公海");
  const o = await own(PIDS[4]);
  assert.equal(o.state, "POOL");
  assert.equal(o.lastSalesStaffId, a);
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_PROTECTION_NO_SHOW", entityId: PIDS[4] } }), 1);
  assert.equal(await prisma.staffNotice.count({ where: { conversationId: CONV1, title: { contains: "爽約" } } }), 1);
  const r2 = await runSalesAttendance(new Date(), lookup);
  assert.equal(r2.checked, 0, "重跑冪等");

  // 爽約一次 + 有嚟 → 歸 0；綁定唔放；其他銷售嘅預約唔計
  await protect(PIDS[5], a);
  await mkBooking(`${PFX}-ap3`, PIDS[5], a, 3);
  await mkBooking(`${PFX}-ap4`, PIDS[5], a, 2);
  statuses[`${PFX}-ap3`] = -3;
  statuses[`${PFX}-ap4`] = 1;
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[6], state: "BOUND", salesStaffId: a, lastSalesStaffId: a } });
  await mkBooking(`${PFX}-ap5`, PIDS[6], a, 3);
  await mkBooking(`${PFX}-ap6`, PIDS[6], a, 2);
  statuses[`${PFX}-ap5`] = -3;
  statuses[`${PFX}-ap6`] = -3;
  await protect(PIDS[7], a);
  await mkBooking(`${PFX}-ap7`, PIDS[7], b, 3);
  await mkBooking(`${PFX}-ap8`, PIDS[7], b, 2);
  statuses[`${PFX}-ap7`] = -3;
  statuses[`${PFX}-ap8`] = -3;
  await runSalesAttendance(new Date(), lookup);
  assert.equal((await own(PIDS[5])).noShowStreak, 0, "有嚟歸 0");
  assert.equal((await own(PIDS[5])).state, "PROTECTED");
  assert.equal((await own(PIDS[6])).state, "BOUND", "綁定唔會因爽約放走");
  assert.equal((await own(PIDS[7])).state, "PROTECTED", "其他銷售落嘅預約唔計");
  assert.equal((await prisma.salesBooking.findUniqueOrThrow({ where: { apricotApptId: `${PFX}-ap7` } })).attendance, "NO_SHOW", "到診照記");

  // cap 0 → 只記錄唔放
  await prisma.salesSettings.update({ where: { id: "global" }, data: { noShowCap: 0 } });
  await protect(PIDS[8], a);
  await mkBooking(`${PFX}-ap9`, PIDS[8], a, 3);
  await mkBooking(`${PFX}-ap10`, PIDS[8], a, 2);
  statuses[`${PFX}-ap9`] = -3;
  statuses[`${PFX}-ap10`] = -3;
  await runSalesAttendance(new Date(), lookup);
  assert.equal((await own(PIDS[8])).state, "PROTECTED");
  assert.equal((await own(PIDS[8])).noShowStreak, 2);
  await prisma.salesSettings.update({ where: { id: "global" }, data: { noShowCap: 2 } });
  await prisma.salesBooking.deleteMany({ where: { patientApricotId: { in: PIDS } } });
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
});

test("X4 R3／R4 對單：已知悉、批保護外 → 綁定、唔搶、未綁 409、銷售補充", async () => {
  const { __salesMock } = await import("@/lib/workforce/client");
  const { decideReviewFromInbox, addSalesNote, listSalesReviews, reviewKindLabel } = await import("./reviews");
  const { SalesActionError } = await import("./handover");
  const base = { status: "OPEN", apricotBillCode: "B1", clinicExtId: "x", salesInvoiceId: null, amount: 100, approvedPct: null, decidedBy: null, decidedAt: null, note: null, createdAt: new Date().toISOString() };
  const put = (id: string, kind: string, pid: string, apu: string) => __salesMock.reviews.set(id, { id, kind, apricotBillId: `bill-${id}`, salesApricotUserId: apu, patientApricotId: pid, ...base });
  put(`${PFX}-r1`, "INVOICE_EDITED", PIDS[9], `${PFX}-apu-a`);
  put(`${PFX}-r2`, "RECONCILE_UNPROTECTED", PIDS[9], `${PFX}-apu-a`);
  put(`${PFX}-r3`, "RECONCILE_UNPROTECTED", PIDS[10], `${PFX}-apu-a`);
  put(`${PFX}-r4`, "RECONCILE_OWNED", PIDS[11], `${PFX}-apu-x`);
  put(`${PFX}-r5`, "APPEAL_NO_PUNCH", PIDS[9], `${PFX}-apu-a`);
  assert.equal(reviewKindLabel("RECONCILE_OWNED"), "前台幫負責銷售嘅病人開單（冇填銷售員）");

  await assert.rejects(decideReviewFromInbox(`${PFX}-r1`, { decision: "APPROVED" }, adm), (e) => e instanceof SalesActionError && e.code === "BAD_DECISION");
  await assert.rejects(decideReviewFromInbox(`${PFX}-r2`, { decision: "ACKNOWLEDGED" }, adm), (e) => e instanceof SalesActionError && e.code === "BAD_DECISION");
  await decideReviewFromInbox(`${PFX}-r1`, { decision: "ACKNOWLEDGED" }, adm);
  assert.equal(__salesMock.reviews.get(`${PFX}-r1`)!.status, "ACKNOWLEDGED");

  // 批保護外（病人冇人負責）→ 綁定畀銷售 A + 通知（冇對話都收到）
  const r = await decideReviewFromInbox(`${PFX}-r2`, { decision: "APPROVED", approvedPct: 80 }, adm);
  assert.equal(r.bound, true);
  const o = await own(PIDS[9]);
  assert.equal(o.state, "BOUND");
  assert.equal(o.salesStaffId, a);
  const n = await prisma.staffNotice.findFirst({ where: { kind: "SALES_REVIEW", targetStaffIds: { has: a } }, orderBy: { createdAt: "desc" } });
  assert.ok(n && n.title.includes("80%") && n.conversationId === null);

  // 其他銷售保護中 → 批咗都唔搶
  await protect(PIDS[10], b);
  const r3 = await decideReviewFromInbox(`${PFX}-r3`, { decision: "APPROVED" }, adm);
  assert.equal(r3.bound, false);
  assert.equal((await own(PIDS[10])).salesStaffId, b);

  // 前台幫開，Apricot 銷售員未綁 inbox → 409（唔會批咗冇人收傭金）
  await assert.rejects(decideReviewFromInbox(`${PFX}-r4`, { decision: "APPROVED" }, adm), (e) => e instanceof SalesActionError && e.status === 409);
  assert.equal(__salesMock.reviews.get(`${PFX}-r4`)!.status, "OPEN");

  // 銷售補充：唔係銷售 403；唔係自己張單 403；自己 OK；決定咗 409；內容空 400
  await assert.rejects(addSalesNote(`${PFX}-r5`, "原因", desk), (e) => e instanceof SalesActionError && e.status === 403);
  await assert.rejects(addSalesNote(`${PFX}-r5`, "原因", b), (e) => e instanceof SalesActionError && e.status === 403);
  await assert.rejects(addSalesNote(`${PFX}-r5`, "   ", a), (e) => e instanceof SalesActionError && e.status === 400);
  await addSalesNote(`${PFX}-r5`, "嗰日喺 MF 跟病人", a);
  assert.equal(__salesMock.reviews.get(`${PFX}-r5`)!.salesNote, "嗰日喺 MF 跟病人");
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_REVIEW_NOTE", staffId: a } }), 1);
  await assert.rejects(addSalesNote(`${PFX}-r2`, "遲咗", a), (e) => e instanceof SalesActionError && e.status === 409);

  // 證據：銷售 A 喺病人對話發過訊息
  await prisma.message.createMany({
    data: [
      { conversationId: CONV1, direction: "OUT", channel: "API", type: "text", body: "x", status: "SENT", sentByStaffId: a, waTimestamp: new Date(Date.now() - 86_400_000), createdAt: new Date(Date.now() - 86_400_000) },
      { conversationId: CONV1, direction: "IN", channel: "API", type: "text", body: "y", status: "RECEIVED", waTimestamp: new Date(Date.now() - 86_400_000), createdAt: new Date(Date.now() - 86_400_000) },
    ] as never,
  });
  const list = await listSalesReviews("OPEN");
  const ev = list.find((x) => x.id === `${PFX}-r5`)!;
  assert.equal(ev.kindLabel, "開單日冇喺嗰間店打卡（申訴）");
  assert.ok(ev.evidence && ev.evidence.staffMessages >= 1 && ev.evidence.patientMessages >= 1, JSON.stringify(ev.evidence));
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
});

test("X5 R5 同步停咗：通知老闆一次；新 run 再通知；太耐冇跑", async () => {
  const { __salesMock } = await import("@/lib/workforce/client");
  const { checkCommissionSyncAlert } = await import("./sweep");
  const now = new Date();
  __salesMock.lastRun = { id: `${PFX}-run1`, trigger: "NIGHTLY", status: "STOPPED", checked: 3, requests: 3, stopReason: "APRICOT_AUTH_EXPIRED", startedAt: now.toISOString(), finishedAt: now.toISOString() };
  assert.equal((await checkCommissionSyncAlert(now)).alerted, `${PFX}-run1`);
  assert.equal((await checkCommissionSyncAlert(now)).alerted, null, "同一 run 唔重複");
  const n = await prisma.staffNotice.findFirst({ where: { kind: "SALES_ADMIN", targetStaffIds: { has: adm } }, orderBy: { createdAt: "desc" } });
  assert.ok(n?.title.includes("登入過期"));
  __salesMock.lastRun = { ...__salesMock.lastRun, id: `${PFX}-run2`, status: "OK", stopReason: null };
  assert.equal((await checkCommissionSyncAlert(now)).alerted, null, "OK 唔通知");
  const old = new Date(now.getTime() - 40 * 3600_000).toISOString();
  __salesMock.lastRun = { ...__salesMock.lastRun, startedAt: old, finishedAt: old };
  assert.equal((await checkCommissionSyncAlert(now)).alerted, `STALE:${PFX}-run2`);
  __salesMock.lastRun = { ...__salesMock.lastRun, id: `${PFX}-run3`, status: "PARTIAL", startedAt: now.toISOString(), finishedAt: now.toISOString() };
  assert.equal((await checkCommissionSyncAlert(now)).alerted, null, "時間到未做完（PARTIAL）唔算失敗");
  __salesMock.lastRun = null;
});

test("X6 R6 揀分店：範圍外 403；範圍內轉店", async () => {
  const { invoiceContext } = await import("./invoice");
  const { SalesActionError } = await import("./handover");
  const mf = await prisma.clinic.findUnique({ where: { code: "MF" }, select: { id: true } });
  assert.ok(mf);
  const ctx = await invoiceContext(CONV1, a, { scope: [tkwId] });
  assert.equal(ctx.clinicCode, "TKW");
  assert.deepEqual(ctx.clinics.map((c) => c.code), ["TKW"], "分店名單跟權限範圍");
  await assert.rejects(invoiceContext(CONV1, a, { scope: [tkwId], clinicCode: "MF" }), (e) => e instanceof SalesActionError && e.status === 403);
  await assert.rejects(invoiceContext(CONV1, a, { scope: null, clinicCode: "NOPE" }), (e) => e instanceof SalesActionError && e.status === 403);
  const all = await invoiceContext(CONV1, a, { scope: null, clinicCode: "MF" });
  assert.equal(all.clinicCode, "MF");
  assert.ok(all.clinics.length >= 2);
});

test("X7 U1 到期提醒：時段內、每個到期日一次、續期再提、設 0 唔提", async () => {
  const { remindExpiringProtections } = await import("./sweep");
  const noonHk = new Date(Date.UTC(2026, 10, 2, 4, 0)); // HK 12:00
  const nightHk = new Date(Date.UTC(2026, 10, 2, 15, 0)); // HK 23:00
  await prisma.salesSettings.upsert({ where: { id: "global" }, create: { id: "global", expiryRemindDays: 2 }, update: { expiryRemindDays: 2 } });
  const until = new Date(noonHk.getTime() + 30 * 3600_000);
  await protect(PIDS[0], a, { protectedUntil: until });
  await protect(PIDS[1], a, { protectedUntil: new Date(noonHk.getTime() + 5 * 86_400_000) });
  assert.equal((await remindExpiringProtections(nightHk)).reminded, 0, "時段外唔提");
  assert.equal((await remindExpiringProtections(noonHk)).reminded, 1);
  assert.equal((await remindExpiringProtections(noonHk)).reminded, 0, "同一到期日只提一次");
  assert.equal(await prisma.staffNotice.count({ where: { conversationId: CONV1, title: { contains: "日內到期" } } }), 1);
  await prisma.salesOwnership.update({ where: { patientApricotId: PIDS[0] }, data: { protectedUntil: new Date(until.getTime() + 3600_000) } });
  assert.equal((await remindExpiringProtections(noonHk)).reminded, 1, "續期（新到期日）再提");
  await prisma.salesSettings.update({ where: { id: "global" }, data: { expiryRemindDays: 0 } });
  await prisma.salesOwnership.update({ where: { patientApricotId: PIDS[0] }, data: { protectedUntil: new Date(until.getTime() + 7200_000) } });
  assert.equal((await remindExpiringProtections(noonHk)).reminded, 0, "設 0 唔提");
  await prisma.salesSettings.update({ where: { id: "global" }, data: { expiryRemindDays: 2 } });
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
});

test("X8 U8 負責病人名單：只推保護中／綁定 + 綁咗 Apricot 銷售員", async () => {
  const { __salesMock } = await import("@/lib/workforce/client");
  const { pushSalesPatientWatch } = await import("./sweep");
  await protect(PIDS[0], a);
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[1], state: "BOUND", salesStaffId: b, lastSalesStaffId: b } });
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[2], state: "POOL", lastSalesStaffId: a } });
  await protect(PIDS[3], nobind);
  const r = await pushSalesPatientWatch();
  assert.equal(r.skipped, null);
  const mine = __salesMock.watch.filter((w) => PIDS.includes(w.patientApricotId));
  assert.deepEqual(mine.map((w) => w.patientApricotId).sort(), [PIDS[0], PIDS[1]].sort());
  assert.equal(mine.find((w) => w.patientApricotId === PIDS[0])!.salesApricotUserId, `${PFX}-apu-a`);
  assert.equal(mine.find((w) => w.patientApricotId === PIDS[0])!.employeeId, `${PFX}-emp-a`);
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
});

test("X9 U9 冇對話開單：冇搜過 400；其他銷售負責 403；開到；重放唔重複審計", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const { SalesActionError } = await import("./handover");
  const line = { feeItemExtId: "mock-fee-TKW-3", qty: 1, up: 1000, discAmt: 0 };
  const direct = { patientApricotId: PIDS[11], patientCode: "TKW960012", patientName: "SALP5 病人12" };
  const base = { conversationId: null, staffId: a, practitionerExtId: "mock-pract-TKW-1", lines: [line], payment: null, scope: [tkwId] };
  await assert.rejects(openSalesInvoice({ ...base, requestKey: "salp5-dir-0001", patientApricotId: PIDS[11] }), (e) => e instanceof SalesActionError && e.code === "PATIENT_NOT_SEARCHED");
  await assert.rejects(
    openSalesInvoice({ ...base, requestKey: "salp5-dir-0001", patientApricotId: PIDS[10], direct }),
    (e) => e instanceof SalesActionError && e.code === "PATIENT_NOT_SEARCHED",
    "direct 同 patientApricotId 唔對 → 拒"
  );
  await protect(PIDS[11], b);
  await assert.rejects(openSalesInvoice({ ...base, requestKey: "salp5-dir-0002", patientApricotId: PIDS[11], direct }), (e) => e instanceof SalesActionError && e.status === 403);
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: PIDS[11] } });
  const r = await openSalesInvoice({ ...base, requestKey: "salp5-dir-0003", patientApricotId: PIDS[11], direct });
  assert.equal(r.review, true, "冇人負責 → 老闆對單");
  await openSalesInvoice({ ...base, requestKey: "salp5-dir-0003", patientApricotId: PIDS[11], direct });
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entity: "Patient", entityId: PIDS[11] } }), 1, "重放唔重複審計");
  // 唔係銷售 → blocked
  await assert.rejects(openSalesInvoice({ ...base, staffId: desk, requestKey: "salp5-dir-0004", patientApricotId: PIDS[11], direct }), (e) => e instanceof SalesActionError && e.status === 403);
});

test("X10 我的銷售：病人（就到期排先）、公海、對單結果（冇病人名）", async () => {
  const { mySales } = await import("./mine");
  const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  await protect(PIDS[0], a, { protectedUntil: new Date(Date.now() + 5 * 86_400_000) });
  await protect(PIDS[1], a, { protectedUntil: new Date(Date.now() + 1 * 86_400_000) });
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[2], state: "BOUND", salesStaffId: a, lastSalesStaffId: a } });
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[3], state: "POOL", lastSalesStaffId: a, since: new Date() } });
  await prisma.conversation.update({ where: { id: CONV1 }, data: { salesIntent: "HIGH" } });
  const m = await mySales(a, month);
  const mine = m.patients.filter((p) => PIDS.includes(p.patientApricotId));
  assert.deepEqual(mine.map((p) => p.patientApricotId), [PIDS[1], PIDS[0], PIDS[2]], "保護中最快到期排先，綁定排後");
  assert.equal(mine[0].daysLeft, 1);
  assert.equal(mine[0].intent, "HIGH");
  const pool = m.pool.find((p) => p.patientApricotId === PIDS[3]);
  assert.ok(pool && pool.wasMine);
  assert.ok(Array.isArray(m.reviews));
  assert.ok(m.reviews!.every((r) => r.patientName === null), "銷售睇對單唔出病人名");
  assert.ok(m.reviews!.some((r) => r.id === `${PFX}-r5`), "見到自己嘅對單");
  assert.ok(!m.reviews!.some((r) => r.salesApricotUserId !== `${PFX}-apu-a`), "唔見其他銷售嘅");
  await prisma.conversation.update({ where: { id: CONV1 }, data: { salesIntent: null } });
});
