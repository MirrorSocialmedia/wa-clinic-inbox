/**
 * ★ cwi-ux UX-07 T-UX07a（worker 層）/ T-UX07c 邊界：booking-write worker 跨分店寫入
 *
 * 運行：npx tsx --test src/workers/booking-write-ux07.test.ts（要 DB 15432 + Redis 6379 + WORKFORCE_MOCK=1）
 *   直調 processBookingWriteJob（唔起 BullMQ — redline：unit test only，同 FX-05 口徑）
 *
 * 口徑（spec §7.5 T-UX07a + §7.3 確認訊息）：
 *   - 跨店行（clinicId=TKW 對話店、bookingClinicId=目標店）→ createBooking clinicCode = **目標店**
 *     （mock booked-store 斷言 clinicCode — 唔係對話店）
 *   - 確認訊息（STAFF 窗口內自動）= 目標店店名 + 地址；訊息掛喺**對話**（TKW）→ 由 TKW 號碼發出
 *   - 舊行（bookingClinicId=null）→ clinicCode = 對話店（零改動回歸）
 *   - workforce 拒（WORKFORCE_MOCK_FAIL）→ 最終失敗 = writeState UNKNOWN + writeError（清楚訊息，唔係 500/crash）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { processBookingWriteJob, onBookingWriteFailed } from "./booking-write.worker";
import { type BookingWriteJobData } from "@/lib/queue";
import { MOCK_BOOKED_FILE } from "@/lib/workforce/client";
import {
  loadEnvIfMissing,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../app/api/messages/qa3b-test-helpers";

const PX = "fxux07w";
const DATE = "2026-12-01";
const START = "10:00";
let prisma: PrismaClient;
let tkw: { id: string; code: string; name: string };
let targetClinic: { id: string; code: string; name: string };
let adminStaffId: string;
const convs: ConvFx[] = [];
const bookingIds: string[] = [];

function fakeJob(bookingId: string, attemptsMade = 1) {
  const data: BookingWriteJobData = {
    bookingId,
    actor: { type: "STAFF", staffId: adminStaffId },
    visitReasonId: "vr-0010",
    visitReasonCode: "0010",
    triggerMsgId: null,
  };
  return { id: `job-ux07-${bookingId}`, data, attemptsMade, opts: { attempts: 3 } } as never;
}

function bookedStore(): Array<Record<string, unknown>> {
  try {
    const raw = JSON.parse(readFileSync(path.resolve(process.cwd(), MOCK_BOOKED_FILE), "utf8"));
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  const t = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!t) throw new Error("seed 要有 TKW");
  tkw = { id: t.id, code: t.code, name: t.name };
  const admin = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!admin) throw new Error("seed 要有 admin");
  adminStaffId = admin.id;
  // 目標店 fixture（店名 + 地址唯一 — 確認訊息斷言零誤撞）
  const c = await prisma.clinic.create({
    data: {
      code: `UX07T${Date.now() % 100000}`,
      name: "UX07 測試分店（跨店目標）",
      waPhoneNumberId: `ux07t-${Date.now()}`,
      waDisplayNumber: "60123456789",
      greetingConfig: { address: "UX07 測試地址 123 號" },
    },
  });
  targetClinic = { id: c.id, code: c.code, name: c.name };
});

after(async () => {
  for (const fx of convs) await cleanupFx(prisma, fx).catch(() => {});
  if (prisma) {
    await prisma.bookingRequest.deleteMany({ where: { id: { in: bookingIds } } }).catch(() => {});
    for (const id of bookingIds) await prisma.staffNotice.deleteMany({ where: { meta: { path: ["bookingId"], equals: id } } }).catch(() => {});
    if (targetClinic) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: bookingIds } } }).catch(() => {});
      await prisma.clinic.deleteMany({ where: { id: targetClinic.id } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
    const { closeRedis } = await import("@/lib/queue");
    await closeRedis().catch(() => {});
  }
});

async function mkPendingBooking(convId: string, bookingClinicId: string | null, id: string): Promise<string> {
  const row = await prisma.bookingRequest.create({
    data: {
      id,
      conversationId: convId,
      clinicId: tkw.id,
      bookingClinicId,
      flowToken: `ux07w-${id}`,
      providerApricotId: "mock-pract-tkw-1",
      providerName: "陳明軒（主理）",
      requestedDate: DATE,
      requestedTime: START,
      status: "PENDING",
      writeState: "WRITING", // worker 條件 guard（同 enqueue 後狀態）
    },
  });
  bookingIds.push(row.id);
  return row.id;
}

test("T-UX07a（worker）：跨店行 → createBooking clinicCode = 目標店（唔係對話店）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  const bid = await mkPendingBooking(fx.convId, targetClinic.id, `ux07w-cross-${Date.now()}`);

  await processBookingWriteJob(fakeJob(bid));

  const row = await prisma.bookingRequest.findUnique({ where: { id: bid } });
  assert.ok(row, "row 存在");
  assert.equal(row.status, "CONFIRMED", "worker 寫入成功");
  assert.ok(row.apricotApptId?.startsWith("mock-appt-"), "mock Apricot 單號");
  const entry = bookedStore().find((e) => e.apricotApptId === row.apricotApptId);
  assert.ok(entry, "mock booked-store 有呢單");
  assert.equal(entry.clinicCode, targetClinic.code, "Apricot 寫入 clinicCode = 預約目標店（T-UX07a）");
  assert.notEqual(entry.clinicCode, tkw.code, "唔係對話店");
});

test("T-UX07a（worker）：確認訊息 = 目標店店名 + 地址；掛喺對話（TKW 號碼發）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  const bid = await mkPendingBooking(fx.convId, targetClinic.id, `ux07w-msg-${Date.now()}`);

  await processBookingWriteJob(fakeJob(bid));

  const msg = await prisma.message.findFirst({
    where: { conversationId: fx.convId, direction: "OUT", type: "text" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(msg, "確認訊息 Message 行存在");
  assert.ok(msg.body, "message body 存在");
  assert.ok(msg.body.includes(targetClinic.name), `確認訊息帶目標店店名：${msg.body}`);
  assert.ok(msg.body.includes("地址：UX07 測試地址 123 號"), `確認訊息帶目標店地址：${msg.body}`);
  assert.equal(msg.conversationId, fx.convId, "訊息掛喺 TKW 對話 → 由 TKW 號碼發出（對話唔跨店）");
});

test("T-UX07f（worker）：舊行（bookingClinicId=null）→ clinicCode = 對話店（零改動）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  const bid = await mkPendingBooking(fx.convId, null, `ux07w-legacy-${Date.now()}`);

  await processBookingWriteJob(fakeJob(bid));

  const row = await prisma.bookingRequest.findUnique({ where: { id: bid } });
  assert.ok(row, "row 存在");
  assert.equal(row.status, "CONFIRMED");
  const entry = bookedStore().find((e) => e.apricotApptId === row.apricotApptId);
  assert.ok(entry);
  assert.equal(entry.clinicCode, tkw.code, "舊預約 = 對話店（零改動回歸）");
});

test("T-UX07c 邊界（worker）：workforce 500 → UNKNOWN + writeError + HANDOFF notice（清楚狀態，唔係 500/crash）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  const bid = await mkPendingBooking(fx.convId, targetClinic.id, `ux07w-fail-${Date.now()}`);

  const prevFail = process.env.WORKFORCE_MOCK_FAIL;
  process.env.WORKFORCE_MOCK_FAIL = "1";
  try {
    // 500 = 結果未知（production 同 mock 同一口徑：唔可斷言「冇寫到」）
    await processBookingWriteJob(fakeJob(bid, 1));
  } finally {
    if (prevFail === undefined) delete process.env.WORKFORCE_MOCK_FAIL;
    else process.env.WORKFORCE_MOCK_FAIL = prevFail;
  }
  const row = await prisma.bookingRequest.findUnique({ where: { id: bid } });
  assert.ok(row, "row 存在");
  assert.equal(row.status, "PENDING", "唔係 CONFIRMED（未確定寫到 Apricot）");
  assert.equal(row.writeState, "UNKNOWN", "500 = 結果未知（staff 卡得見「未確定」+ 重試 — 唔係 500/crash）");
  assert.ok(row.writeError && row.writeError.length > 0, `writeError 有訊息：${row.writeError}`);
  const notice = await prisma.staffNotice.findFirst({ where: { meta: { path: ["bookingId"], equals: bid }, kind: "HANDOFF_REQUEST" } });
  assert.ok(notice, "HANDOFF notice 提醒 staff 唔好人手落單");
});

test("T-UX07c 邊界（worker）：非確定性最終失敗（DB 死）→ UNKNOWN + writeError（防 Apricot 有單而 UI 誤報）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  const bid = await mkPendingBooking(fx.convId, targetClinic.id, `ux07w-unknown-${Date.now()}`);

  // production 鏈：BullMQ failed 事件（非確定性 throw，最終 attempt）→ onBookingWriteFailed → UNKNOWN
  await onBookingWriteFailed(fakeJob(bid, 3), new Error("DB dead"));
  const row = await prisma.bookingRequest.findUnique({ where: { id: bid } });
  assert.ok(row, "row 存在");
  assert.equal(row.writeState, "UNKNOWN", "最終非確定性失敗 = UNKNOWN（唔係 FAILED — Apricot 可能有單）");
  assert.ok(row.writeError && row.writeError.length > 0, `writeError 有訊息：${row.writeError}`);
});
