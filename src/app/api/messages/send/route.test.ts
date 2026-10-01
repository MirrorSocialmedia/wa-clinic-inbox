/**
 * T772 — FX-16（QA-16/QA-28）：send route follow-up precheck 必須喺 auto-claim **之前**。
 *
 * 舊行為：unassigned 對話首發先 claim，precheck 409/400 之後先回 → 留低「已 claim 冇訊息」
 * （對話無因無故有人負責、queue badge 錯）。
 * 新行為：precheck 失敗（409 NOT_SUGGESTED / 400 NOT_FOUND / 400 WRONG_CONVERSATION）
 *   → assigneeId 仍 null、零 Message、零 AUTO_CLAIM audit。
 *
 * 口徑：node:test 直打 POST handler；真 dev DB；fixture 唯一前綴 + after() 清走。
 * env：CI 有 workflow env；本地 = loadEnvIfMissing() 由 root .env 補。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { POST } from "./route";
import { closeRedis } from "@/lib/queue";
import {
  loadEnvIfMissing,
  sessionCookie,
  jsonReq,
  drainRes,
  readJson,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../qa3b-test-helpers";

const PX = "fx16t772";
let prisma: PrismaClient;
let cookie: string;
let fx: ConvFx;
const taskIds: string[] = [];

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  const staff = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!staff) throw new Error("T772: admin 未 seed");
  cookie = await sessionCookie({
    staffId: staff.id,
    role: "ADMIN",
    name: staff.name,
    email: staff.email,
    clinicId: null,
    scopeType: "ALL",
  });
  fx = await createConvFx(prisma, { prefix: PX, lastInboundAt: new Date() });
  // precheck 409 fixture：status 唔係 SUGGESTED（NOT_SUGGESTED — 冇網絡依賴、確定性 409）
  const t1 = await prisma.followupTask.create({
    data: {
      id: `${PX}-t1-${randomUUID()}`,
      clinicId: fx.clinicId,
      conversationId: fx.convId,
      phoneHashes: [],
      dueAt: new Date(Date.now() + 86_400_000),
      status: "SENT",
    },
  });
  taskIds.push(t1.id);
});

after(async () => {
  if (prisma) {
    await cleanupFx(prisma, fx, { followupTaskIds: taskIds }).catch(() => {});
    // queue.ts 的 sharedRedis（BullMQ queues 共用）唔 close 會 hold 住 event loop → test process hang（outbound.worker.test 同口徑）
    await closeRedis().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
});

async function expectNoClaim() {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: fx.convId } });
  assert.equal(conv.assigneeId, null, "assigneeId 必須仍 null（T772 核心錨點）");
  const n = await prisma.message.count({ where: { conversationId: fx.convId } });
  assert.equal(n, 0, "precheck 失敗唔可以留低 Message");
  const audits = await prisma.auditLog.count({ where: { entityId: fx.convId, action: "AUTO_CLAIM" } });
  assert.equal(audits, 0, "唔可以留低 AUTO_CLAIM audit");
}

test("T772a — precheck 409（NOT_SUGGESTED）→ 未 claim", async () => {
  const res = await POST(
    jsonReq("/api/messages/send", {
      conversationId: fx.convId,
      body: "T772 測試訊息",
      followupTaskId: taskIds[0],
      source: "typed",
    }, cookie),
    { params: Promise.resolve({}) }
  );
  const body = await readJson<{ error?: string; reason?: string }>(res);
  await drainRes(res);
  assert.equal(res.status, 409, `預期 409，得 ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "FOLLOWUP_NOT_SENDABLE");
  assert.equal(body.reason, "NOT_SUGGESTED");
  await expectNoClaim();
});

test("T772b — precheck 400（WRONG_CONVERSATION：task 喺另一條對話）→ 未 claim", async () => {
  const fx2 = await createConvFx(prisma, { prefix: `${PX}b`, lastInboundAt: new Date() });
  let t2id = "";
  try {
    const t2 = await prisma.followupTask.create({
      data: {
        id: `${PX}b-t-${randomUUID()}`,
        clinicId: fx2.clinicId,
        conversationId: fx2.convId, // task 屬於另一條對話
        phoneHashes: [],
        dueAt: new Date(Date.now() + 86_400_000),
        status: "SUGGESTED",
      },
    });
    t2id = t2.id;
    const res = await POST(
      jsonReq("/api/messages/send", {
        conversationId: fx.convId, // 喺呢條對話發
        body: "T772b 測試訊息",
        followupTaskId: t2.id,
        source: "typed",
      }, cookie),
      { params: Promise.resolve({}) }
    );
    const body = await readJson<{ error?: string; reason?: string }>(res);
    await drainRes(res);
    assert.equal(res.status, 400, `預期 400，得 ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "invalid followupTaskId"); // WRONG_CONVERSATION/NOT_FOUND → 同一 400 code（route 層）
    await expectNoClaim();
  } finally {
    // t2 屬於 fx2 — 先刪 task（FK）再清 conv（main after() 另清 fx + taskIds）
    await prisma.followupTask.deleteMany({ where: { id: t2id } }).catch(() => {});
    await cleanupFx(prisma, fx2, {}).catch(() => {});
  }
});

test("T772c — precheck 400（NOT_FOUND：task id 唔存在）→ 未 claim", async () => {
  const res = await POST(
    jsonReq("/api/messages/send", {
      conversationId: fx.convId,
      body: "T772c 測試訊息",
      followupTaskId: `${PX}-ghost-${randomUUID()}`,
      source: "typed",
    }, cookie),
    { params: Promise.resolve({}) }
  );
  const body = await readJson<{ error?: string; reason?: string }>(res);
  await drainRes(res);
  assert.equal(res.status, 400, `預期 400，得 ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "invalid followupTaskId"); // NOT_FOUND → 同一 400 code（route 層）
  await expectNoClaim();
});
