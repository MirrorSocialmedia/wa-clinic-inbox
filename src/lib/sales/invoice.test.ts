/**
 * ★ cwi-sales 第 2 期：對話右欄開單（inbox 守門 + workforce mock）— 含對抗式測試。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/invoice.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * V1 守門：唔係銷售／未綁 Apricot 帳號 → blocked；病人分類（你保護中／冇人／其他銷售）
 * V2 唔可以幫人開：其他銷售嘅病人 403（就算被轉交咗對話）；唔連對話 404；冇編號 409；對話被鎖 423
 * V3 成功：保護中 + 傭金項目 + 即場收錢 → 轉綁定；審計零病人名；同 key 重撳 = 重放（唔再審計、唔再轉）
 * V4 同 key 並發 5 次 → 只開一張、只審計一次
 * V5 同 key 改內容 → 409；未確認（504）→ 冇審計、冇轉綁定、帶 retryAfterSec
 * V6 冇人負責 → 入對單；對單列表補返銷售名／病人編號／對話；批／拒（冪等、拒要原因）
 * V7 workforce 斷線（status 0）→ 當未確認；冇收錢／冇傭金項目 → 唔轉綁定
 * V8 對抗：inbox 逾時但 workforce 開咗 → 同 key 再撳（重放）要補審計（只補一次）
 * V9 對抗：連環開單 → 10 分鐘最多 10 張（429）
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
const PFX = "salv";
const C1 = `${PFX}contact00000000000000001`;
const C2 = `${PFX}contact00000000000000002`;
const CONV1 = `${PFX}conv0000000000000000001`;
const CONV2 = `${PFX}conv0000000000000000002`;
const P1 = `${PFX}-p1`; // A 保護中
const P2 = `${PFX}-p2`; // 冇人
const P3 = `${PFX}-p3`; // B 綁定（CONV2）
const P4 = `${PFX}-p4`; // 冇編號
const PIDS = [P1, P2, P3, P4];
const NAME = "黃小明SALV";
const EMAILS = ["salv-a@salv.local", "salv-b@salv.local", "salv-c@salv.local", "salv-desk@salv.local", "salv-adm@salv.local"];
const COMMISSION_FILE = path.resolve(__dirname, "../../../.dev/workforce-mock-commission.json");
let commissionBackup: string | null = null;
let a: string;
let b: string;
let c: string;
let desk: string;
let adm: string;

async function cleanup(): Promise<void> {
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { in: PIDS } } });
  await prisma.salesDelegation.deleteMany({ where: { conversationId: { in: [CONV1, CONV2] } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entity: "Conversation", entityId: { in: [CONV1, CONV2] } }, { entity: "SalesOwnership", entityId: { in: PIDS } }] } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: { in: [CONV1, CONV2] } } });
  await prisma.contactPatientLink.deleteMany({ where: { contactId: { in: [C1, C2] } } });
  await prisma.conversation.deleteMany({ where: { id: { in: [CONV1, CONV2] } } });
  await prisma.contact.deleteMany({ where: { id: { in: [C1, C2] } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  commissionBackup = existsSync(COMMISSION_FILE) ? readFileSync(COMMISSION_FILE, "utf8") : null;
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  const clinicId = tkw.id;
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId } }, ...extra } })).id;
  a = await mk(EMAILS[0], "SALV 銷售A", { isSales: true, salesApricotUserId: `${PFX}-apu-a`, workforceEmployeeId: `${PFX}-emp-a` });
  b = await mk(EMAILS[1], "SALV 銷售B", { isSales: true, salesApricotUserId: `${PFX}-apu-b` });
  c = await mk(EMAILS[2], "SALV 銷售C（未綁）", { isSales: true });
  desk = await mk(EMAILS[3], "SALV 前台");
  adm = await mk(EMAILS[4], "SALV 老闆", { role: "ADMIN" });
  await prisma.contact.create({ data: { id: C1, clinicId, waId: "85290004101", profileName: NAME, labels: [] } });
  await prisma.contact.create({ data: { id: C2, clinicId, waId: "85290004102", profileName: "SALV 2", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV1, clinicId, contactId: C1, lastMessageAt: new Date(), pinnedPatientApricotId: P1, pinnedPatientName: NAME } });
  await prisma.conversation.create({ data: { id: CONV2, clinicId, contactId: C2, lastMessageAt: new Date(), pinnedPatientApricotId: P3 } });
  await prisma.contactPatientLink.createMany({
    data: [
      { contactId: C1, patientApricotId: P1, patientCode: "TKW900001", patientName: NAME, source: "SEARCH" },
      { contactId: C1, patientApricotId: P2, patientCode: "TKW900002", patientName: "SALV 家人", source: "SEARCH" },
      { contactId: C1, patientApricotId: P4, patientCode: null, patientName: "SALV 冇編號", source: "SEARCH" },
      { contactId: C2, patientApricotId: P3, patientCode: "TKW900003", patientName: "SALV B 病人", source: "SEARCH" },
    ],
  });
  await prisma.salesOwnership.create({ data: { patientApricotId: P1, state: "PROTECTED", salesStaffId: a, lastSalesStaffId: a, protectedUntil: new Date(Date.now() + 5 * 86_400_000), rounds: 1 } });
  await prisma.salesOwnership.create({ data: { patientApricotId: P3, state: "BOUND", salesStaffId: b, lastSalesStaffId: b } });
  const { putCommissionItems, _resetMockInvoicesForTest } = await import("@/lib/workforce/client");
  _resetMockInvoicesForTest();
  await putCommissionItems("TKW", [{ feeItemExtId: "mock-fee-TKW-3", ratePct: 3 }], adm); // IMPLANT 3%
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

let seq = 0;
const key = () => `salvkey${Date.now().toString(36)}${++seq}`;
const implant = { feeItemExtId: "mock-fee-TKW-3", qty: 1, up: 39000, discAmt: 1000, remarks: "#25" };
const checkup = { feeItemExtId: "mock-fee-TKW-2", qty: 1, up: 300, discAmt: 0 };
const rejects = (p: Promise<unknown>, status: number, code: string) =>
  assert.rejects(p, (e: { status?: number; code?: string; message?: string }) => {
    assert.equal(e.code, code, e.message);
    assert.equal(e.status, status);
    return true;
  });

test("V1 守門 + 病人分類", async () => {
  const { invoiceContext } = await import("./invoice");
  assert.equal((await invoiceContext(CONV1, desk)).blocked, "只有銷售人員可以開單");
  assert.match((await invoiceContext(CONV1, c)).blocked ?? "", /未綁定 Apricot/);
  const ctx = await invoiceContext(CONV1, a);
  assert.equal(ctx.blocked, null);
  assert.equal(ctx.clinicCode, "TKW");
  const by = new Map(ctx.patients.map((p) => [p.patientApricotId, p]));
  assert.equal(by.get(P1)?.ownership, "MINE_PROTECTED");
  assert.equal(by.get(P2)?.ownership, "NONE");
  assert.equal(by.get(P4)?.code, null);
  // B 睇 CONV1：A 鎖住 → blocked（423 類）
  assert.match((await invoiceContext(CONV1, b)).blocked ?? "", /負責呢個對話/);
});

test("V2 唔可以幫人開單", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const base = { practitionerExtId: "mock-pract-TKW-1", lines: [implant], payment: null };
  // B 嘅病人：A 被轉交咗對話（可以覆）都唔可以開
  await prisma.salesDelegation.create({ data: { conversationId: CONV2, toStaffId: a, byStaffId: b, kind: "PERMANENT" } });
  await rejects(openSalesInvoice({ conversationId: CONV2, staffId: a, requestKey: key(), patientApricotId: P3, ...base }), 403, "OWNED_BY_OTHER");
  await rejects(openSalesInvoice({ conversationId: CONV1, staffId: a, requestKey: key(), patientApricotId: P3, ...base }), 404, "PATIENT_NOT_LINKED");
  await rejects(openSalesInvoice({ conversationId: CONV1, staffId: a, requestKey: key(), patientApricotId: P4, ...base }), 409, "PATIENT_CODE_MISSING");
  await rejects(openSalesInvoice({ conversationId: CONV1, staffId: b, requestKey: key(), patientApricotId: P2, ...base }), 423, "CANNOT_INVOICE");
  await rejects(openSalesInvoice({ conversationId: CONV1, staffId: desk, requestKey: key(), patientApricotId: P2, ...base }), 403, "CANNOT_INVOICE");
  await rejects(openSalesInvoice({ conversationId: CONV1, staffId: a, requestKey: "bad key!", patientApricotId: P1, ...base }), 400, "BAD_REQUEST_KEY");
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: { in: [CONV1, CONV2] } } }), 0);
});

test("V3 成功 → 轉綁定；重放唔重複", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const k = key();
  const input = { conversationId: CONV1, staffId: a, requestKey: k, patientApricotId: P1, practitionerExtId: "mock-pract-TKW-1", lines: [implant, checkup], payment: { amt: 10000, methodExtId: "mock-pm-cash" } };
  const r = await openSalesInvoice(input);
  assert.equal(r.totalAmt, 38300);
  assert.equal(r.commissionableAmt, 38000);
  assert.equal(r.bound, true);
  assert.equal(r.review, false);
  const own = await prisma.salesOwnership.findUnique({ where: { patientApricotId: P1 } });
  assert.equal(own?.state, "BOUND");
  assert.equal(own?.protectedUntil, null);
  const audits = await prisma.auditLog.findMany({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1 } });
  assert.equal(audits.length, 1);
  assert.ok(!JSON.stringify(audits[0].meta).includes(NAME), "審計零病人名");
  assert.ok(!JSON.stringify(audits[0].meta).includes("#25"), "審計唔記備註");
  const again = await openSalesInvoice(input);
  assert.equal(again.replayed, true);
  assert.equal(again.billId, r.billId);
  assert.equal(again.bound, false, "已經綁定 → 唔再轉");
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1 } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_OWNER_BOUND", entityId: P1 } }), 1);
});

test("V4 同 key 並發 5 次 → 一張單、一個審計", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const before = await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1 } });
  const input = { conversationId: CONV1, staffId: a, requestKey: key(), patientApricotId: P1, practitionerExtId: "mock-pract-TKW-1", lines: [checkup], payment: null };
  const rs = await Promise.all(Array.from({ length: 5 }, () => openSalesInvoice(input)));
  assert.equal(new Set(rs.map((x) => x.billId)).size, 1);
  assert.equal(rs.filter((x) => !x.replayed).length, 1);
  assert.equal((await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1 } })) - before, 1);
});

test("V5 同 key 改內容 409；未確認 504 冇副作用", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const k = key();
  const base = { conversationId: CONV1, staffId: a, requestKey: k, patientApricotId: P2, practitionerExtId: "mock-pract-TKW-1", payment: null };
  await openSalesInvoice({ ...base, lines: [checkup] });
  await rejects(openSalesInvoice({ ...base, lines: [{ ...checkup, qty: 2 }] }), 409, "KEY_REUSED");

  const before = await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1 } });
  process.env.WORKFORCE_MOCK_INVOICE_UNCONFIRMED = "1";
  try {
    await assert.rejects(openSalesInvoice({ ...base, requestKey: key(), lines: [implant] }), (e: { status?: number; code?: string; retryAfterSec?: number }) => {
      assert.equal(e.status, 504);
      assert.equal(e.code, "UNCONFIRMED");
      assert.equal(e.retryAfterSec, 60);
      return true;
    });
  } finally {
    delete process.env.WORKFORCE_MOCK_INVOICE_UNCONFIRMED;
  }
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1 } }), before);

  process.env.WORKFORCE_MOCK_INVOICE_WRITE = "0";
  try {
    await rejects(openSalesInvoice({ ...base, requestKey: key(), lines: [implant] }), 503, "WRITE_DISABLED");
  } finally {
    delete process.env.WORKFORCE_MOCK_INVOICE_WRITE;
  }
});

test("V6 冇人負責 → 對單；批／拒", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const { listSalesReviews } = await import("./reviews");
  const { decideSalesReview } = await import("@/lib/workforce/client");
  const r = await openSalesInvoice({ conversationId: CONV1, staffId: a, requestKey: key(), patientApricotId: P2, practitionerExtId: "mock-pract-TKW-2", lines: [implant], payment: { amt: 500, methodExtId: "mock-pm-cash" } });
  assert.equal(r.review, true);
  assert.equal(r.bound, false, "保護外 → 唔會自動變自己病人");
  assert.equal(await prisma.salesOwnership.count({ where: { patientApricotId: P2 } }), 0);
  const rows = await listSalesReviews("OPEN");
  const mine = rows.find((x) => x.apricotBillId === r.billId);
  assert.ok(mine);
  assert.equal(mine.salesStaffName, "SALV 銷售A");
  assert.equal(mine.patientCode, "TKW900002");
  assert.equal(mine.conversationId, CONV1);
  await assert.rejects(decideSalesReview(mine.id, { decision: "REJECTED" }, adm), (e: { code?: string }) => e.code === "NOTE_REQUIRED");
  await decideSalesReview(mine.id, { decision: "APPROVED", approvedPct: 50 }, adm);
  await decideSalesReview(mine.id, { decision: "APPROVED", approvedPct: 50 }, adm); // 冪等
  await assert.rejects(decideSalesReview(mine.id, { decision: "REJECTED", note: "x" }, adm), (e: { code?: string }) => e.code === "ALREADY_DECIDED");
  assert.equal((await listSalesReviews("OPEN")).some((x) => x.id === mine.id), false);
});

test("V7 斷線當未確認；冇收錢／冇傭金唔轉綁定", async () => {
  const { invoiceError, openSalesInvoice } = await import("./invoice");
  const { WorkforceApiError } = await import("@/lib/workforce/client");
  const e = invoiceError(new WorkforceApiError(0, "/api/external/v1/sales/invoices"));
  assert.equal(e.status, 504);
  assert.equal(e.code, "UNCONFIRMED");
  assert.equal(invoiceError(new WorkforceApiError(422, "/x", "INVOICE_REJECTED")).message.includes("拒絕"), true);
  assert.equal(invoiceError(new WorkforceApiError(500, "/x")).code, "WORKFORCE_ERROR");

  // 重設 P1 做保護中：冇收錢 → 唔轉；收錢但冇傭金項目 → 唔轉
  await prisma.salesOwnership.update({ where: { patientApricotId: P1 }, data: { state: "PROTECTED", protectedUntil: new Date(Date.now() + 86_400_000) } });
  const base = { conversationId: CONV1, staffId: a, patientApricotId: P1, practitionerExtId: "mock-pract-TKW-1" };
  assert.equal((await openSalesInvoice({ ...base, requestKey: key(), lines: [implant], payment: null })).bound, false);
  assert.equal((await openSalesInvoice({ ...base, requestKey: key(), lines: [checkup], payment: { amt: 300, methodExtId: "mock-pm-cash" } })).bound, false);
  assert.equal((await prisma.salesOwnership.findUnique({ where: { patientApricotId: P1 } }))?.state, "PROTECTED");
});

test("V8 inbox 逾時但其實開咗 → 重放補審計（只一次）", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const { createSalesInvoice } = await import("@/lib/workforce/client");
  await prisma.auditLog.deleteMany({ where: { staffId: a, action: "SALES_INVOICE_CREATED" } }); // 唔好撞開單頻率限制
  const k = key();
  const lines = [{ ...checkup, qty: 3 }];
  // 模擬：workforce 已經開咗（inbox 冇收到回應 → 冇審計）
  const direct = await createSalesInvoice(
    { requestKey: k, clinicCode: "TKW", patientApricotId: P2, patientCode: "TKW900002", conversationId: CONV1, employeeId: null, salesApricotUserId: `${PFX}-apu-a`, practitionerExtId: "mock-pract-TKW-1", ownership: "NONE", lines, payment: null },
    a
  );
  const input = { conversationId: CONV1, staffId: a, requestKey: k, patientApricotId: P2, practitionerExtId: "mock-pract-TKW-1", lines, payment: null };
  const r = await openSalesInvoice(input);
  assert.equal(r.replayed, true);
  assert.equal(r.invoiceId, direct.invoiceId);
  const count = () => prisma.auditLog.count({ where: { action: "SALES_INVOICE_CREATED", entityId: CONV1, meta: { path: ["invoiceId"], equals: direct.invoiceId } } });
  assert.equal(await count(), 1, "補返審計");
  await openSalesInvoice(input);
  assert.equal(await count(), 1, "再重放唔再補");
});

test("V9 連環開單 → 429", async () => {
  const { openSalesInvoice } = await import("./invoice");
  const base = { conversationId: CONV1, staffId: a, patientApricotId: P2, practitionerExtId: "mock-pract-TKW-1", payment: null };
  const recent = await prisma.auditLog.count({ where: { staffId: a, action: "SALES_INVOICE_CREATED", createdAt: { gt: new Date(Date.now() - 600_000) } } });
  for (let i = recent; i < 10; i++) await openSalesInvoice({ ...base, requestKey: key(), lines: [{ ...checkup, qty: 10 + i }] });
  await rejects(openSalesInvoice({ ...base, requestKey: key(), lines: [{ ...checkup, qty: 99 }] }), 429, "TOO_MANY_INVOICES");
});
