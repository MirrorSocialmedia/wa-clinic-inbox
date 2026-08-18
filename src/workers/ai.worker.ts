import { Worker, type Job } from "bullmq";
import { aiQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import log from "@/lib/log";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { publishNotify } from "@/lib/notify";
import {
  classifyAndDraft,
  getAiConfig,
  isAiMockEnabled,
  recordAiCall,
  type AiContextMessage,
  type ClassifyAndDraftResult,
} from "@/lib/ai";
import { PROMPT_CONTEXT_MESSAGES } from "@/lib/ai/prompts";

/**
 * ai worker — Phase 2 triage pipeline（框架 MD §7）。
 *
 * 觸發：inbound worker 寫 Message(IN, API) 後 push aiQueue
 * （HISTORY / APP_ECHO 唔觸發 — Phase 1 規則沿用）。
 *
 * 流程（每 job）：
 *   1. 載入 message + conversation + clinic（消失/不匹配 → skip，唔值得 retry）
 *   2. 組上下文（最近 10 條 in/out）→ classifyAndDraft（mock / vLLM 統一入口）
 *   3. 分類落 Conversation：intent / intentConfidence / urgency / aiSummary
 *      + 鐵律：urgency=HIGH 或 intent=URGENT_PAIN → urgent=true + urgent:escalation
 *   4. 草稿（intent≠URGENT_PAIN 且 urgency≠HIGH 且 needsHuman=false 且 model 畀咗 draft）：
 *      AiDraft(PROPOSED)，冪等 — 同一 Message 只可有一條（unique constraint）
 *   5. Socket 推 ai:classified（每次成功）/ draft:ready（有 draft）/ urgent:escalation（急症）
 *
 * 降級（鐵律 4：AI 失敗 = 降級唔係中斷）：
 * - call 失敗/超時 → recordAiCall(false) + log metadata only + throw（BullMQ retry，
 *   attempts 3 + exponential backoff；circuit breaker 防 GPU 機離線時排隊打爆）
 * - 失敗時唔改 Conversation（舊 intent/urgency/summary 保留）、唔生成 draft
 * - inbox 功能完全唔受影響（AI 欄位顯示「—」）
 *
 * ★ PII 鐵律：log 永遠 metadata only（intent/urgency/latency/model/tokens/clinic/wamid）。
 *   訊息原文 / summary / draft 只去：本地 vLLM（prompt）、DB、自己 VPS 嘅 Socket。
 */

interface AiJobData {
  conversationId: string;
  messageId: string;
  clinicId: string;
}

async function handleAiJob(job: Job<AiJobData>): Promise<Record<string, unknown>> {
  const data = job.data;
  if (!data?.conversationId || !data?.messageId || !data?.clinicId) {
    log.warn({ jobId: job.id, dataKeys: data ? Object.keys(data) : null }, "ai job: invalid data — skip (no retry)");
    return { skipped: "invalid-data" };
  }

  // ── 1. 載入上下文 ─────────────────────────────────────────────────────
  const msg = await prisma.message.findUnique({ where: { id: data.messageId } });
  if (!msg) {
    log.warn({ jobId: job.id, messageId: data.messageId }, "ai job: message gone — skip (no retry)");
    return { skipped: "message-gone" };
  }
  // Defense：AI 只處理 IN+API（inbound worker 已確保；manual/re-run 都喺呢度擋）
  if (msg.direction !== "IN" || msg.channel !== "API") {
    log.warn(
      { wamid: msg.waMessageId, direction: msg.direction, channel: msg.channel },
      "ai job: not API inbound — skip (no retry)"
    );
    return { skipped: "not-api-inbound" };
  }
  const conv = await prisma.conversation.findUnique({ where: { id: data.conversationId } });
  if (!conv) {
    log.warn({ jobId: job.id, conversationId: data.conversationId }, "ai job: conversation gone — skip (no retry)");
    return { skipped: "conversation-gone" };
  }
  if (conv.clinicId !== data.clinicId) {
    log.warn({ jobId: job.id, conversationId: data.conversationId }, "ai job: clinic mismatch — skip (no retry)");
    return { skipped: "clinic-mismatch" };
  }
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
  if (!clinic) {
    log.warn({ jobId: job.id, clinicId: conv.clinicId }, "ai job: clinic gone — skip (no retry)");
    return { skipped: "clinic-gone" };
  }

  const recent = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { waTimestamp: "desc" },
    take: PROMPT_CONTEXT_MESSAGES,
  });
  const ctxMessages: AiContextMessage[] = [...recent].reverse().map((m) => ({
    direction: m.direction,
    channel: m.channel,
    type: m.type,
    body: m.body,
    waTimestamp: m.waTimestamp,
  }));

  // ── 2. AI call（失敗 = 降級：record + log metadata + throw 俾 BullMQ retry） ──
  let result: ClassifyAndDraftResult;
  try {
    result = await classifyAndDraft({
      messages: ctxMessages,
      clinic: {
        name: clinic.name,
        greetingConfig: (clinic.greetingConfig as Record<string, unknown> | null) ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiCall(false, message);
    const attemptsTotal = job.opts.attempts ?? 3;
    const finalAttempt = (job.attemptsMade ?? 0) + 1 >= attemptsTotal;
    log.error(
      {
        clinic: clinic.id,
        wamid: msg.waMessageId,
        mode: isAiMockEnabled() ? "mock" : "real",
        model: isAiMockEnabled() ? null : getAiConfig().primaryModel,
        attemptsMade: job.attemptsMade,
        finalAttempt,
        err: message,
      },
      "ai: call failed — degraded（舊 intent/summary 保留，無 draft，inbox 照常）"
    );
    throw err;
  }
  await recordAiCall(true);

  // ── 3. 分類落 Conversation ───────────────────────────────────────────
  const urgent = result.intent === "URGENT_PAIN" || result.urgency === "HIGH";
  const updatedConv = await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      intent: result.intent,
      intentConfidence: result.confidence,
      urgency: result.urgency,
      aiSummary: result.summary.length > 0 ? result.summary.slice(0, 50) : null,
      // urgent 只 set true 唔 set false — 已標急症嘅對話唔會被新一條普通訊息蓋掉
      ...(urgent ? { urgent: true } : {}),
    },
  });

  // ── 4. AI 草稿（鐵律 3：URGENT_PAIN / HIGH / needsHuman 永不生成） ─────
  let draftId: string | null = null;
  const canDraft =
    result.intent !== "URGENT_PAIN" &&
    result.urgency !== "HIGH" &&
    !result.needsHuman &&
    result.draft !== null;
  if (canDraft) {
    // 冪等：unique(conversationId, inReplyToMessageId) + 前置查（retry 重跑唔會重複 draft）
    let draft = await prisma.aiDraft.findUnique({
      where: {
        conversationId_inReplyToMessageId: {
          conversationId: conv.id,
          inReplyToMessageId: msg.id,
        },
      },
    });
    if (!draft) {
      try {
        draft = await prisma.aiDraft.create({
          data: {
            conversationId: conv.id,
            inReplyToMessageId: msg.id,
            draftText: result.draft as string,
            model: result.model,
            latencyMs: result.latencyMs,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // 競態（並行 retry 撞 unique）→ 取已存在嗰條
          draft = await prisma.aiDraft.findUnique({
            where: {
              conversationId_inReplyToMessageId: {
                conversationId: conv.id,
                inReplyToMessageId: msg.id,
              },
            },
          });
        } else {
          throw err;
        }
      }
    }
    draftId = draft!.id;
    // 連結 message ↔ draft（send route 用嚟判採用狀態；UI 顯示上下文）
    if (msg.aiDraftId !== draftId) {
      await prisma.message.update({ where: { id: msg.id }, data: { aiDraftId: draftId } });
    }
    publishNotify(conv.clinicId, "draft:ready", {
      conversationId: conv.id,
      draftId,
      inReplyToMessageId: msg.id,
      draftText: draft!.draftText,
      model: result.model,
      latencyMs: result.latencyMs,
    });
  }

  // ── 5. Socket 推 ─────────────────────────────────────────────────────
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  publishNotify(conv.clinicId, "ai:classified", {
    conversationId: conv.id,
    intent: result.intent,
    urgency: result.urgency,
    needsHuman: result.needsHuman,
    urgent: updatedConv.urgent,
    aiSummary: result.summary,
    hasDraft: draftId !== null,
  });
  if (urgent) {
    // 鐵律：急症 = 實時升級通知（staff 側 toast + 隊列頂部紅標）
    publishNotify(conv.clinicId, "urgent:escalation", {
      conversationId: conv.id,
      intent: result.intent,
      urgency: result.urgency,
      contactId: conv.contactId,
      contactName: contact?.profileName ?? null,
      waMessageId: msg.waMessageId,
    });
  }

  // ★ metadata only — 呢度冇 summary / draft / body
  log.info(
    {
      clinic: clinic.id,
      wamid: msg.waMessageId,
      intent: result.intent,
      urgency: result.urgency,
      needsHuman: result.needsHuman,
      urgent: updatedConv.urgent,
      model: result.model,
      latencyMs: result.latencyMs,
      tokens: result.tokens,
      draft: draftId !== null,
    },
    "ai: classified"
  );

  return { ok: true, intent: result.intent, urgent: updatedConv.urgent, draft: draftId !== null };
}

export function startAiWorker(): Worker {
  const worker = new Worker<AiJobData>(
    aiQueue.name,
    async (job: Job<AiJobData>) => handleAiJob(job),
    { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency: 3 }
  );

  worker.on("completed", (job) => {
    const r = job.returnvalue as Record<string, unknown> | undefined;
    log.info(
      { jobId: job.id, intent: r?.intent ?? null, urgent: r?.urgent ?? null, draft: r?.draft ?? null },
      "ai job completed"
    );
  });
  worker.on("failed", (job, err) => {
    // 最終嘗試都 fail（retries 耗盡）→ 降級記錄（AI 欄位維持舊值，inbox 照常）
    log.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      "ai job failed (final) — conversation AI 欄位維持舊值"
    );
  });
  worker.on("error", (err) => {
    // Connection-level error（e.g. Redis retry 耗盡）→ log 後 exit，PM2 重啟 process。
    // 唔好留低一個死咗嘅 worker 冇聲冇息（silent outage 比 crash 可怕）。
    log.error({ queue: aiQueue.name, err: err.message }, "ai worker error — exiting for PM2 restart");
    process.exit(1);
  });

  return worker;
}
