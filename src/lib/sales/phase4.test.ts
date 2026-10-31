/**
 * ★ cwi-sales 第 4 期：老闆月結（inbox 側）— 含對抗式測試。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/phase4.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * Y1 CSV 公式注入：= + - @ tab 開頭 → 前面加 '；雙引號 escape
 * Y2 預覽補銷售名；當月 → NOT_ENDED（唔可以結）
 * Y3 冇月結前同步 → 409 廣東話訊息；force 先結；重撳 = already（審計只一次）；重開
 * Y4 報表 CSV：有銷售名、病人編號；冇病人名；BOM；惡意名唔會變公式
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
const PFX = "saly";
const C1 = `${PFX}contact00000000000000001`;
const PID = `${PFX}-p1`;
const EMAILS = ["saly-a@saly.local", "saly-adm@saly.local"];
let a: string;
let adm: string;
const prevMonth = () => {
  const d = new Date(Date.now() + 8 * 3600_000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const nowMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { entity: "SalesMonth", action: { in: ["SALES_MONTH_CLOSED", "SALES_MONTH_REOPENED"] }, staffId: { in: [adm ?? "x"] } } });
  await prisma.contactPatientLink.deleteMany({ where: { contactId: C1 } });
  await prisma.contact.deleteMany({ where: { id: C1 } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  a = (await prisma.staffUser.create({ data: { email: EMAILS[0], name: "=HYPERLINK(\"x\")銷售", role: "STAFF", passwordHash: "x", active: true, isSales: true, salesApricotUserId: `${PFX}-apu` } })).id;
  adm = (await prisma.staffUser.create({ data: { email: EMAILS[1], name: "SALY 老闆", role: "ADMIN", passwordHash: "x", active: true } })).id;
  await prisma.contact.create({ data: { id: C1, clinicId: tkw.id, waId: "85290006101", profileName: "SALY", labels: [] } });
  await prisma.contactPatientLink.create({ data: { contactId: C1, patientApricotId: PID, patientCode: "TKW960001", patientName: "黃秘密SALY", source: "SEARCH" } });
  const { _resetMockInvoicesForTest, _mockInvoiceStoreForTest, createSalesInvoice } = await import("@/lib/workforce/client");
  _resetMockInvoicesForTest();
  await createSalesInvoice(
    { requestKey: "salykey00001", clinicCode: "TKW", patientApricotId: PID, patientCode: "X", conversationId: null, employeeId: null, salesApricotUserId: `${PFX}-apu`, practitionerExtId: "p", ownership: "PROTECTED", lines: [{ feeItemExtId: "mock-fee-TKW-3", qty: 1, up: 39000, discAmt: 0 }], payment: { amt: 10000, methodExtId: "mock-pm-cash" } },
    a
  );
  // mock 單開喺上個月（mock 分類帳按開單月份）
  for (const inv of _mockInvoiceStoreForTest().invoices.values()) inv.createdAt = `${prevMonth()}-15T04:00:00.000Z`;
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

test("Y1 CSV 公式注入", async () => {
  const { csvCell } = await import("./close");
  assert.equal(csvCell("=1+1"), `"'=1+1"`);
  assert.equal(csvCell("+852"), `"'+852"`);
  assert.equal(csvCell("-5"), `"'-5"`);
  assert.equal(csvCell("@SUM(A1)"), `"'@SUM(A1)"`);
  assert.equal(csvCell("\tx"), `"'\tx"`);
  assert.equal(csvCell('say "hi"'), `"say ""hi"""`);
  assert.equal(csvCell(null), `""`);
  assert.equal(csvCell(300), `"300"`);
});

test("Y2 預覽補銷售名；當月唔可以結", async () => {
  const { monthCloseView } = await import("./close");
  const v = await monthCloseView(prevMonth());
  const row = v.rows.find((r) => r.inboxStaffId === a);
  assert.equal(row?.name, '=HYPERLINK("x")銷售');
  assert.equal(row?.payout, 300);
  const cur = await monthCloseView(nowMonth());
  assert.equal(cur.blockers[0]?.code, "NOT_ENDED");
});

test("Y3 冇同步 409；force 結；重撳 already；重開", async () => {
  const { closeMonth, reopenMonth } = await import("./close");
  const { SalesActionError } = await import("./handover");
  const m = prevMonth();
  await assert.rejects(closeMonth(m, false, adm), (e) => e instanceof SalesActionError && e.status === 409 && e.message.includes("月結前同步"));
  await assert.rejects(closeMonth(nowMonth(), true, adm), (e) => e instanceof SalesActionError && e.code === "NOT_ENDED");
  assert.deepEqual(await closeMonth(m, true, adm), { already: false });
  assert.deepEqual(await closeMonth(m, true, adm), { already: true });
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_MONTH_CLOSED", entityId: m, staffId: adm } }), 1, "審計只一次");
  const r = await reopenMonth(m, adm);
  assert.equal(r.reopened, true);
  assert.equal((await reopenMonth(m, adm)).reopened, false, "再重開 = 冇嘢做");
  assert.equal(await prisma.auditLog.count({ where: { action: "SALES_MONTH_REOPENED", entityId: m, staffId: adm } }), 1);
});

test("Y4 報表 CSV", async () => {
  const { reportCsv } = await import("./close");
  const csv = await reportCsv(prevMonth());
  assert.ok(csv.startsWith("﻿"), "BOM（Excel 中文）");
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")銷售"`), "惡意名唔會變公式");
  assert.ok(csv.includes("TKW960001"), "有病人編號");
  assert.ok(!csv.includes("黃秘密SALY"), "冇病人名");
  assert.ok(csv.includes('"300"'));
});
