/**
 * FX-12 unit test — stuck-sweep：booking WRITING 丟失 sweep（QA-12）
 *
 * 運行：TZ=UTC npx tsx --test src/lib/ops/stuck-sweep.test.ts
 *   （要 DB（wa_p2）+ Redis（本地 6379）— booking-write queue job 偵測真跑）
 *
 * 背景：confirm-core claim 只接受 null/FAILED/UNKNOWN（WRITING 唔會再 claim）— job 一旦
 * 丟失（Redis 重啟 job 清咗 / 手動誤刪）→ 行永久 WRITING → 卡片永遠「落單處理緊」。
 * 修：stuck-sweep 加 booking 段 — `writeState=WRITING AND writeAttemptAt < now-15min`
 * 且 queue 冇該 booking 嘅 active job（jobId 前綴 `bw-<id>-`）→ UNKNOWN + job_lost_sweep
 * （唔係 FAILED — 唔知有冇落到）。
 *
 * 只測 sweepStuckBookingWrites（獨立函數）— 唔觸 ai/media queue（共享 6379 同 Phase 1 重現）。
 * dummy job 用 `bw-<fixture-id>-0-qa-dummy`（同真 booking cuid 零碰撞）；after() 移除。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis, bookingWriteQueue } from "@/lib/queue";
import { sweepStuckBookingWrites } from "./stuck-sweep";

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

const BK_LOST = "fx12bk0000000000000000001"; // 主測：job 丟失
const BK_FRESH = "fx12bk0000000000000000002"; // 未到 15min
const BK_ACTIVE = "fx12bk0000000000000000003"; // queue 有 active job
const BK_FAILED = "fx12bk0000000000000000004"; // FAILED 態（唔係 WRITING）
const BK_CONFIRMED = "fx12bk0000000000000000005"; // CONFIRMED（異常態）
const IDS = [BK_LOST, BK_FRESH, BK_ACTIVE, BK_FAILED, BK_CONFIRMED];

let clinicId: string;

function mkData(id: string, writeState: string | null, status: string, minsAgo: number | null, writeError: string | null = null) {
  return {
    id,
    conversationId: `fx12conv-${id.slice(-4)}`,
    clinicId,
    flowToken: `fx12-flow-${id.slice(-4)}`,
    providerApricotId: "mock-pract-tkw-1",
    providerName: "FX12 測試醫生",
    requestedDate: "2026-12-02",
    requestedTime: "11:00",
    status: status as never,
    writeState,
    writeAttemptAt: minsAgo === null ? null : new Date(Date.now() - minsAgo * 60_000),
    writeError,
  };
}

const DUMMY_JOB_ID = `bw-${BK_ACTIVE}-0-qa-dummy`;

async function resetRow(id: string, writeState: string | null, status: string, minsAgo: number | null, writeError: string | null = null): Promise<void> {
  await prisma.bookingRequest.deleteMany({ where: { id } });
  await prisma.bookingRequest.create({ data: mkData(id, writeState, status, minsAgo, writeError) });
}

before(async () => {
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  await prisma.bookingRequest.deleteMany({ where: { id: { in: IDS } } });
  await resetRow(BK_LOST, "WRITING", "PENDING", 16);
  await resetRow(BK_FRESH, "WRITING", "PENDING", 5);
  await resetRow(BK_ACTIVE, "WRITING", "PENDING", 16);
  await resetRow(BK_FAILED, "FAILED", "PENDING", 16, "SLOT_TAKEN");
  await resetRow(BK_CONFIRMED, "WRITING", "CONFIRMED", 16);
});

after(async () => {
  // dummy job 清走（共享 6379 — 唔留殘留 job 俾 Phase 1 worker 撿）
  try {
    const j = await bookingWriteQueue.getJob(DUMMY_JOB_ID);
    if (j) await j.remove();
  } catch {
    /* already gone */
  }
  await prisma.bookingRequest.deleteMany({ where: { id: { in: IDS } } });
  await closeRedis();
  await prisma.$disconnect();
});

test("job 丟失：WRITING 16min + queue 無 job → UNKNOWN + job_lost_sweep（唔係 FAILED）", async () => {
  const r = await sweepStuckBookingWrites();
  const row = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK_LOST } });
  assert.equal(row.writeState, "UNKNOWN", "job 丟失 = 唔知有冇落到 → UNKNOWN");
  assert.equal(row.writeError, "job_lost_sweep");
  assert.equal(row.status, "PENDING", "status 唔應該被動");
  assert.ok(r.bookingSwept >= 1, `應該掃到 >=1（實際 ${r.bookingSwept}）`);
});

test("未到 15min（5min）→ 唔掃（row 保持 WRITING）", async () => {
  const r = await sweepStuckBookingWrites();
  const row = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK_FRESH } });
  assert.equal(row.writeState, "WRITING", "5min 未到 15min cutoff — 唔應該掃");
  void r;
});

test("queue 有 active job（waiting）→ 唔係丟，唔掃；job 移除後 → 掃", async () => {
  // （Test 1 嘅 sweep 已掃咗呢行 — 重新 reset 做獨立前置）
  await resetRow(BK_ACTIVE, "WRITING", "PENDING", 16);
  // 放一個 active（waiting）dummy job 入 booking-write queue
  await bookingWriteQueue.add(
    "create",
    { bookingId: BK_ACTIVE, actor: { type: "STAFF", staffId: "fx12staff" }, visitReasonId: "chk", visitReasonCode: null, triggerMsgId: null },
    { jobId: DUMMY_JOB_ID }
  );
  try {
    const r1 = await sweepStuckBookingWrites();
    const row1 = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK_ACTIVE } });
    assert.equal(row1.writeState, "WRITING", "queue 有 active job — 唔應該掃");

    // 移除 job → 下輪 sweep → 掃
    const j = await bookingWriteQueue.getJob(DUMMY_JOB_ID);
    assert.ok(j, "dummy job 要喺 queue");
    await j.remove();
    const r2 = await sweepStuckBookingWrites();
    const row2 = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK_ACTIVE } });
    assert.equal(row2.writeState, "UNKNOWN", "job 移除後 = 丟失 → UNKNOWN");
    assert.equal(row2.writeError, "job_lost_sweep");
    void r1;
    void r2;
  } finally {
    try {
      const j2 = await bookingWriteQueue.getJob(DUMMY_JOB_ID);
      if (j2) await j2.remove();
    } catch {
      /* already gone */
    }
  }
});

test("FAILED 態（唔係 WRITING）→ 唔掃", async () => {
  await sweepStuckBookingWrites();
  const row = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK_FAILED } });
  assert.equal(row.writeState, "FAILED", "FAILED 係確定性失敗（staff 可重試）— 唔應該被 sweep 動");
  assert.equal(row.writeError, "SLOT_TAKEN");
});

test("CONFIRMED（異常：WRITING 殘留）→ 唔掃（query 限 PENDING）", async () => {
  await sweepStuckBookingWrites();
  const row = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK_CONFIRMED } });
  assert.equal(row.writeState, "WRITING", "CONFIRMED 行唔應該被 sweep 動（query 限 PENDING）");
});
