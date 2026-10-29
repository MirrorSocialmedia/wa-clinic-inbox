/**
 * ★ cwi-sales 第 3 期：inbox 傭金（我的銷售／老闆總覽／對單收養／綁定自動解除）— 含對抗式測試。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/phase3.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * W1 我的銷售：唔係銷售 403；只見自己嘅單／分類帳（mock）；保護中／綁定數；病人編號由 inbox 補
 * W2 老闆總覽：所有銷售都列（冇數 = 0），金額只計自己
 * W3 對單收養：Apricot 直接開 → 銷售員未綁 inbox → 409（唔批）；綁咗 → adopt 帶返 inbox 帳號
 * W4 綁定自動解除：24 個月冇付款 → 公海 + 通知；有付款 → 留；workforce 冇回／連唔到 → 唔放；
 *    並發（老闆啱啱轉移）→ 條件 update 唔錯放；重跑冪等
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
const PFX = "salw";
const C1 = `${PFX}contact00000000000000001`;
const CONV1 = `${PFX}conv0000000000000000001`;
const PIDS = [`${PFX}-p1`, `${PFX}-p2`, `${PFX}-p3`, `${PFX}-p4`, `${PFX}-p5`];
const EMAILS = ["salw-a@salw.local", "salw-b@salw.local", "salw-desk@salw.local", "salw-adm@salw.local"];
let a: string;
let b: string;
let desk: string;
let adm: string;

async function cleanup(): Promise<void> {
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entity: "SalesOwnership", entityId: { in: PIDS } }, { entity: "Conversation", entityId: CONV1 }] } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV1 } });
  await prisma.contactPatientLink.deleteMany({ where: { contactId: C1 } });
  await prisma.conversation.deleteMany({ where: { id: CONV1 } });
  await prisma.contact.deleteMany({ where: { id: C1 } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.salesSettings.deleteMany({ where: { id: "global" } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId: tkw.id } }, ...extra } })).id;
  a = await mk(EMAILS[0], "SALW 銷售A", { isSales: true, salesApricotUserId: `${PFX}-apu-a`, workforceEmployeeId: `${PFX}-emp-a` });
  b = await mk(EMAILS[1], "SALW 銷售B", { isSales: true, salesApricotUserId: `${PFX}-apu-b` });
  desk = await mk(EMAILS[2], "SALW 前台");
  adm = await mk(EMAILS[3], "SALW 老闆", { role: "ADMIN" });
  await prisma.contact.create({ data: { id: C1, clinicId: tkw.id, waId: "85290005101", profileName: "SALW 1", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV1, clinicId: tkw.id, contactId: C1, lastMessageAt: new Date(), pinnedPatientApricotId: PIDS[0] } });
  await prisma.contactPatientLink.createMany({
    data: PIDS.map((p, i) => ({ contactId: C1, patientApricotId: p, patientCode: `TKW95000${i + 1}`, patientName: `SALW 病人${i + 1}`, source: "SEARCH" })),
  });
  const { _resetMockInvoicesForTest } = await import("@/lib/workforce/client");
  _resetMockInvoicesForTest();
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

const nowMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

test("W1 我的銷售：唔係銷售 403；只見自己", async () => {
  const { mySales } = await import("./mine");
  const { SalesActionError } = await import("./handover");
  const { createSalesInvoice } = await import("@/lib/workforce/client");
  await assert.rejects(mySales(desk, nowMonth()), (e) => e instanceof SalesActionError && e.status === 403);
  const line = { feeItemExtId: "mock-fee-TKW-3", qty: 1, up: 39000, discAmt: 0 };
  const body = (pid: string, sales: string) => ({ clinicCode: "TKW", patientApricotId: pid, patientCode: "X", conversationId: CONV1, employeeId: null, salesApricotUserId: sales, practitionerExtId: "p", ownership: "PROTECTED" as const, lines: [line], payment: { amt: 10000, methodExtId: "mock-pm-cash" } });
  await createSalesInvoice({ requestKey: "salwkey-a-0001", ...body(PIDS[0], `${PFX}-apu-a`) }, a);
  await createSalesInvoice({ requestKey: "salwkey-b-0001", ...body(PIDS[1], `${PFX}-apu-b`) }, b);
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[0], state: "BOUND", salesStaffId: a, lastSalesStaffId: a } });
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[2], state: "PROTECTED", salesStaffId: a, lastSalesStaffId: a, protectedUntil: new Date(Date.now() + 86_400_000) } });
  const m = await mySales(a, nowMonth());
  assert.deepEqual(m.counts, { protected: 1, bound: 1 });
  assert.equal(m.invoices.length, 1, "只見自己嘅單");
  assert.equal(m.invoices[0].patientCode, "TKW950001", "病人編號由 inbox 補");
  assert.equal(m.invoices[0].conversationId, CONV1);
  assert.equal(m.ledger.rows.length, 1);
  assert.ok(m.ledger.rows.every((r) => r.patientApricotId === PIDS[0]), "分類帳只係自己");
  assert.equal(m.ledger.totals.counted, 300); // 10000 × 3%
});

test("W2 老闆總覽：所有銷售都列，冇數 = 0", async () => {
  const { commissionSummary } = await import("./mine");
  const s = await commissionSummary(nowMonth());
  const ra = s.rows.find((r) => r.staffId === a);
  const rb = s.rows.find((r) => r.staffId === b);
  assert.equal(ra?.counted, 300);
  assert.equal(rb?.counted, 300);
  assert.equal(s.rows.some((r) => r.staffId === desk), false, "前台唔列");
  const other = await commissionSummary("2020-01");
  assert.ok(other.rows.filter((r) => r.staffId === a || r.staffId === b).every((r) => r.counted === 0 && r.lines === 0));
});

test("W3 對單收養：未綁 inbox → 409；綁咗 → adopt", async () => {
  const { decideReviewFromInbox } = await import("./reviews");
  const { SalesActionError } = await import("./handover");
  const { _mockInvoiceStoreForTest } = await import("@/lib/workforce/client");
  const store = _mockInvoiceStoreForTest();
  const base = { kind: "RECONCILE_DIRECT", status: "OPEN", apricotBillCode: "D", clinicExtId: "x", salesInvoiceId: null, patientApricotId: PIDS[3], amount: 100, approvedPct: null, decidedBy: null, decidedAt: null, note: null, createdAt: new Date().toISOString() };
  store.reviews.set("salw-rev-1", { ...base, id: "salw-rev-1", apricotBillId: "salw-bill-1", salesApricotUserId: "salw-apu-nobody" });
  store.reviews.set("salw-rev-2", { ...base, id: "salw-rev-2", apricotBillId: "salw-bill-2", salesApricotUserId: `${PFX}-apu-a` });
  await assert.rejects(decideReviewFromInbox("salw-rev-1", { decision: "APPROVED" }, adm), (e) => e instanceof SalesActionError && e.status === 409);
  assert.equal(store.reviews.get("salw-rev-1")?.status, "OPEN", "冇批");
  await decideReviewFromInbox("salw-rev-1", { decision: "REJECTED", note: "唔係我哋銷售" }, adm); // 拒唔使對返
  assert.equal(store.reviews.get("salw-rev-1")?.status, "REJECTED");
  await decideReviewFromInbox("salw-rev-2", { decision: "APPROVED", approvedPct: 80 }, adm);
  assert.equal(store.reviews.get("salw-rev-2")?.status, "APPROVED");
});

test("W4 綁定自動解除", async () => {
  const { runBoundAutoRelease } = await import("./sweep");
  const old = new Date(Date.now() - 800 * 86_400_000);
  const recentPay = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const oldPay = new Date(Date.now() - 760 * 86_400_000).toISOString();
  await prisma.salesOwnership.update({ where: { patientApricotId: PIDS[0] }, data: { since: old } }); // A：舊付款 → 放
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[1], state: "BOUND", salesStaffId: b, lastSalesStaffId: b, since: old } }); // 近排有付款 → 留
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[3], state: "BOUND", salesStaffId: b, lastSalesStaffId: b, since: old } }); // workforce 冇回 → 留
  await prisma.salesOwnership.create({ data: { patientApricotId: PIDS[4], state: "BOUND", salesStaffId: b, lastSalesStaffId: b, since: new Date() } }); // 啱啱綁 → 唔睇
  const activity = async (ids: string[]) =>
    ids.filter((id) => id !== PIDS[3]).map((id) => ({ patientApricotId: id, lastPaymentAt: id === PIDS[0] ? oldPay : id === PIDS[1] ? recentPay : null }));

  // workforce 連唔到 → 成批跳過
  const down = await runBoundAutoRelease(new Date(), async () => {
    throw new Error("down");
  });
  assert.equal(down.skipped, "WORKFORCE_UNAVAILABLE");
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[0] } }))?.state, "BOUND");

  // 並發：老闆啱啱轉移（since 變咗）→ 唔錯放
  const racing = async (ids: string[]) => {
    await prisma.salesOwnership.update({ where: { patientApricotId: PIDS[0] }, data: { salesStaffId: b, since: new Date() } });
    return activity(ids);
  };
  const r0 = await runBoundAutoRelease(new Date(), racing);
  assert.equal(r0.released, 0);
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[0] } }))?.state, "BOUND");

  await prisma.salesOwnership.update({ where: { patientApricotId: PIDS[0] }, data: { salesStaffId: a, since: old } });
  const r = await runBoundAutoRelease(new Date(), activity);
  assert.equal(r.released, 1);
  const p0 = await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[0] } });
  assert.equal(p0?.state, "POOL");
  assert.equal(p0?.lastSalesStaffId, a);
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[1] } }))?.state, "BOUND", "近排有付款");
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: PIDS[3] } }))?.state, "BOUND", "workforce 冇回 → 唔放");
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_OWNER_AUTO_RELEASED", entityId: PIDS[0] } }), 1);
  const n = await prisma.staffNotice.findFirst({ where: { conversationId: CONV1, title: { contains: "放返銷售公海" } } });
  assert.deepEqual(n?.targetStaffIds, [a]);
  assert.ok(!n?.title.includes("SALW 病人"), "通知零病人名");
  assert.equal((await runBoundAutoRelease(new Date(), activity)).released, 0, "重跑冪等");
});
