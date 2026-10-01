/**
 * T777 — FX-27（QA-27）：retry 三件事：
 * a) 訊息 age > 24h（createdAt < now-24h）→ 409 TOO_OLD（UI 叫員工重新打）
 * b) 24h 窗口檢查媒體同 text 一樣（舊 code 只查 text — 媒體 FAILED 過窗照重試 = 錯）
 * c) retry 成功時清 waMediaId（worker 見 null → 重新上載；唔保留 Meta 30 日 token 舊值）
 *
 * 口徑：node:test 直打 POST handler（params = Promise<{id}>）；fixture 唯一前綴 + after() 清走。
 *  200 支路會入真 Redis queue（jobId = messageId）→ cleanup best-effort remove（dev worker 可能已撳走）。
 *  waMediaId 斷言用「≠ 原值」— 本地 worker 可能已 re-upload 出新 mock id（都係正確結果）；
 *  CI 無 worker → 仍係 null（也正確）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { POST } from "./route";
import { closeRedis } from "@/lib/queue";
import {
  REPO_ROOT,
  loadEnvIfMissing,
  sessionCookie,
  jsonReq,
  drainRes,
  readJson,
  createConvFx,
  createOutMsgFx,
  cleanupFx,
  type ConvFx,
} from "../../qa3b-test-helpers";

const PX = "fx27t777";
let prisma: PrismaClient;
let cookie: string;
let fx: ConvFx; // 窗口開緊（lastInboundAt = now）
let fxClosed: ConvFx; // 窗口已過（lastInboundAt = 25h 前）
const msgIds: string[] = [];

const H = 3600_000;

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  const staff = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!staff) throw new Error("T777: admin 未 seed");
  cookie = await sessionCookie({
    staffId: staff.id,
    role: "ADMIN",
    name: staff.name,
    email: staff.email,
    clinicId: null,
    scopeType: "ALL",
  });
  fx = await createConvFx(prisma, { prefix: PX, lastInboundAt: new Date() });
  fxClosed = await createConvFx(prisma, {
    prefix: `${PX}c`,
    lastInboundAt: new Date(Date.now() - 25 * H),
  });
});

after(async () => {
  if (prisma) {
    await cleanupFx(prisma, fx, { messageIds: msgIds }).catch(() => {});
    await cleanupFx(prisma, fxClosed).catch(() => {});
    // queue.ts 的 sharedRedis（BullMQ queues 共用）唔 close 會 hold 住 event loop → test process hang（outbound.worker.test 同口徑）
    await closeRedis().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
});

async function retry(messageId: string): Promise<{ status: number; body: { error?: string } }> {
  const res = await POST(jsonReq(`/api/messages/${messageId}/retry`, {}, cookie), {
    params: Promise.resolve({ id: messageId }),
  });
  const body = await readJson<{ error?: string }>(res);
  await drainRes(res);
  return { status: res.status, body };
}

async function bestEffortRemoveJob(messageId: string): Promise<void> {
  try {
    const { outboundQueue } = await import("@/lib/queue");
    const job = await outboundQueue.getJob(messageId);
    if (job) await job.remove().catch(() => {});
  } catch {
    /* worker 已撳走 */
  }
}

test("T777a — text FAILED + age 25h → 409 TOO_OLD（窗口開緊都擋）", async () => {
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "text",
    body: "T777 舊 text",
    createdAt: new Date(Date.now() - 25 * H),
  });
  msgIds.push(m.messageId);
  const { status, body } = await retry(m.messageId);
  assert.equal(status, 409, `預期 409，得 ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "TOO_OLD");
  const row = await prisma.message.findUniqueOrThrow({ where: { id: m.messageId } });
  assert.equal(row.status, "FAILED", "409 唔好改動 row");
});

test("T777b — document FAILED + age 25h → 409 TOO_OLD（媒體同 text 一樣有 age 硬頂）", async () => {
  const file = `fx27-${randomUUID()}.pdf`;
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "document",
    status: "FAILED",
    mediaKey: file,
    mediaPath: `${REPO_ROOT}/.dev/does-not-matter-${file}`,
    createdAt: new Date(Date.now() - 25 * H),
  });
  msgIds.push(m.messageId);
  const { status, body } = await retry(m.messageId);
  assert.equal(status, 409, `預期 409，得 ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "TOO_OLD");
});

test("T777c — document FAILED + age 1h + 窗口已過（25h 前入站）→ 422 WINDOW_CLOSED（媒體同 text 一樣查窗口）", async () => {
  const file = `fx27c-${randomUUID()}.pdf`;
  const m = await createOutMsgFx(prisma, {
    ...fxClosed,
    prefix: `${PX}c`,
    type: "document",
    status: "FAILED",
    mediaKey: file,
    mediaPath: `${REPO_ROOT}/.dev/does-not-matter-${file}`,
    createdAt: new Date(Date.now() - 1 * H),
  });
  msgIds.push(m.messageId);
  const { status, body } = await retry(m.messageId);
  assert.equal(status, 422, `預期 422（舊 code 呢度唔查 → 直接 200 入 queue = bug），得 ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "WINDOW_CLOSED");
});

test("T777d — text FAILED + age 1h + 窗口開 → 200（regression：正常 retry 照行）", async () => {
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "text",
    body: "T777 retry text",
    createdAt: new Date(Date.now() - 1 * H),
  });
  msgIds.push(m.messageId);
  const { status, body } = await retry(m.messageId);
  assert.equal(status, 200, `預期 200，得 ${status}: ${JSON.stringify(body)}`);
  const row = await prisma.message.findUniqueOrThrow({ where: { id: m.messageId } });
  // dev worker 可能已撳 job → QUEUED/SENDING/SENT 都算「已離 FAILED」
  assert.ok(["QUEUED", "SENDING", "SENT"].includes(row.status), `狀態要離 FAILED，得 ${row.status}`);
  await bestEffortRemoveJob(m.messageId);
});

test("T777e — document FAILED 帶 waMediaId + age 1h → 200 且 waMediaId 被清（worker re-upload）", async () => {
  // 真檔（本地 worker 若撳 job 會真讀檔 re-upload；mock 模式 upload = fake id）
  const dir = `${REPO_ROOT}/.dev/media-qa37-retry`;
  mkdirSync(dir, { recursive: true });
  const file = `fx27e-${randomUUID()}.pdf`;
  const diskPath = `${dir}/${file}`;
  writeFileSync(diskPath, Buffer.from("%PDF-1.4 T777e"));
  const ORIG = "gmedia-orig-t777-123";
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "document",
    status: "FAILED",
    mediaKey: file,
    mediaPath: diskPath,
    waMediaId: ORIG,
    createdAt: new Date(Date.now() - 1 * H),
  });
  msgIds.push(m.messageId);
  try {
    const { status, body } = await retry(m.messageId);
    assert.equal(status, 200, `預期 200，得 ${status}: ${JSON.stringify(body)}`);
    const row = await prisma.message.findUniqueOrThrow({ where: { id: m.messageId } });
    assert.ok(["QUEUED", "SENDING", "SENT"].includes(row.status), `狀態要離 FAILED，得 ${row.status}`);
    // ★ FX-27 核心：舊 waMediaId 唔可以保留（= 沿用 Meta 30 日 token）
    //   正確結果 = null（CI 無 worker）或 worker 新上載 id（本地）— 兩者都 ≠ ORIG
    assert.notEqual(row.waMediaId, ORIG, "retry 必須清 waMediaId（worker 會 re-upload）");
    assert.ok(row.waMediaId === null || typeof row.waMediaId === "string");
  } finally {
    if (existsSync(diskPath)) unlinkSync(diskPath);
  }
});

test("T777f — control：waMessageId 已設（unknown/sending 殘留）→ 409 NOT_RETRYABLE（行為唔變）", async () => {
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "text",
    body: "T777 control",
    status: "FAILED",
    waMessageId: `wamid.T777ctl${randomUUID().slice(0, 8)}`,
    createdAt: new Date(Date.now() - 1 * H),
  });
  msgIds.push(m.messageId);
  const { status, body } = await retry(m.messageId);
  assert.equal(status, 409, `預期 409，得 ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "NOT_RETRYABLE");
});
