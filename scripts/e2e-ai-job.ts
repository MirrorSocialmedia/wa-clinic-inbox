/**
 * e2e-ai-job — Phase 2b E2E helper（T23 過窗 + AUTO 重試冪等）。
 *
 * 用法（repo root，需要 .env）：
 *   pnpm e2e:ai-job old-inbound --clinic TKW --from <waId> --text <t>
 *     直接 DB 寫 Contact + Conversation(lastInboundAt = 25h 前) + Message(IN, API, 25h 前)，
 *     然後 enqueue 一個 AI job — 模擬「AI job 處理時 24h 窗口已過」。
 *     （真 webhook 會將 lastInboundAt 設成 now，窗口永遠開；呢個 state 只可以經 DB 直接寫 +
 *      直接 enqueue 造成。AI worker 邏輯本身係真嘅 — 分類/窗口檢查/AUTO 判定全部走 production code。）
 *     輸出：CONV=<conversationId> MSG=<messageId> CLINIC=<clinicId>
 *
 *   pnpm e2e:ai-job requeue --conversation <convId> --message <msgId> --clinic <clinicId>
 *     為已有嘅 inbound message 再 enqueue 一個 AI job（唔同 job id，令 BullMQ 真正重跑）—
 *     測 AUTO 發送冪等：re-delivery 唔會重複發 OUT 訊息。
 *
 * ★ 呢個 script 唔 log 訊息內容（PII 鐵律）。
 * ★ 必須 q.close() — 唔 close 個 IORedis 會令 node process 永遠唔 exit（E2E hang）。
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const opts: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    opts[rest[i].slice(2)] = rest[i + 1] ?? "";
    i++;
  }
}

function requireOpt(name: string): string {
  const v = opts[name];
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

function redisConnection(): IORedis {
  const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });
}

/** 跟 production 同一 queue name/prefix（src/lib/queue.ts: QUEUE_PREFIX="wa-inbox"）。 */
function aiQueueLike(): Queue {
  return new Queue("ai", {
    connection: redisConnection(),
    prefix: "wa-inbox",
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}

async function main(): Promise<void> {
  const q = aiQueueLike();
  let exitCode = 0;
  try {
    if (cmd === "old-inbound") {
      const clinicCode = requireOpt("clinic");
      const from = requireOpt("from");
      const text = requireOpt("text");
      const clinic = await prisma.clinic.findUnique({ where: { code: clinicCode } });
      if (!clinic) {
        console.error(`clinic ${clinicCode} not found`);
        process.exit(2);
      }
      // 25 小時前（窗口已過）
      const old = new Date(Date.now() - 25 * 3600 * 1000);
      const contact = await prisma.contact.upsert({
        where: { clinicId_waId: { clinicId: clinic.id, waId: from } },
        update: {},
        create: { clinicId: clinic.id, waId: from, profileName: "E2E 過窗病人" },
      });
      const conv = await prisma.conversation.create({
        data: {
          clinicId: clinic.id,
          contactId: contact.id,
          lastInboundAt: old,
          lastMessageAt: old,
          unreadCount: 1,
        },
      });
      const msg = await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: "IN",
          channel: "API",
          type: "text",
          body: text,
          waMessageId: `wamid.E2E_OLD${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          waTimestamp: old,
          status: "RECEIVED",
        },
      });
      // 直接 enqueue AI job（跟 production 同一 queue name/prefix）
      await q.add("classify", { conversationId: conv.id, messageId: msg.id, clinicId: clinic.id }, { jobId: `ai-${msg.id}` });
      console.log(`CONV=${conv.id} MSG=${msg.id} CLINIC=${clinic.id}`);
    } else if (cmd === "requeue") {
      const conversationId = requireOpt("conversation");
      const messageId = requireOpt("message");
      const clinicId = requireOpt("clinic");
      // 唔同 job id — 令 BullMQ 真正重跑（冪等要由 DB 層擋，唔係 queue id 擋）
      await q.add("classify", { conversationId, messageId, clinicId }, { jobId: `ai-${messageId}-rerun` });
      console.log(`REQUEUED msg=${messageId}`);
    } else {
      console.error("usage: e2e-ai-job <old-inbound|requeue> [options]");
      process.exit(2);
    }
  } catch (err) {
    console.error("[e2e-ai-job] error:", err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    // ★ 一定要 close — 唔 close 個 IORedis 會令 node process 永遠唔 exit（E2E hang）
    await q.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  // ★ 明確 process.exit — pnpm 包緊嘅 script event loop 可能唔 drain 淨（實測 hang），
  //   唔好依賴「全部 handle 自己關晒」。
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[e2e-ai-job] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
