/**
 * cwi-qa FX-08（QA-08）T771 — AI job deadline 真係停（AbortController 方案）。
 *
 * 施工單 L228-238 舊問題：`Promise.race` 超時後 inner 唔知自己已輸 — 繼續行 persist
 *（分類/路由/engine turn 照寫 DB）→ BullMQ retry 同舊 job 並行 → consult `turnCount` +2
 *（A9「首輪唔報價」靠 `turnCount === 0` 判定）、PatientFact／路由首覆重複寫。
 *
 * 修復：deadline 到 = AbortController.abort()（在途 LLM cancel）+ inner 每一步 persist 前查
 * `signal.aborted` → throw（零 persist，BullMQ retry 全新行）。
 *
 * T771 規格：mock LLM 延遲 > deadline → job fail；consult `turnCount` 只 +1、AiDraft 1 個、
 * PatientFact 冇重複。
 *
 * 方法：AI_MOCK=1 + 既有 test hook `AI_MOCK_DELAY_MS` 拉長 mock LLM call（零 mock 代碼改動）：
 *   1. 對照 conv（快）— baseline：AiDraft=1 / turnCount=1 / PatientFact=k
 *   2. conv A attempt 1：AI_JOB_DEADLINE_MS=400 < AI_MOCK_DELAY_MS=2500 → job fail
 *      （AiCallError deadline）+ 零 persist — 包括背景 mock call 完成後都冇「晚到 persist」
 *   3. conv A attempt 2（= BullMQ retry，attemptsMade=1，快）→ 成功 + 計數同對照一致
 *      （turnCount 只 +1 唔係 2、AiDraft 1 個、PatientFact 冇重複）
 *
 * hermetic：AI_GLOBAL_MAX_LEVEL=L1（任何 auto-send 都壓死）/ DUTY_MOCK=1 / WA_MOCK=1 /
 * 獨立 wa_p2 DB（.env）/ 唯一 fixture id（fx08 前綴）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── env 必喺 import app module 之前 set（module scope 讀 env）— FX-05 同一手寫 parse（零 dotenv 依賴） ──
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
process.env.AI_MOCK = "1";
process.env.WA_MOCK = "1";
process.env.DUTY_MOCK = "1";
process.env.AI_GLOBAL_MAX_LEVEL = "L1"; // hermetic：auto-send 全壓（draft-only）
process.env.AI_JOB_DEADLINE_MS = "120000";
process.env.AI_MOCK_DELAY_MS = "0";

import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";
import { AiCallError } from "@/lib/ai";
import { handleAiJob } from "@/workers/ai.worker";

const prisma = new PrismaClient();

// ── fixture（唯一 id — 唔會撞其他 test / e2e 嘅 row） ─────────────────────────
const U = "fx08";
const now = new Date();
const IDS = {
  contactA: `${U}-contact-a`,
  contactB: `${U}-contact-b`,
  convA: `${U}-conv-a`,
  convB: `${U}-conv-b`,
  msgA: `${U}-msg-a`,
  msgB: `${U}-msg-b`,
};
let clinicId = "";
let contactIdA = "";

/** ORTHODONTIC_CONSULT FLOOR 觸發詞（consult-trigger.ts:16「矯齒」）— 一般查詢語氣（QUESTION + draft）。 */
const BODY = "想問下矯齒要幾耐？";

type FakeJobData = { conversationId: string; messageId: string; clinicId: string };
function mkJob(data: FakeJobData, attemptsMade = 0): Parameters<typeof handleAiJob>[0] {
  return { id: `${U}-job`, data, attemptsMade, opts: { attempts: 3 } } as Parameters<typeof handleAiJob>[0];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cnt {
  drafts: number;
  turnCount: number;
  sessions: number;
  notices: number;
  facts: number;
}
async function counts(convId: string, contactId: string): Promise<Cnt> {
  const [drafts, sessions, notices, facts] = await Promise.all([
    prisma.aiDraft.count({ where: { conversationId: convId } }),
    prisma.consultSession.findMany({ where: { conversationId: convId }, select: { turnCount: true } }),
    prisma.staffNotice.count({ where: { conversationId: convId } }),
    prisma.patientFact.count({ where: { contactId } }),
  ]);
  return {
    drafts,
    turnCount: sessions.reduce((n, s) => n + s.turnCount, 0),
    sessions: sessions.length,
    notices,
    facts,
  };
}

async function makeFixture(kind: "A" | "B") {
  const contact = await prisma.contact.create({
    data: {
      id: IDS[`contact${kind}`],
      clinicId,
      waId: `852910${kind === "A" ? "80001" : "80002"}`,
      profileName: `T771 ${kind}`,
      labels: [],
    },
  });
  const conv = await prisma.conversation.create({
    data: {
      id: IDS[`conv${kind}`],
      clinicId,
      contactId: contact.id,
      status: "OPEN",
      lastInboundAt: now,
      lastMessageAt: now,
    },
  });
  const msg = await prisma.message.create({
    data: {
      id: IDS[`msg${kind}`],
      conversationId: conv.id,
      waMessageId: `wamid.fx08.${kind.toLowerCase()}`,
      direction: "IN",
      channel: "API",
      type: "text",
      body: BODY,
      status: "RECEIVED",
      waTimestamp: now,
      createdAt: now,
    },
  });
  return { contact, conv, msg };
}

async function wipe() {
  const convIds = [IDS.convA, IDS.convB];
  await prisma.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.consultSession.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.patientFact.deleteMany({ where: { contactId: { in: [IDS.contactA, IDS.contactB] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: convIds } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.contact.deleteMany({ where: { id: { in: [IDS.contactA, IDS.contactB] } } });
}

before(async () => {
  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(clinic, "TKW clinic 必須已 seed（wa_p2）");
  clinicId = clinic.id;
  contactIdA = IDS.contactA;
  await wipe();
  await makeFixture("A");
  await makeFixture("B");
});

after(async () => {
  await wipe();
  await closeRedis().catch(() => {});
  await prisma.$disconnect();
});

test("T771-1（對照）：快 path 單 run — AiDraft=1 / turnCount=1（baseline）", async () => {
  const r = await handleAiJob(mkJob({ conversationId: IDS.convB, messageId: IDS.msgB, clinicId }));
  assert.equal(r.ok, true, `expect ok — got ${JSON.stringify(r).slice(0, 200)}`);
  const c = await counts(IDS.convB, IDS.contactB);
  assert.equal(c.drafts, 1, "對照：QUESTION 應有 1 個 draft");
  assert.equal(c.turnCount, 1, "對照：consult 首輪 turnCount=1");
});

test("T771-2（核心）：mock LLM 延遲 > deadline → job fail + 零 persist（包括 late persist）", async () => {
  process.env.AI_JOB_DEADLINE_MS = "400";
  process.env.AI_MOCK_DELAY_MS = "2500";
  try {
    const before = await counts(IDS.convA, contactIdA);
    assert.equal(before.drafts, 0);
    assert.equal(before.turnCount, 0);

    // job 必 fail — AiCallError（deadline），唔係 skip/ok
    await assert.rejects(
      handleAiJob(mkJob({ conversationId: IDS.convA, messageId: IDS.msgA, clinicId })),
      (e: unknown) => e instanceof AiCallError && /deadline exceeded/.test(e.message),
      "deadline 超時必須 throw AiCallError（job fail → BullMQ retry）"
    );

    // 背景 mock call 仲喺度行（2.5s）— 等佢完成先驗證「冇晚到 persist」
    //   （舊 bug 正係呢度：inner 超時後繼續行 persist）
    await sleep(2900);

    const after = await counts(IDS.convA, contactIdA);
    assert.deepEqual(after, before, "超時 attempt 零 persist（包括背景 LLM 完成後都唔得晚到寫）");
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: IDS.convA } });
    assert.equal(conv.intent, null, "超時 attempt 唔得寫 conv.intent");
    assert.equal(conv.urgent, false, "超時 attempt 唔得寫 conv.urgent");
  } finally {
    process.env.AI_JOB_DEADLINE_MS = "120000";
    process.env.AI_MOCK_DELAY_MS = "0";
  }
});

test("T771-3（retry）：第二次 try 成功 — turnCount 只 +1、AiDraft 1 個、PatientFact 冇重複", async () => {
  const r = await handleAiJob(mkJob({ conversationId: IDS.convA, messageId: IDS.msgA, clinicId }, 1));
  assert.equal(r.ok, true, `retry 應成功 — got ${JSON.stringify(r).slice(0, 200)}`);

  const a = await counts(IDS.convA, contactIdA);
  const b = await counts(IDS.convB, IDS.contactB);
  assert.equal(a.drafts, 1, "AiDraft 只可 1 個（冪等 create — 唔會同舊 job 重複）");
  assert.equal(a.turnCount, 1, "consult turnCount 只 +1（唔係 2 — A9「首輪唔報價」守門依赖呢個）");
  assert.equal(a.sessions, 1, "consult session 只可 1 個");
  assert.equal(a.facts, b.facts, "PatientFact 冇重複（同對照 conv 一致）");
  assert.equal(a.notices, b.notices, "StaffNotice 冇重複（同對照 conv 一致）");
  // draft 連結到觸發訊息（idempotent link）
  const msg = await prisma.message.findUniqueOrThrow({ where: { id: IDS.msgA } });
  assert.ok(msg.aiDraftId, "msg.aiDraftId 應已連結");
  const draft = await prisma.aiDraft.findUniqueOrThrow({ where: { id: msg.aiDraftId } });
  assert.equal(draft.inReplyToMessageId, IDS.msgA);
});
