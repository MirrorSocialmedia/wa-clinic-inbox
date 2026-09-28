/**
 * FX-05 unit test — booking-write worker failed handler（QA-05：attempts guard）
 *
 * 運行：TZ=UTC npx tsx --test src/workers/booking-write.worker.test.ts
 *   （要 DB（wa_p2）+ Redis（本地 6379））
 *
 * 背景：BullMQ `failed` 事件每次 attempt 失敗都觸發。舊 handler 冇 attemptsMade
 * 判斷 → 第一次失敗即 writeState=FAILED → 第 2、3 次 attempt stale-skip
 * （writeState ≠ WRITING）→ createBooking 已成功而 DB update 失敗時：
 * Apricot 有單但 UI 紅字「落單失敗」+〔已人手落單〕可撳 → 重複預約。
 * 修：attempts guard（只處理最終失敗）+ 最終失敗標 UNKNOWN（唔係 FAILED）+ StaffNotice。
 *
 * 直調拆出嘅 onBookingWriteFailed（唔起 BullMQ Worker — redline：unit test only）。
 * T767 完整鏈（mock createBooking 成功 + CONFIRMED update throw → 第 2 次 attempt
 * → CONFIRMED 同 apricotApptId）留 e2e 管線（需要真 queue 重投）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";
import { onBookingWriteFailed } from "./booking-write.worker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureEnv(): void {
  try {
    const env = readFileSync(path.resolve(__dirname, "../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* fail loud downstream */
  }
}
ensureEnv();

const prisma = new PrismaClient();

const BK_ID = "fx05bk00000000000000000001";
const FLOW_TOKEN = "fx05-flow-01";
let clinicId: string;

function mkJob(bookingId: string, attemptsMade: number, attempts?: number) {
  return {
    id: "job-fx05-test",
    data: {
      bookingId,
      actor: { type: "STAFF", staffId: "fx05staff" } as const,
      visitReasonId: "chk",
      visitReasonCode: null,
      triggerMsgId: null,
    },
    attemptsMade,
    opts: attempts !== undefined ? { attempts } : undefined,
  };
}

async function row() {
  return prisma.bookingRequest.findUnique({ where: { id: BK_ID } });
}

async function setWriteState(writeState: string | null, writeError: string | null = null): Promise<void> {
  await prisma.bookingRequest.update({ where: { id: BK_ID }, data: { writeState, writeError } });
}

async function resetRow(): Promise<void> {
  await prisma.bookingRequest.update({
    where: { id: BK_ID },
    data: { status: "PENDING", writeState: "WRITING", writeError: null },
  });
}

async function delNotices(): Promise<void> {
  await prisma.staffNotice.deleteMany({ where: { meta: { path: ["bookingId"], equals: BK_ID } } });
}

before(async () => {
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  await delNotices();
  await prisma.bookingRequest.deleteMany({ where: { id: BK_ID } });
  await prisma.bookingRequest.create({
    data: {
      id: BK_ID,
      conversationId: "fx05conv000000000000000001", // 無 FK — 假 id（notice publish 查唔到 conv = skip）
      clinicId,
      flowToken: FLOW_TOKEN,
      providerApricotId: "mock-pract-tkw-1",
      providerName: "FX05 測試醫生",
      requestedDate: "2026-12-01",
      requestedTime: "10:00",
      status: "PENDING",
      writeState: "WRITING",
    },
  });
});

after(async () => {
  await delNotices();
  await prisma.bookingRequest.deleteMany({ where: { id: BK_ID } });
  await closeRedis();
  await prisma.$disconnect();
});

test("QA-05 核心：非最終失敗（1/3 attempts）→ row 保持 WRITING（唔標 FAILED — 俾 2/3 attempt 續跑）", async () => {
  await resetRow();
  await onBookingWriteFailed(mkJob(BK_ID, 1, 3), new Error("DB blip"));
  const r = await row();
  assert.equal(r!.writeState, "WRITING", "第一次失敗唔應該動 writeState");
  assert.equal(r!.writeError, null);
  const n = await prisma.staffNotice.count({ where: { meta: { path: ["bookingId"], equals: BK_ID } } });
  assert.equal(n, 0, "非最終失敗唔應該發 notice");
});

test("非最終失敗（2/3 attempts）→ 同樣 no-op", async () => {
  await resetRow();
  await onBookingWriteFailed(mkJob(BK_ID, 2, 3), new Error("DB blip 2"));
  const r = await row();
  assert.equal(r!.writeState, "WRITING");
});

test("最終失敗（3/3 attempts）→ UNKNOWN + writeError=job_failed（唔係 FAILED）", async () => {
  await resetRow();
  await onBookingWriteFailed(mkJob(BK_ID, 3, 3), new Error("DB dead"));
  const r = await row();
  assert.equal(r!.writeState, "UNKNOWN", "最終失敗 = 唔知有冇落到 → UNKNOWN");
  assert.equal(r!.writeError, "job_failed");
});

test("最終失敗 → StaffNotice HANDOFF_REQUEST（唔好人手落單，請撳〔重試〕）", async () => {
  await resetRow();
  await onBookingWriteFailed(mkJob(BK_ID, 3, 3), new Error("DB dead"));
  const notice = await prisma.staffNotice.findFirst({
    where: { meta: { path: ["bookingId"], equals: BK_ID }, kind: "HANDOFF_REQUEST" },
  });
  assert.ok(notice, "最終失敗要發 HANDOFF_REQUEST notice");
  assert.match(notice!.title, /未確定 Apricot 有冇落到單/);
  assert.match(notice!.title, /唔好人手落單/);
});

test("opts.attempts 缺省（default 1）→ attemptsMade=1 即最終 → 照處理", async () => {
  await resetRow();
  await onBookingWriteFailed(mkJob(BK_ID, 1, undefined), new Error("x"));
  const r = await row();
  assert.equal(r!.writeState, "UNKNOWN");
});

test("job = null → no-op 唔 throw", async () => {
  await resetRow();
  await onBookingWriteFailed(null, new Error("x"));
  const r = await row();
  assert.equal(r!.writeState, "WRITING");
});

test("row 已 CONFIRMED（並發先確認）→ 最終失敗唔改 + 唔發 notice", async () => {
  await prisma.bookingRequest.update({ where: { id: BK_ID }, data: { status: "CONFIRMED", writeState: null } });
  await delNotices();
  await onBookingWriteFailed(mkJob(BK_ID, 3, 3), new Error("x"));
  const r = await row();
  assert.equal(r!.status, "CONFIRMED");
  assert.equal(r!.writeState, null, "CONFIRMED row 唔應該被 failed handler 碰");
  const n = await prisma.staffNotice.count({ where: { meta: { path: ["bookingId"], equals: BK_ID } } });
  assert.equal(n, 0);
});

test("row 唔係 WRITING（PENDING + FAILED 態）→ 最終失敗唔改（where 條件唔命中）", async () => {
  await setWriteState("FAILED", "SLOT_TAKEN");
  await onBookingWriteFailed(mkJob(BK_ID, 3, 3), new Error("x"));
  const r = await row();
  assert.equal(r!.writeState, "FAILED");
  assert.equal(r!.writeError, "SLOT_TAKEN", "既有 FAILED 狀態唔應該被覆蓋");
});
