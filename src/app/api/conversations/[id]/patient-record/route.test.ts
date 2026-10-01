/**
 * ★ cwi-ux UX-07 T-UX07i（API 級）：病人記錄「最近到診分店／主診醫生」
 *
 * 運行：npx tsx --test "src/app/api/conversations/[id]/patient-record/route.test.ts"
 *   （要 DB 15432 + WORKFORCE_MOCK=1 — .env）
 *
 * 口徑：
 *   - 有真到診 → visitStats 有值（latestVisit + primaryDoctor，由 mock Apricot 到診記錄計）
 *   - 只爽約（-3）/ 無記錄 → visitStats = null（UI 唔顯示 — spec「冇記錄唔顯示」）
 *   - 無病人（未釘住 + 配對唔到）→ patient = null + visitStats = null
 *   - summary=1 輕量模式 visitStats 照有（預約分店下拉預設值要讀佢）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { GET } from "./route";
import {
  loadEnvIfMissing,
  sessionCookie,
  getReq,
  drainRes,
  readJson,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../../../messages/qa3b-test-helpers";
import { windowCutoff } from "@/lib/visit-stats";

const PX = "fxux07i";
let prisma: PrismaClient;
let adminCookie: string;
const convs: ConvFx[] = [];

type Stats = {
  totalVisits12m: number;
  primaryDoctor: { providerCode: string; providerName: string | null; count: number; lastClinicCode: string | null; lastVisitDate: string } | null;
  latestVisit: { date: string; clinicCode: string; providerName: string | null } | null;
} | null;

async function pinConv(convId: string, patientApricotId: string): Promise<void> {
  await prisma.conversation.update({ where: { id: convId }, data: { pinnedPatientApricotId: patientApricotId } });
}

async function fetchRecord(convId: string, summary: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(
    getReq(`/api/conversations/${convId}/patient-record${summary ? "?summary=1" : ""}`, adminCookie),
    { params: Promise.resolve({ id: convId }) } as never
  );
  const body = await readJson(res);
  await drainRes(res);
  return { status: res.status, body };
}

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  const admin = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!admin) throw new Error("seed 要有 admin@wa-clinic.local");
  adminCookie = await sessionCookie({
    staffId: admin.id,
    role: "ADMIN",
    name: admin.name,
    email: admin.email,
    clinicId: null,
    scopeType: "ALL",
  });
});

after(async () => {
  for (const fx of convs) await cleanupFx(prisma, fx).catch(() => {});
  await prisma.$disconnect().catch(() => {});
  // 保險：route import 鏈可能拉 queue.ts sharedRedis
  const { closeRedis } = await import("@/lib/queue");
  await closeRedis().catch(() => {});
});

test("T-UX07i: 有真到診（cp-std-001）→ visitStats 有值（latestVisit + primaryDoctor）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await pinConv(fx.convId, "cp-std-001"); // mock fixture：1 次到診 2026-09-14 TY DR1（status 4）

  const { status, body } = await fetchRecord(fx.convId, false);
  assert.equal(status, 200);
  const patient = body.patient as { patientApricotId?: string; source?: string } | null;
  assert.equal(patient?.patientApricotId, "cp-std-001");
  assert.equal(patient?.source, "pinned");

  const stats = body.visitStats as Stats;
  const inWindow = "2026-09-14" >= windowCutoff(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }));
  if (!inWindow) {
    assert.equal(stats, null, "fixture 日期已超 12 個月窗 → null");
    return;
  }
  assert.ok(stats, "visitStats 唔係 null");
  assert.equal(stats.totalVisits12m, 1);
  assert.equal(stats.latestVisit?.date, "2026-09-14");
  assert.equal(stats.latestVisit?.clinicCode, "TY");
  assert.equal(stats.primaryDoctor?.providerCode, "DR1");
  assert.equal(stats.primaryDoctor?.count, 1);
  assert.equal(stats.primaryDoctor?.lastClinicCode, "TY");
});

test("T-UX07i: 只爽約（cp-no-003 status -3）→ visitStats null（冇真到診 = 唔顯示）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await pinConv(fx.convId, "cp-no-003");

  const { status, body } = await fetchRecord(fx.convId, false);
  assert.equal(status, 200);
  assert.equal((body.patient as { patientApricotId?: string } | null)?.patientApricotId, "cp-no-003");
  assert.equal(body.visitStats, null, "爽約唔係到診 → null");
});

test("T-UX07i: 無病人（未釘住 + 配對唔到）→ patient null + visitStats null", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  // createConvFx 嘅 contact waId = 隨機 — mock patient-lookup 配唔到 → patient null

  const { status, body } = await fetchRecord(fx.convId, false);
  assert.equal(status, 200);
  assert.equal(body.patient, null);
  assert.equal(body.visitStats, null);
});

test("T-UX07i: summary=1 輕量模式 visitStats 照有（預約分店下拉預設值讀呢度）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await pinConv(fx.convId, "cp-std-001");

  const { status, body } = await fetchRecord(fx.convId, true);
  assert.equal(status, 200);
  const stats = body.visitStats as Stats;
  const inWindow = "2026-09-14" >= windowCutoff(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }));
  if (inWindow) {
    assert.ok(stats, "summary 模式 visitStats 唔係 null");
    assert.equal(stats.primaryDoctor?.providerCode, "DR1");
  } else {
    assert.equal(stats, null);
  }
  // summary 語義保留：visits 最多 2 行
  assert.ok(Array.isArray(body.visits) && body.visits.length <= 2);
});
