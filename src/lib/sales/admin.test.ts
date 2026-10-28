/**
 * ★ cwi-sales-20261028：老闆管理病人歸屬（指派／轉移／放返公海）+ 設定預設值。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/admin.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * A1 指派：唔係銷售 → 400；BOUND 成功 + 審計 + 列表
 * A2 已有其他銷售 → 指派 409；轉移 → 新銷售
 * A3 放返公海 → POOL，lastSalesStaffId 保留
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
const EMAILS = ["sala-a@sala.local", "sala-b@sala.local", "sala-desk@sala.local", "sala-adm@sala.local"];
let a: string;
let b: string;
let desk: string;
let adm: string;

async function cleanup(): Promise<void> {
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: PID } });
  await prisma.auditLog.deleteMany({ where: { entity: "SalesOwnership", entityId: PID } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw);
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId: tkw.id } }, ...extra } })).id;
  a = await mk(EMAILS[0], "SALA 銷售A", { isSales: true });
  b = await mk(EMAILS[1], "SALA 銷售B", { isSales: true });
  desk = await mk(EMAILS[2], "SALA 前台");
  adm = await mk(EMAILS[3], "SALA 老闆", { role: "ADMIN" });
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
