/**
 * FX-09 unit test — outbound worker：claim 後 Graph 前出錯唔准變 UNKNOWN（QA-09）
 *
 * 運行：TZ=UTC npx tsx --test src/workers/outbound.worker.test.ts
 *   （要 DB（wa_p2）+ Redis（本地 6379）— publishConvEvent / drainPendingStatuses 真跑）
 *
 * 背景：claim 做咗 SENDING 之後、Graph 之前嘅錯誤（conv/clinic/contact 查詢 throw、
 * acquireToken 250ms wait timeout、DB blip）舊版全部 uncaught → job fail → 下次
 * attempt claim miss（SENDING + 無 wamid）→ 誤標 UNKNOWN（「發咗未知道 — 禁重發」）。
 * 但 Graph 根本未調用 = 肯定未發 → 應該正常重試。
 * 修（方案 B）：graphCallStarted flag — Graph 前嘅錯誤 → 非最終還原 QUEUED 重試 /
 * 最終 FAILED（肯定未發）。graphCallStarted=true 之後 = 原有語義（TimeoutError→UNKNOWN 等）。
 *
 * 測試用 deps 注入（OutboundSendDeps）模擬 acquireToken throw / Graph 調用計數 —
 * 直調 runOutboundSend（唔起 BullMQ Worker — redline：unit test only）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";
import {
  runOutboundSend,
  realOutboundDeps,
  type OutboundJobLike,
  type OutboundSendDeps,
  type OutboundJobData,
} from "./outbound.worker";

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

const CLINIC_CODE = "TKW";
const CONTACT_ID = "fx09contact00000000000001";
const CONV_ID = "fx09conv0000000000000001";
const MSG_A = "fx09msg00000000000000000a"; // T769：acquireToken throw 一次
const MSG_B = "fx09msg00000000000000000b"; // conv missing（pre-Graph 重試 + final FAILED）
const MSG_C = "fx09msg00000000000000000c"; // post-Graph TimeoutError → UNKNOWN（原語義）
const MSG_D = "fx09msg00000000000000000d"; // post-Graph transient → QUEUED 重試 → SENT（原語義）

let clinicId: string;

function mkJob(messageId: string, attemptsMade: number, attempts = 3): OutboundJobLike {
  return { id: "job-fx09-test", data: { messageId } as OutboundJobData, attemptsMade, opts: { attempts } };
}

interface CallCounter {
  inc: () => void;
  readonly count: number;
}
function countCalls(): CallCounter {
  let n = 0;
  return {
    inc: () => {
      n += 1;
    },
    get count() {
      return n;
    },
  };
}

async function createFixtureMessage(id: string, conversationId: string): Promise<void> {
  await prisma.message.create({
    data: {
      id,
      conversationId,
      direction: "OUT",
      channel: "API",
      type: "text",
      body: "fx09 unit test body（非病人資料）",
      status: "QUEUED",
      aiAutoSent: false,
      waTimestamp: new Date(),
    },
  });
}

/** 模擬 atomic claim（QUEUED → SENDING）— runOutboundSend 之後嘅 phase 假定 row 已 SENDING。 */
async function claimSending(id: string): Promise<NonNullable<Awaited<ReturnType<typeof prisma.message.findUnique>>>> {
  await prisma.message.update({ where: { id }, data: { status: "SENDING" } });
  return prisma.message.findUniqueOrThrow({ where: { id } });
}

before(async () => {
  const tkw = await prisma.clinic.findUnique({ where: { code: CLINIC_CODE } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  // 冪等 fixture（notice 只清理自己 fixture conv 嘅 SYSTEM — 測試唔會建 notice，呢步係安全網）
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV_ID, kind: "SYSTEM" } });
  await prisma.message.deleteMany({ where: { id: { in: [MSG_A, MSG_B, MSG_C, MSG_D] } } });
  await prisma.conversation.deleteMany({ where: { id: CONV_ID } });
  await prisma.contact.deleteMany({ where: { id: CONTACT_ID } });
  await prisma.contact.create({
    data: { id: CONTACT_ID, clinicId, waId: "85200099001", labels: [] },
  });
  await prisma.conversation.create({
    data: { id: CONV_ID, clinicId, contactId: CONTACT_ID, lastMessageAt: new Date() },
  });
  await createFixtureMessage(MSG_A, CONV_ID);
  await createFixtureMessage(MSG_B, CONV_ID);
  await createFixtureMessage(MSG_C, CONV_ID);
  await createFixtureMessage(MSG_D, CONV_ID);
});

after(async () => {
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV_ID, kind: "SYSTEM" } });
  // Alert.detail 係 Json — 冇 path+in 型別 → 查 type 後 JS filter 自己測試訊息先刪（零誤刪）
  const alerts = await prisma.alert.findMany({ where: { type: "outbound_unknown" }, select: { id: true, detail: true } });
  const mine = alerts.filter((a) => {
    const d = a.detail as { messageId?: unknown } | null;
    return !!d && typeof d.messageId === "string" && [MSG_A, MSG_B, MSG_C, MSG_D].includes(d.messageId);
  }).map((a) => a.id);
  if (mine.length > 0) await prisma.alert.deleteMany({ where: { id: { in: mine } } });
  await prisma.message.deleteMany({ where: { id: { in: [MSG_A, MSG_B, MSG_C, MSG_D] } } });
  await prisma.conversation.deleteMany({ where: { id: CONV_ID } });
  await prisma.contact.deleteMany({ where: { id: CONTACT_ID } });
  await closeRedis();
  await prisma.$disconnect();
});

async function freshMsg(id: string, conversationId: string) {
  await prisma.message.deleteMany({ where: { id } });
  await createFixtureMessage(id, conversationId);
  return prisma.message.findUniqueOrThrow({ where: { id } });
}

test("T769 核心：acquireToken throw 一次（pre-Graph）→ 還原 QUEUED；第 2 次 attempt → SENT，Graph 恰 1 次", async () => {
  await freshMsg(MSG_A, CONV_ID);
  const calls = countCalls();
  let acquireFails = 1; // 第一次 acquireToken throw（模擬 250ms wait timeout）
  const deps: OutboundSendDeps = {
    ...realOutboundDeps,
    acquireToken: async (o) => {
      if (acquireFails > 0) {
        acquireFails -= 1;
        throw new Error(`rate limit wait timeout: ${o.key} (capacity=80/s)`);
      }
    },
    sendTextMessage: async (_p) => {
      calls.inc();
      return { wamid: "wamid-fx09-a", mocked: false };
    },
  };

  // attempt 1：acquireToken throw → 應該 reject（job retry）+ row 還原 QUEUED（唔係 SENDING/UNKNOWN）
  const claimed1 = await claimSending(MSG_A);
  await assert.rejects(runOutboundSend(mkJob(MSG_A, 0), claimed1, deps), /rate limit wait timeout/);
  const after1 = await prisma.message.findUniqueOrThrow({ where: { id: MSG_A } });
  assert.equal(after1.status, "QUEUED", "pre-Graph 失敗要還原 QUEUED（俾下次 attempt 重新 claim）");
  assert.equal(after1.waMessageId, null);
  assert.equal(calls.count, 0, "Graph 未調用");

  // attempt 2：acquireToken 過 + Graph 成功 → SENT
  const claimed2 = await claimSending(MSG_A);
  await runOutboundSend(mkJob(MSG_A, 1), claimed2, deps);
  const after2 = await prisma.message.findUniqueOrThrow({ where: { id: MSG_A } });
  assert.equal(after2.status, "SENT", "第 2 次 attempt 應該成功 SENT");
  assert.equal(after2.waMessageId, "wamid-fx09-a");
  assert.equal(calls.count, 1, "Graph 恰 1 次（唔會雙發）");
});

test("pre-Graph（conv missing）非最終 attempt → 還原 QUEUED（唔會誤入 UNKNOWN）", async () => {
  // conv 唔存在嘅 message — runOutboundSend 內 conv 查詢 return null → throw
  await freshMsg(MSG_B, "fx09conv-missing-000001");
  const deps: OutboundSendDeps = {
    ...realOutboundDeps,
    sendTextMessage: async () => ({ wamid: "should-not-be-called", mocked: false }),
  };
  const claimed = await claimSending(MSG_B);
  await assert.rejects(runOutboundSend(mkJob(MSG_B, 0), claimed, deps), /conversation missing/);
  const row = await prisma.message.findUniqueOrThrow({ where: { id: MSG_B } });
  assert.equal(row.status, "QUEUED", "conv missing = pre-Graph → QUEUED 重試，唔係 UNKNOWN");
});

test("pre-Graph（conv missing）最終 attempt → FAILED（肯定未發，staff 可重發）— 唔係 UNKNOWN", async () => {
  await freshMsg(MSG_B, "fx09conv-missing-000001");
  const deps: OutboundSendDeps = {
    ...realOutboundDeps,
    sendTextMessage: async () => ({ wamid: "should-not-be-called", mocked: false }),
  };
  // attemptsMade=2 + attempts=3 → final
  const claimedB = await claimSending(MSG_B);
  await runOutboundSend(mkJob(MSG_B, 2), claimedB, deps); // 唔應該 throw（job 完成）
  const row = await prisma.message.findUniqueOrThrow({ where: { id: MSG_B } });
  assert.equal(row.status, "FAILED", "最終 pre-Graph 失敗 = 肯定未發 → FAILED");
  assert.match(row.errorCode ?? "", /conversation_missing/);
  assert.notEqual(row.status, "UNKNOWN", "肯定未發唔可以係 UNKNOWN（會誤禁重發）");
});

test("post-Graph TimeoutError → UNKNOWN（原有 S1-15 語義保留）", async () => {
  await freshMsg(MSG_C, CONV_ID);
  const deps: OutboundSendDeps = {
    ...realOutboundDeps,
    sendTextMessage: async () => {
      const e = new Error("graph timeout");
      e.name = "TimeoutError";
      throw e;
    },
  };
  const claimedC = await claimSending(MSG_C);
  await runOutboundSend(mkJob(MSG_C, 0), claimedC, deps); // 唔 throw（UNKNOWN 唔重試 — job 完成）
  const row = await prisma.message.findUniqueOrThrow({ where: { id: MSG_C } });
  assert.equal(row.status, "UNKNOWN", "Graph 後 timeout = 結果未知 → UNKNOWN（原語義）");
  assert.equal(row.errorCode, "SEND_OUTCOME_UNKNOWN");
});

test("post-Graph transient 失敗 → QUEUED 重試 → 第 2 次 SENT（原有 retry 語義保留）", async () => {
  await freshMsg(MSG_D, CONV_ID);
  let fails = 1;
  const deps: OutboundSendDeps = {
    ...realOutboundDeps,
    sendTextMessage: async () => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("transient graph 502");
      }
      return { wamid: "wamid-fx09-d", mocked: false };
    },
  };
  const claimedD1 = await claimSending(MSG_D);
  await assert.rejects(runOutboundSend(mkJob(MSG_D, 0), claimedD1, deps), /transient graph 502/);
  const mid = await prisma.message.findUniqueOrThrow({ where: { id: MSG_D } });
  assert.equal(mid.status, "QUEUED", "post-Graph transient → QUEUED（原語義）");
  const claimedD2 = await claimSending(MSG_D);
  await runOutboundSend(mkJob(MSG_D, 1), claimedD2, deps);
  const row = await prisma.message.findUniqueOrThrow({ where: { id: MSG_D } });
  assert.equal(row.status, "SENT");
  assert.equal(row.waMessageId, "wamid-fx09-d");
});
