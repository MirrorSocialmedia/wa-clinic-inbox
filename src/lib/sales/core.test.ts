/**
 * ★ cwi-sales-20261028：銷售系統第 1 期核心（預約綁定／保護期／到期 sweep／對話鎖／冇人覆通知）。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/core.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * S1 保護到「預約日後 N 日」23:59:59 香港時間
 * S2 唔係銷售落單 → 唔記錄；銷售落單 → PROTECTED；同一預約重複 → 冪等
 * S3 Flow 發送人優先過落單人
 * S4 同一銷售再約 → RENEWED（輪數 +1）；到上限 → CYCLE_CAP
 * S5 其他銷售保護中 → OWNED_BY_OTHER + 定向通知；上限 → CAP_REACHED；太遠 → TOO_FAR
 * S6 改期承接：新預約跟舊預約，保護期跟新日子，唔加輪數
 * S7 到期：之後有預約 → 延期；冇 → POOL + 通知；workforce 唔得 → 跳過
 * S8 對話鎖：負責銷售可覆、其他人唔可以、轉交後可以、停用銷售唔鎖
 * S9 冇人覆：N 分鐘後通知負責銷售 + 主管，同一條 inbound 只通知一次
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
const PFX = "salt";
const CONTACT = `${PFX}contact000000000000001`;
const CONV = `${PFX}conv00000000000000000001`;
const P1 = `${PFX}-pat-1`;
const P2 = `${PFX}-pat-2`;
const P3 = `${PFX}-pat-3`;
const EMAILS = ["salt-a@salt.local", "salt-b@salt.local", "salt-desk@salt.local", "salt-sup@salt.local"];
let clinicId: string;
let salesA: string;
let salesB: string;
let desk: string;
let sup: string;
const NOW = new Date("2026-10-28T04:00:00Z"); // 香港 12:00

async function cleanup(): Promise<void> {
  const pids = [P1, P2, P3];
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: pids } } });
  await prisma.salesBooking.deleteMany({ where: { patientApricotId: { in: pids } } });
  await prisma.salesDelegation.deleteMany({ where: { conversationId: CONV } });
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: CONV }, select: { id: true } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV } });
  await prisma.flowSession.deleteMany({ where: { conversationId: CONV } });
  await prisma.message.deleteMany({ where: { conversationId: CONV } });
  await prisma.contactPatientLink.deleteMany({ where: { contactId: CONTACT } });
  await prisma.conversation.deleteMany({ where: { id: CONV } });
  await prisma.contact.deleteMany({ where: { id: CONTACT } });
  await prisma.auditLog.deleteMany({ where: { entity: "SalesOwnership", entityId: { in: pids } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.salesSettings.deleteMany({ where: { id: "global" } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  const mk = (email: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId } }, ...extra } });
  salesA = (await mk(EMAILS[0], "SALT 銷售A", { isSales: true })).id;
  salesB = (await mk(EMAILS[1], "SALT 銷售B", { isSales: true })).id;
  desk = (await mk(EMAILS[2], "SALT 前台")).id;
  sup = (await mk(EMAILS[3], "SALT 主管", { role: "SUPERVISOR" })).id;
  await prisma.contact.create({ data: { id: CONTACT, clinicId, waId: "85290003001", profileName: "SALT 病人", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV, clinicId, contactId: CONTACT, lastMessageAt: NOW, pinnedPatientApricotId: P1 } });
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

const book = async (o: { appt: string; pid?: string; date?: string; actor?: string | null; flowToken?: string | null }) => {
  const { recordSalesBooking } = await import("./core");
  return recordSalesBooking({
    apricotApptId: o.appt,
    patientApricotId: o.pid ?? P1,
    apptDate: o.date ?? "2026-11-01",
    clinicId,
    conversationId: CONV,
    flowToken: o.flowToken ?? null,
    actorStaffId: o.actor ?? null,
    source: "BOOKING",
    now: NOW,
  });
};

test("S1 保護到期時間", async () => {
  const { protectedUntilFor } = await import("./core");
  assert.equal(protectedUntilFor("2026-11-01", 7).toISOString(), "2026-11-08T15:59:59.999Z");
});

test("S2–S4 落單綁定、冪等、Flow 發送人優先、續期、輪數上限", async () => {
  assert.equal(await book({ appt: "salt-a0", actor: desk }), null, "前台落單唔計");
  assert.equal(await prisma.salesBooking.count({ where: { apricotApptId: "salt-a0" } }), 0);

  const r1 = await book({ appt: "salt-a1", actor: salesA });
  assert.deepEqual(r1, { outcome: "PROTECTED", salesStaffId: salesA });
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: P1 } });
  assert.equal(own?.state, "PROTECTED");
  assert.equal(own?.rounds, 1);
  assert.equal(own?.protectedUntil?.toISOString(), "2026-11-08T15:59:59.999Z");
  assert.deepEqual(await book({ appt: "salt-a1", actor: salesB }), { outcome: "PROTECTED", salesStaffId: salesA }, "同一預約冪等");

  // Flow 發送人（銷售A）優先過落單人（前台）
  const msg = await prisma.message.create({
    data: { conversationId: CONV, direction: "OUT", channel: "API", type: "interactive", body: "{}", status: "SENT", sentByStaffId: salesA, waTimestamp: NOW },
  });
  await prisma.flowSession.create({ data: { conversationId: CONV, clinicId, flowToken: "salt-flow-1", status: "COMPLETED", messageId: msg.id } });
  const r2 = await book({ appt: "salt-a2", actor: desk, flowToken: "salt-flow-1", date: "2026-11-05" });
  assert.deepEqual(r2, { outcome: "RENEWED", salesStaffId: salesA });
  const own2 = await prisma.salesOwnership.findUnique({ where: { patientApricotId: P1 } });
  assert.equal(own2?.rounds, 2);
  assert.equal(own2?.protectedUntil?.toISOString(), "2026-11-12T15:59:59.999Z", "跟較遲嗰個");

  assert.equal((await book({ appt: "salt-a3", actor: salesA }))?.outcome, "RENEWED");
  assert.equal((await book({ appt: "salt-a4", actor: salesA }))?.outcome, "CYCLE_CAP", "第 4 輪 > 上限 3");
});

test("S5 其他銷售、上限、太遠", async () => {
  const r = await book({ appt: "salt-b1", actor: salesB });
  assert.equal(r?.outcome, "OWNED_BY_OTHER");
  const n = await prisma.staffNotice.findFirst({ where: { conversationId: CONV, kind: "SALES_PROTECTION" }, orderBy: { createdAt: "desc" } });
  assert.deepEqual(n?.targetStaffIds, [salesB]);

  await prisma.salesSettings.upsert({ where: { id: "global" }, create: { id: "global", concurrentCap: 1 }, update: { concurrentCap: 1 } });
  assert.equal((await book({ appt: "salt-a5", pid: P2, actor: salesA }))?.outcome, "CAP_REACHED");
  await prisma.salesSettings.update({ where: { id: "global" }, data: { concurrentCap: 30 } });
  assert.equal((await book({ appt: "salt-a6", pid: P2, actor: salesA, date: "2027-01-30" }))?.outcome, "TOO_FAR");
  assert.equal(await prisma.salesOwnership.count({ where: { patientApricotId: P2 } }), 0);
});

test("S6 改期承接", async () => {
  const { rescheduleSalesBooking } = await import("./core");
  await book({ appt: "salt-c1", pid: P3, actor: salesB, date: "2026-11-02" });
  assert.equal(await rescheduleSalesBooking({ oldApptId: "salt-c1", newApptId: "salt-c2", newDate: "2026-11-10" }), true);
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: P3 } });
  assert.equal(own?.lastApptId, "salt-c2");
  assert.equal(own?.rounds, 1, "改期唔加輪數");
  assert.equal(own?.protectedUntil?.toISOString(), "2026-11-17T15:59:59.999Z");
  assert.equal(await rescheduleSalesBooking({ oldApptId: "salt-none", newApptId: "salt-x", newDate: "2026-11-10" }), false);
});

test("S7 到期 sweep", async () => {
  const { expireProtections } = await import("./core");
  const later = new Date("2026-11-20T04:00:00Z");
  // P1（銷售A）：之後有預約 → 延期；P3（銷售B）：冇 → POOL
  const r = await expireProtections(later, async (pid) => (pid === P1 ? [{ apricotApptId: "salt-a9", date: "2026-11-25" }] : []));
  assert.deepEqual({ extended: r.extended, pooled: r.pooled }, { extended: 1, pooled: 1 });
  const p1 = await prisma.salesOwnership.findUnique({ where: { patientApricotId: P1 } });
  assert.equal(p1?.state, "PROTECTED");
  assert.equal(p1?.protectedUntil?.toISOString(), "2026-12-02T15:59:59.999Z");
  const p3 = await prisma.salesOwnership.findUnique({ where: { patientApricotId: P3 } });
  assert.equal(p3?.state, "POOL");
  assert.equal(p3?.salesStaffId, null);
  assert.equal(p3?.lastSalesStaffId, salesB);
  // workforce 唔得 → 跳過
  const r2 = await expireProtections(new Date("2026-12-10T04:00:00Z"), async () => null);
  assert.equal(r2.skipped, 1);
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: P1 } }))?.state, "PROTECTED");
});

test("S8 對話鎖", async () => {
  const { conversationSalesLock, canReplyUnderLock } = await import("./core");
  const lock = await conversationSalesLock(CONV, NOW);
  assert.deepEqual(lock.owners.map((o) => o.staffId), [salesA]);
  assert.equal(canReplyUnderLock(lock, salesA), true);
  assert.equal(canReplyUnderLock(lock, desk), false);
  await prisma.salesDelegation.create({ data: { conversationId: CONV, toStaffId: desk, byStaffId: salesA, kind: "ONCE", expiresAt: new Date(NOW.getTime() + 3600_000) } });
  assert.equal(canReplyUnderLock(await conversationSalesLock(CONV, NOW), desk), true, "轉交後可以覆");
  assert.equal(canReplyUnderLock(await conversationSalesLock(CONV, new Date(NOW.getTime() + 7200_000)), desk), false, "今次轉交過期");
  await prisma.staffUser.update({ where: { id: salesA }, data: { isSales: false } });
  assert.equal((await conversationSalesLock(CONV, NOW)).owners.length, 0, "取消銷售人員唔再鎖");
  await prisma.staffUser.update({ where: { id: salesA }, data: { isSales: true } });
});

test("S9 冇人覆通知", async () => {
  const { runSalesUnansweredSweep } = await import("./sweep");
  const inboundAt = new Date(NOW.getTime() - 40 * 60_000);
  await prisma.conversation.update({ where: { id: CONV }, data: { lastInboundAt: inboundAt, lastOutboundAt: new Date(inboundAt.getTime() - 60_000) } });
  const r = await runSalesUnansweredSweep(NOW);
  assert.equal(r.notified, 1);
  const n = await prisma.staffNotice.findFirst({ where: { conversationId: CONV, kind: "SALES_UNANSWERED" } });
  assert.ok(n?.targetStaffIds.includes(salesA) && n.targetStaffIds.includes(sup), "負責銷售 + 主管");
  assert.equal((await runSalesUnansweredSweep(NOW)).notified, 0, "同一條 inbound 唔重發");
  assert.equal((await runSalesUnansweredSweep(new Date("2026-10-28T15:00:00Z"))).notified, 0, "香港 23:00 唔通知");
});
