/**
 * ★ cwi-sales-20261028：老闆管理病人歸屬（指派／轉移／放返公海）+ 設定預設值。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/admin.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * A1 指派：唔係銷售 → 400；BOUND 成功 + 審計 + 列表
 * A2 已有其他銷售 → 指派 409；轉移 → 新銷售
 * A3 放返公海 → POOL，lastSalesStaffId 保留
 * A4 冇對話嘅病人 id → 404（防亂打 id 造垃圾歸屬）
 * A5 轉移：先通知 workforce（之後付款歸新銷售）；workforce 連唔到 → 唔轉；新銷售未綁 Apricot → 409
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
const PID = "sala-pat-1";
const CONTACT = "sala-contact-1";
const CONV = "sala-conv-1";
const EMAILS = ["sala-a@sala.local", "sala-b@sala.local", "sala-desk@sala.local", "sala-adm@sala.local"];
let a: string;
let b: string;
let desk: string;
let adm: string;

async function cleanup(): Promise<void> {
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: PID } });
  await prisma.auditLog.deleteMany({ where: { entity: "SalesOwnership", entityId: PID } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV } });
  await prisma.conversation.deleteMany({ where: { id: CONV } });
  await prisma.contact.deleteMany({ where: { id: CONTACT } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId: tkw.id } }, ...extra } })).id;
  a = await mk(EMAILS[0], "SALA 銷售A", { isSales: true });
  b = await mk(EMAILS[1], "SALA 銷售B", { isSales: true, salesApricotUserId: "sala-apu-b" });
  desk = await mk(EMAILS[2], "SALA 前台");
  adm = await mk(EMAILS[3], "SALA 老闆", { role: "ADMIN" });
  await prisma.contact.create({ data: { id: CONTACT, clinicId: tkw.id, waId: "85290003201", profileName: "SALA 病人", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV, clinicId: tkw.id, contactId: CONTACT, lastMessageAt: new Date(), pinnedPatientApricotId: PID } });
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

test("A1 指派", async () => {
  const { assignOwnership, listOwnerships } = await import("./admin");
  const { SalesActionError } = await import("./handover");
  await assert.rejects(assignOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: desk, state: "BOUND" }), (e) => e instanceof SalesActionError && e.status === 400);
  await assignOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: a, state: "BOUND" });
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: PID } });
  assert.equal(own?.state, "BOUND");
  assert.equal(own?.salesStaffId, a);
  assert.equal(await prisma.auditLog.count({ where: { entityId: PID, action: "SALES_OWNER_ASSIGNED" } }), 1);
  const rows = await listOwnerships({ salesStaffId: a });
  assert.equal(rows.find((r) => r.patientApricotId === PID)?.salesName, "SALA 銷售A");
});

test("A2 已有銷售 → 指派 409；轉移", async () => {
  const { assignOwnership, transferOwnership } = await import("./admin");
  const { SalesActionError } = await import("./handover");
  await assert.rejects(assignOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: b, state: "BOUND" }), (e) => e instanceof SalesActionError && e.status === 409);
  await transferOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: b });
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: PID } });
  assert.equal(own?.salesStaffId, b);
  assert.equal(own?.state, "BOUND");
});

test("A3 放返公海", async () => {
  const { releaseOwnership } = await import("./admin");
  await releaseOwnership({ byStaffId: adm, patientApricotId: PID });
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: PID } });
  assert.equal(own?.state, "POOL");
  assert.equal(own?.salesStaffId, null);
  assert.equal(own?.lastSalesStaffId, b);
});

test("A4 冇對話嘅病人 → 404", async () => {
  const { assignOwnership } = await import("./admin");
  const { SalesActionError } = await import("./handover");
  await assert.rejects(
    assignOwnership({ byStaffId: adm, patientApricotId: "sala-nobody", toStaffId: a, state: "BOUND" }),
    (e) => e instanceof SalesActionError && e.status === 404
  );
  assert.equal(await prisma.salesOwnership.count({ where: { patientApricotId: "sala-nobody" } }), 0);
});

test("A5 轉移：先記 workforce；連唔到唔轉；未綁 Apricot 409", async () => {
  const { assignOwnership, transferOwnership } = await import("./admin");
  const { SalesActionError } = await import("./handover");
  const { _mockInvoiceStoreForTest } = await import("@/lib/workforce/client");
  await assignOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: a, state: "BOUND" });
  // a 未綁 Apricot → 轉返畀 a 唔得
  await prisma.salesOwnership.update({ where: { patientApricotId: PID }, data: { salesStaffId: b } });
  await assert.rejects(transferOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: a }), (e) => e instanceof SalesActionError && e.status === 409);
  await prisma.staffUser.update({ where: { id: a }, data: { salesApricotUserId: "sala-apu-a" } });
  process.env.WORKFORCE_MOCK_OWNER_CHANGE_FAIL = "1";
  try {
    await assert.rejects(transferOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: a }), (e) => e instanceof SalesActionError && e.status === 503);
  } finally {
    delete process.env.WORKFORCE_MOCK_OWNER_CHANGE_FAIL;
  }
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PID } }))?.salesStaffId, b, "workforce 連唔到 → 唔轉");
  const before = _mockInvoiceStoreForTest().ownerChanges.length;
  await transferOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: a });
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PID } }))?.salesStaffId, a);
  const oc = _mockInvoiceStoreForTest().ownerChanges.slice(before);
  assert.equal(oc.length, 1);
  assert.equal(oc[0].toInboxStaffId, a);
  assert.equal(oc[0].toSalesApricotUserId, "sala-apu-a");
});

test("A6 對抗：兩個老闆同時轉畀唔同銷售 → workforce 嘅轉移紀錄同最後歸屬一致", async () => {
  const { transferOwnership } = await import("./admin");
  const { _mockInvoiceStoreForTest } = await import("@/lib/workforce/client");
  // 而家歸 a（A5）；同時轉畀 b 同轉返 a 都唔得 — 用 b 同第三個銷售 c
  const c = (await prisma.staffUser.create({ data: { email: "sala-c@sala.local", name: "SALA 銷售C", role: "STAFF", passwordHash: "x", active: true, isSales: true, salesApricotUserId: "sala-apu-c" } })).id;
  try {
    const before = _mockInvoiceStoreForTest().ownerChanges.length;
    const rs = await Promise.allSettled([
      transferOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: b }),
      transferOwnership({ byStaffId: adm, patientApricotId: PID, toStaffId: c }),
    ]);
    assert.ok(rs.every((r) => r.status === "fulfilled"), JSON.stringify(rs.map((r) => r.status)));
    const final = (await prisma.salesOwnership.findUnique({ where: { patientApricotId: PID } }))?.salesStaffId;
    const oc = _mockInvoiceStoreForTest().ownerChanges.slice(before);
    assert.ok(oc.length >= 1 && oc.length <= 2);
    assert.equal(oc[oc.length - 1].toInboxStaffId, final, "workforce 最後一個轉移 = inbox 最後歸屬");
  } finally {
    await prisma.salesOwnership.updateMany({ where: { patientApricotId: PID, salesStaffId: c }, data: { salesStaffId: b } });
    await prisma.staffUser.delete({ where: { id: c } });
  }
});
