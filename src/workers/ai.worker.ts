import { Worker, type Job } from "bullmq";
import { aiQueue, outboundQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { AI_CONCURRENCY } from "./concurrency";
import log from "@/lib/log";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { publishNotify } from "@/lib/notify";
import { getWindowState } from "@/lib/wa/window";
import {
  classifyAndDraft,
  getAiConfig,
  isAiMockEnabled,
  recordAiCall,
  type AiContextMessage,
  type ClassifyAndDraftResult,
} from "@/lib/ai";
import { PROMPT_CONTEXT_MESSAGES } from "@/lib/ai/prompts";
import { scrubAiSummary } from "@/lib/ai/scrub";
import { fetchDutyRoster, hkToday } from "@/lib/duty/client";

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
 *   4. 草稿（intent≠URGENT_PAIN 且 urgency≠HIGH 且 model 畀咗 draft）：
 *      AiDraft(PROPOSED)，冪等 — 同一 Message 只可有一條（unique constraint）
 *      （Phase 2b：needsHuman=true 都可以出 draft — 只係永遠唔會自動發）
 *   4.5 AUTO 模式（Phase 2b 逐舖設定 clinic.aiMode，default DRAFT）：
 *      全部滿足先自動發：aiMode=AUTO + intent≠URGENT_PAIN + urgency≠HIGH
 *      + needsHuman=false + 有 draft + 24h 窗口內。任何一個唔滿足 → 退回 DRAFT 行為。
 *      自動發 = 寫 Message(OUT, aiAutoSent=true, sentByStaffId=null) + draft 標 SENT_AUTO
 *      + AuditLog(AI_AUTO_SEND) + 入既有 outbound chain（mock/real Graph、retries、rate limit）。
 *      冪等：同一 draft 只可有一條 OUT 訊息（re-delivery / retry 重跑唔會重發）。
 *      鐵律：URGENT_PAIN / HIGH 任何模式永遠唔自動發（prompt + code 雙重擋）。
 *   5. Socket 推 ai:classified（每次成功）/ draft:ready（draft 仍係 PROPOSED）/
 *      urgent:escalation（急症）；自動發出嘅 OUT 訊息由 outbound worker 推 message:new
 *      （帶 aiAutoSent 標記，UI 顯示「AI 自動覆」）
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
  // H-3：contact 身份（profileName/waId）— aiSummary 落庫前 deterministic scrub（去識別化）用
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });

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
  // Phase 4：當日當值名單注入 prompt（AI 可以答「今日邊個喺度」）—
  // fetchDutyRoster 永遠唔 throw（3s timeout / 404 / 壞 shape → null）；5 分鐘 TTL cache。
  const dutyToday = hkToday();
  const dutyEntries = await fetchDutyRoster(clinic.code, dutyToday).catch(() => null);
  let result: ClassifyAndDraftResult;
  try {
    result = await classifyAndDraft({
      messages: ctxMessages,
      clinic: {
        name: clinic.name,
        greetingConfig: (clinic.greetingConfig as Record<string, unknown> | null) ?? null,
      },
      dutyRoster: dutyEntries && dutyEntries.length > 0 ? { date: dutyToday, entries: dutyEntries } : null,
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
  await recordAiCall(true, undefined, result.latencyMs, result.tokens);

  // ── 3. 分類落 Conversation ───────────────────────────────────────────
  // ★ H-3 第二層（deterministic scrub，零 AI 依賴）：AI 可能唔聽 prompt 寫咗身份資料 —
  //   落庫/推送前將 profileName（完整 + ≥2 字子串）同 waId 後 8 位替換做 病人/***
  const safeSummary = scrubAiSummary(result.summary, { profileName: contact?.profileName, waId: contact?.waId });
  const urgent = result.intent === "URGENT_PAIN" || result.urgency === "HIGH";
  const updatedConv = await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      intent: result.intent,
      intentConfidence: result.confidence,
      urgency: result.urgency,
      aiSummary: safeSummary.length > 0 ? safeSummary.slice(0, 50) : null,
      // urgent 只 set true 唔 set false — 已標急症嘅對話唔會被新一條普通訊息蓋掉
      ...(urgent ? { urgent: true } : {}),
    },
  });

  // ── 4. AI 草稿（鐵律：URGENT_PAIN / HIGH 永不生成 — code 層第一重擋） ─────
  // Phase 2b：needsHuman=true 都可以出 draft（staff 審批；AUTO 模式永遠唔會自動發）
  let draft: {
    id: string;
    draftText: string;
    status: string;
  } | null = null;
  const canDraft =
    result.intent !== "URGENT_PAIN" &&
    result.urgency !== "HIGH" &&
    result.draft !== null;
  if (canDraft) {
    // 冪等：unique(conversationId, inReplyToMessageId) + 前置查（retry 重跑唔會重複 draft）
    let existing = await prisma.aiDraft.findUnique({
      where: {
        conversationId_inReplyToMessageId: {
          conversationId: conv.id,
          inReplyToMessageId: msg.id,
        },
      },
    });
    if (!existing) {
      try {
        existing = await prisma.aiDraft.create({
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
          existing = await prisma.aiDraft.findUnique({
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
    draft = existing;
    // 連結 message ↔ draft（send route 用嚟判採用狀態；UI 顯示上下文）
    if (msg.aiDraftId !== draft!.id) {
      await prisma.message.update({ where: { id: msg.id }, data: { aiDraftId: draft!.id } });
    }
  }

  // ── 4.5 AUTO 模式（Phase 2b 逐舖設定；default DRAFT = 舊行為完全唔變） ─────
  // 全部滿足先自動發；任何一個唔滿足 → 退回 DRAFT（pending draft 俾 staff 處理）
  const win = getWindowState(updatedConv.lastInboundAt);
  let autoSent = false;
  if (clinic.aiMode === "AUTO") {
    const blocks: string[] = [];
    if (result.intent === "URGENT_PAIN") blocks.push("URGENT_PAIN"); // 鐵律：code 第二重擋
    if (result.urgency === "HIGH") blocks.push("HIGH");             // 鐵律：code 第二重擋
    if (result.needsHuman) blocks.push("needsHuman");               // 鐵律：人工永遠唔自動發
    if (draft === null) blocks.push("no-draft");
    if (!win.open) blocks.push("window-closed");
    if (blocks.length > 0) {
      // metadata only（唔含 draft/summary 內容）
      log.info(
        { clinic: clinic.code, wamid: msg.waMessageId, reasons: blocks.join("+") },
        "ai: AUTO mode — not eligible, fallback to DRAFT (pending draft for staff)"
      );
    } else {
      autoSent = await attemptAutoSend({ conv: updatedConv, clinic, draft: draft!, msg, result });
      // 重讀 draft status（可能已標 SENT_AUTO；enqueue 失敗會回退 PROPOSED）
      if (draft) {
        const fresh = await prisma.aiDraft.findUnique({ where: { id: draft.id }, select: { status: true } });
        if (fresh) draft = { ...draft, status: fresh.status };
      }
    }
  }

  // draft:ready 只喺 draft 仍然 PROPOSED（即 staff 仲要審批）時推 —
  // 已自動發出（SENT_AUTO）唔好再彈「AI 建議」卡俾 staff
  if (draft && draft.status === "PROPOSED" && !autoSent) {
    publishNotify(conv.clinicId, "draft:ready", {
      conversationId: conv.id,
      draftId: draft.id,
      inReplyToMessageId: msg.id,
      draftText: draft.draftText,
      model: result.model,
      latencyMs: result.latencyMs,
    });
  }
  const draftId = draft?.id ?? null;

  // ── 5. Socket 推 ─────────────────────────────────────────────────────
  publishNotify(conv.clinicId, "ai:classified", {
    conversationId: conv.id,
    intent: result.intent,
    urgency: result.urgency,
    needsHuman: result.needsHuman,
    urgent: updatedConv.urgent,
    aiSummary: safeSummary, // ★ H-3：同 DB 一致（scrub 後）— live push 亦唔帶身份資料
    hasDraft: draftId !== null,
    aiMode: clinic.aiMode,
    autoSent,
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
      aiMode: clinic.aiMode,
      draft: draftId !== null,
      autoSent,
    },
    "ai: classified"
  );

  return { ok: true, intent: result.intent, urgent: updatedConv.urgent, draft: draftId !== null, autoSent };
}

/**
 * AUTO 模式自動發送（Phase 2b）— 行既有 outbound chain，唔另開路徑。
 *
 * 冪等：同一 draft 只可對應一條 OUT 訊息（re-delivery / BullMQ retry 重跑唔會重發）。
 * 失敗降級：enqueue 失敗 → message 標 FAILED + draft 回退 PROPOSED（staff 可手動處理）。
 * AuditLog 必登（AI_AUTO_SEND）— metadata only，永不存訊息原文。
 *
 * @returns true = 已（或已經）自動發送；false = 降級（draft 仍 PROPOSED，staff 處理）
 */
async function attemptAutoSend(args: {
  conv: {
    id: string;
    clinicId: string;
    contactId: string;
    status: string;
    lastInboundAt: Date | null;
  };
  clinic: { id: string; code: string };
  draft: { id: string; draftText: string; status: string };
  msg: { id: string; waMessageId: string | null };
  result: ClassifyAndDraftResult;
}): Promise<boolean> {
  const { conv, clinic, draft, msg, result } = args;
  const now = new Date();

  // 冪等 guard：呢個 draft 已經發過 → skip
  const existing = await prisma.message.findFirst({
    where: { conversationId: conv.id, direction: "OUT", aiDraftId: draft.id },
    select: { id: true },
  });
  if (existing) {
    log.info(
      { clinic: clinic.code, conversationId: conv.id, draftId: draft.id, messageId: existing.id },
      "ai: AUTO send already exists — idempotent skip (no re-send)"
    );
    return true;
  }

  // 寫 OUT 訊息（QUEUED）— 完全跟 staff 發送同一條 outbound 鏈
  const outMsg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUT",
      channel: "API",
      type: "text",
      body: draft.draftText,
      status: "QUEUED",
      sentByStaffId: null,
      aiAutoSent: true,
      aiDraftId: draft.id,
      waTimestamp: now,
    },
  });

  // 入 outbound queue（mock/real Graph、retries、rate limit 全部沿用）
  try {
    await Promise.race([
      outboundQueue.add("send", { messageId: outMsg.id }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("enqueue timeout")), 1500)
      ),
    ]);
  } catch (err) {
    // queue 寫入失敗（Redis 問題）→ 降級：message FAILED + draft 回退 PROPOSED（staff 可審批發送）
    await prisma.message
      .update({ where: { id: outMsg.id }, data: { status: "FAILED", errorCode: "ENQUEUE_FAILED" } })
      .catch(() => undefined);
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: "AI_AUTO_SEND_FAILED",
          entity: "Message",
          entityId: outMsg.id,
          meta: {
            conversationId: conv.id,
            messageId: outMsg.id,
            draftId: draft.id,
            intent: result.intent,
            urgency: result.urgency,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    log.error(
      { clinic: clinic.code, conversationId: conv.id, messageId: outMsg.id, err: err instanceof Error ? err.message : String(err) },
      "ai: AUTO send enqueue failed — message FAILED, draft back to PROPOSED (staff manual)"
    );
    return false;
  }

  // enqueue 成功 → 留底 draft（SENT_AUTO，staff 之後可審計）+ AuditLog 必登（metadata only）
  await prisma.aiDraft.update({
    where: { id: draft.id },
    data: { status: "SENT_AUTO", finalText: draft.draftText },
  });
  await prisma.auditLog
    .create({
      data: {
        staffId: null,
        action: "AI_AUTO_SEND",
        entity: "Message",
        entityId: outMsg.id,
        meta: {
          conversationId: conv.id,
          messageId: outMsg.id,
          draftId: draft.id,
          intent: result.intent,
          urgency: result.urgency,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);

  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  // ★ metadata only — 冇 body / draftText / summary
  log.info(
    {
      clinic: clinic.code,
      clinicId: clinic.id,
      conversationId: conv.id,
      messageId: outMsg.id,
      draftId: draft.id,
      intent: result.intent,
      urgency: result.urgency,
      replyWamid: msg.waMessageId,
    },
    "ai: AUTO send queued (outbound chain; draft=SENT_AUTO)"
  );
  return true;
}

export function startAiWorker(): Worker {
  const worker = new Worker<AiJobData>(
    aiQueue.name,
    async (job: Job<AiJobData>) => handleAiJob(job),
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      // ★ Realtime P0 (R4)：唔准調大 — per-conversation ordering 靠佢（見 src/workers/concurrency.ts）；
      //   要 scale 先實施 group-by-conversationId（R8 觸發條件）。drift guard：pnpm test:ordering
      concurrency: AI_CONCURRENCY,
    }
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
