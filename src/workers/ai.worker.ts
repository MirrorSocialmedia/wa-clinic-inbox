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
  classifySessionTurn,
  getAiConfig,
  isAiMockEnabled,
  recordAiCall,
  type AiContextMessage,
  type ClassifyAndDraftResult,
} from "@/lib/ai";
import { PROMPT_CONTEXT_MESSAGES } from "@/lib/ai/prompts";
import { scrubAiSummary } from "@/lib/ai/scrub";
import { getAutomationLevel } from "@/lib/ai/automation";
import type { SessionSlots } from "@/lib/ai/session-types";
import { fetchDutyRoster, hkToday } from "@/lib/duty/client";
// ★ Phase C（cwi-sess-20260824-c1）：slot-filling session runner（C6）
import { getSlots } from "@/lib/availability";
import {
  step as sessionStep,
  candidateText as sessionCandidateText,
  confirmLine as sessionConfirmLine,
  SESSION_TTL_MS,
  type StepCtx,
} from "@/lib/booking/session-engine";
import { confirmBookingCore } from "@/lib/booking/confirm-core";
// ★ Phase D（cwi-ai-20260825-t4）：workflow 參數化 — 每決策點讀 ACTIVE definition（fail-soft → code defaults）
import { getParams } from "@/lib/workflow/store";
import { sendBookingFlow, WindowClosedError } from "@/lib/flows/send";

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

// ★ AI Workflow T1 (A2)：media 類型（同 src/workers/inbound.worker.ts L90 一致）— 媒體走內部通知軌
const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);

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

  // ★ AI Workflow T1 (A2)：媒體訊息 → 內部通知軌（StaffNotice 落庫 + notice:new socket）。
  //   客戶端零 AI 回覆（canDraft 限 text + AUTO media 閘）；職員 bell 提示人工處理。
  //   R2 鐵律：commit-then-emit（create 已 commit 先發 socket）。
  const isMedia = MEDIA_TYPES.has(msg.type);
  if (isMedia) {
    await prisma.staffNotice.create({
      data: {
        clinicId: conv.clinicId,
        conversationId: conv.id,
        kind: "MEDIA_RECEIVED",
        title: `病人傳送咗${msg.type === "image" ? "相片" : "檔案"}，請職員查看處理`,
        meta: { wamid: msg.waMessageId, msgType: msg.type },
      },
    });
    publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: "MEDIA_RECEIVED" });
  }

  // ── C6：session 分流（Phase C）────────────────────────────
  // active slot-filling session → handleSessionTurn；真人接手 = session 即讓路
  const activeSession = await prisma.bookingSession.findFirst({
    where: { conversationId: conv.id, status: { in: ["ACTIVE", "CONFIRMING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (activeSession) {
    if (conv.assigneeId !== null) {
      // 真人接手 = session 即讓路（同七閘 assigned 語義一致）
      await prisma.bookingSession.update({ where: { id: activeSession.id }, data: { status: "HANDOFF" } });
      log.info(
        { sessionId: activeSession.id, conversationId: conv.id },
        "session: staff claimed → HANDOFF（讓路，跌落普通 classify）"
      );
      // 跌落普通 classify（唔 return）— staff 接手後 AI 淨係出 draft
    } else if (msg.type !== "text") {
      // 媒體訊息：Phase A 通知照出（上面已行），session 唔郁、唔覆
      return { ok: true, session: activeSession.id, skipped: "media-in-session" };
    } else {
      return await handleSessionTurn(activeSession, msg, conv, clinic);
    }
  }

  const recent = await prisma.message.findMany({
    // ★ Fix A（cwi-fix-20260825-f1）：INTERNAL 備註（type=note）絕不入 LLM prompt —
    //   msgLine 對非 text 類型會輸出 [type body]，唔 filter = 員工內部討論影響草稿/AUTO 覆文。
    //   （同 line ~350 cooldown query 嘅 channel:{not:"INTERNAL"} 同一語義 — 嗰度做咗呢度漏咗。）
    where: { conversationId: conv.id, channel: { not: "INTERNAL" } },
    orderBy: [{ waTimestamp: "desc" }, { createdAt: "desc" }], // 同秒 tie（WhatsApp ts 秒級）→ 落庫順序定，latest 必須係最新到
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

  // ★ Phase C (cwi-sess-20260824-c1)：投訴 → 內部通知軌（HANDOFF_REQUEST — 要真人跟進）
  //   R2 鐵律：commit-then-emit（create 已 commit 先發 socket）。
  if (result.intent === "COMPLAINT") {
    await prisma.staffNotice.create({
      data: {
        clinicId: conv.clinicId,
        conversationId: conv.id,
        kind: "HANDOFF_REQUEST",
        title: "病人投訴 — 需要真人跟進",
        meta: { wamid: msg.waMessageId, intent: result.intent },
      },
    });
    publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: "HANDOFF_REQUEST" });
  }

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

  // ── C6：L3+ 開 session（BOOKING_REQUEST + 無人接手 + 文字訊息）──
  // 無 AutomationPolicy row 嘅店 = legacy L1/L2 → 一行都唔改（跌落現有 draft/AUTO）
  if (
    result.intent === "BOOKING_REQUEST" &&
    msg.type === "text" &&
    updatedConv.assigneeId === null &&
    !activeSession
  ) {
    const level = await getAutomationLevel(conv.clinicId, "BOOKING_REQUEST");
    if (level === "L3" || level === "L4") {
      const session = await prisma.bookingSession.create({
        data: {
          conversationId: conv.id,
          clinicId: conv.clinicId,
          slots: {},
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      });
      return await handleSessionTurn(session, msg, conv, clinic); // 觸發訊息本身就係第一輪
    }
    // L1/L2 → 跌落現有 draft/AUTO 行為
  }

  // ── 4. AI 草稿（鐵律：URGENT_PAIN / HIGH 永不生成 — code 層第一重擋） ─────
  // Phase 2b：needsHuman=true 都可以出 draft（staff 審批；AUTO 模式永遠唔會自動發）
  let draft: {
    id: string;
    draftText: string;
    status: string;
  } | null = null;
  const canDraft =
    result.intent !== "URGENT_PAIN" &&
    result.intent !== "COMPLAINT" && // ★ Phase C：投訴唔出 AI 草稿 — 呢啲說話要人講
    result.urgency !== "HIGH" &&
    result.draft !== null &&
    msg.type === "text"; // ★ AI Workflow T1 (A2)：媒體唔出草稿（只內部通知職員）
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
            // ★ Phase E（cwi-ai-20260825-t5）：per-draft intent 快照（統計「當時」值；歷史 row null → UNKNOWN）
            intent: result.intent,
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

  // ── 4.5 AUTO 模式 ─────
  // ★ Fix B（cwi-fix-20260825-f1）：自動覆資格由 resolver 決定（per intent），唔再直 key aiMode —
  //   儀表板逐類 L1/L2 先真正生效；〔全店降 L1〕panic（"*"→L1 policy）即真停自動覆。
  //   行為保證：冇 policy row 嘅店 = resolver fallback aiMode（AUTO→L2 / DRAFT→L1）→ byte 不變。
  //   bonus：AI_GLOBAL_MAX_LEVEL=L1 而家連 L2 自動覆都壓到（env kill 全覆蓋）。
  const win = getWindowState(updatedConv.lastInboundAt);
  let autoSent = false;
  const autoLevel = await getAutomationLevel(conv.clinicId, result.intent);
  if (clinic.aiMode === "AUTO" && autoLevel === "L1") {
    // 舊行為會自動發、新 policy 壓咗落 L1 — log 一次俾 debug（metadata only）
    log.info(
      { clinic: clinic.code, wamid: msg.waMessageId, intent: result.intent, reasons: "policy-L1" },
      "ai: AUTO mode — suppressed by AutomationPolicy L1 (draft only)"
    );
  }
  if (autoLevel !== "L1") {
    const blocks: string[] = [];
    if (result.intent === "URGENT_PAIN") blocks.push("URGENT_PAIN"); // 鐵律：code 第二重擋
    if (result.intent === "COMPLAINT") blocks.push("COMPLAINT");     // ★ Phase C：投訴絕不自動發（要人講）
    if (result.urgency === "HIGH") blocks.push("HIGH");             // 鐵律：code 第二重擋
    if (result.needsHuman) blocks.push("needsHuman");               // 鐵律：人工永遠唔自動發
    if (draft === null) blocks.push("no-draft");
    if (!win.open) blocks.push("window-closed");
    // ★ Phase A：真人接手 = AI 收聲（Send Lock 語義補完 — 有負責人只佢可發 WhatsApp；
    // messages/send route 有 423 擋人，AI auto-send 路徑一直冇呢重閘）
    if (updatedConv.assigneeId !== null) blocks.push("assigned");
    // RESOLVED 對話病人翻頭一句「唔該」唔應該觸發自動覆
    if (updatedConv.status === "RESOLVED") blocks.push("resolved");
    // ★ Phase A (A2)：媒體訊息 — 唔覆客、唔出草稿、只通知職員
    if (isMedia) blocks.push("media");
    // 可選第八閘：未 claim 但真人啱啱插咗嘴（冷靜期 — ★ Phase D：params 由 WorkflowDefinition
    // 「triage」ACTIVE row 讀（三級 fallback + fail-soft；env AI_HUMAN_COOLDOWN_MS 保留做底））
    const triageParams = await getParams("triage", conv.clinicId);
    const cooldownMs = triageParams.humanCooldownMs;
    const recentHuman = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        direction: "OUT",
        sentByStaffId: { not: null },
        channel: { not: "INTERNAL" }, // ★ INTERNAL 備註（assign/transfer 自動落）唔係「覆病人」— 唔觸發冷靜期
        waTimestamp: { gte: new Date(Date.now() - cooldownMs) },
      },
      select: { id: true },
    });
    if (recentHuman) blocks.push("human-recent");
    // ★ Phase D 第九閘：confidence 低過 floor → low-confidence（floor 由 triage params 校）
    if (result.confidence < triageParams.confidenceFloor) blocks.push("low-confidence");
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
    autoLevel,
    autoSent,
  });
  if (urgent) {
    // ★ AI Workflow T1 (A2)：急症升級持久化（離線 staff 漏咗 realtime toast 都唔漏）— commit-then-emit
    await prisma.staffNotice.create({
      data: {
        clinicId: conv.clinicId,
        conversationId: conv.id,
        kind: "URGENT_ESCALATION",
        title: "急症升級 — 病人劇痛/高危",
        meta: { wamid: msg.waMessageId, intent: result.intent, urgency: result.urgency },
      },
    });
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
      autoLevel,
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
      // cwi-window-20260901（P1）：AI 窗口內自動覆 = SERVICE（同人手窗口內回覆同類）
      billingCategory: "SERVICE",
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

// ── Phase C（cwi-sess-20260824-c1）：slot-filling session runner（C6.1）──────────────────
// 流程：最近 6 條 + roster → getSlots → classifySessionTurn（1 次 LLM）
//   → engine step（pure）→ patch → effects → replyText → sendSessionReply。
// PII 鐵律：log metadata only；零 reply 原文、零病人姓名。
async function handleSessionTurn(
  session: {
    id: string;
    conversationId: string;
    clinicId: string;
    status: string;
    slots: Prisma.JsonValue;
    turns: number;
    noProgress: number;
  },
  msg: { id: string; waMessageId: string | null; type: string; waTimestamp: Date },
  conv: {
    id: string;
    clinicId: string;
    contactId: string;
    aiSummary: string | null;
    pinnedPatientApricotId: string | null;
  },
  clinic: { id: string; code: string; name: string }
): Promise<Record<string, unknown>> {
  const sessionId = session.id;
  const slots0: SessionSlots = (session.slots as SessionSlots) ?? {};

  // 1. 最近 6 條 text 訊息 + 本店名單（含 apricotId）
  const recent = await prisma.message.findMany({
    where: { conversationId: conv.id, type: "text" },
    // 同秒 tie（mock-inbound/WhatsApp ts 秒級）→ createdAt 定序 — 否則 lastInbound 非確定，
    // e2e 實證 2026-08-25：同秒雙 IN → mock 分類錯訊息 → 時間選擇丟失
    orderBy: [{ waTimestamp: "desc" }, { createdAt: "desc" }],
    take: 6,
  });
  const recentMessages = [...recent].reverse().map((m) => ({
    direction: (m.direction === "IN" ? "IN" : "OUT") as "IN" | "OUT",
    body: m.body ?? "",
  }));
  const provRows = await prisma.providerClinic.findMany({
    where: { clinicId: conv.clinicId, provider: { active: true, apricotId: { not: null } } },
    include: { provider: true },
    orderBy: { provider: { name: "asc" } },
  });
  const providers = provRows.map((r) => ({ apricotId: r.provider.apricotId!, name: r.provider.name }));

  // 2. getSlots（四層降級照用）
  const slotsData = await getSlots(conv.clinicId);

  // 3. LLM（每條病人訊息一次 call）— 失敗：record + throw（BullMQ retry；
  //    retries 耗盡 = session 唔郁、唔覆 — 病人再講嘢會再觸發）
  const todayHk = hkToday();
  const level = await getAutomationLevel(conv.clinicId, "BOOKING_REQUEST");
  const allComplete = Boolean(slots0.providerApricotId && slots0.date && slots0.time);
  const hasPartial = Boolean(slots0.providerApricotId || slots0.date || slots0.time);
  const aiOut = await classifySessionTurn({
    todayHk,
    clinicName: clinic.name,
    providers,
    collected: slots0,
    pendingConfirm: session.status === "CONFIRMING" ? sessionConfirmLine(slots0) : null,
    candidateText: !allComplete && hasPartial ? sessionCandidateText(slots0, slotsData, providers) : null,
    recentMessages,
  }).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiCall(false, message);
    log.error({ sessionId, wamid: msg.waMessageId, err: message }, "session: LLM call failed — session 唔郁、唔覆（BullMQ retry）");
    throw err;
  });
  await recordAiCall(true);

  // 4. engine step（pure — 所有事實句喺度砌）
  // ★ Phase D：engine 保持 pure — params 由 runner 讀落（getParams 三級 fallback + fail-soft）
  const stepCtx: StepCtx = {
    todayHk,
    level: level === "L4" ? "L4" : "L3",
    providers,
    pinnedPatient: conv.pinnedPatientApricotId !== null,
    params: await getParams("booking-session", conv.clinicId),
  };
  const out = sessionStep(
    { slots: slots0, status: session.status, turns: session.turns, noProgress: session.noProgress },
    aiOut,
    slotsData,
    stepCtx
  );

  // 5. 落 patch
  await prisma.bookingSession.update({
    where: { id: sessionId },
    data: {
      slots: out.patch.slots as Prisma.InputJsonValue,
      status: out.patch.status as "ACTIVE" | "CONFIRMING" | "COMPLETED" | "HANDOFF" | "ABANDONED" | "CANCELLED",
      turns: out.patch.turns,
      noProgress: out.patch.noProgress,
    },
  });

  // ★ CEO 補充（總綱 §5.4）：首次轉 COMPLETED → deterministic PatientFact（零 LLM）
  if (session.status !== "COMPLETED" && out.patch.status === "COMPLETED") {
    await writeSessionPatientFacts({
      contactId: conv.contactId,
      clinicId: conv.clinicId,
      conversationId: conv.id,
      slots: out.patch.slots,
      slotsAi: aiOut,
      msg,
    });
  }

  // 6. effects 逐個執行
  let reply = out.replyText;
  for (const eff of out.effects) {
    switch (eff.kind) {
      case "NONE":
        break;
      case "NOTIFY_STAFF": {
        await prisma.staffNotice.create({
          data: {
            clinicId: conv.clinicId,
            conversationId: conv.id,
            kind: eff.noticeKind,
            title: eff.title,
            meta: { sessionId },
          },
        });
        publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: eff.noticeKind });
        break;
      }
      case "URGENT_ESCALATE": {
        // 同現有急症鏈一致：urgent 標 + StaffNotice + 實時 push（commit-then-emit）
        const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
        await prisma.conversation.update({ where: { id: conv.id }, data: { urgent: true } });
        await prisma.staffNotice.create({
          data: {
            clinicId: conv.clinicId,
            conversationId: conv.id,
            kind: "URGENT_ESCALATION",
            title: "急症升級 — 病人劇痛/高危（預約 session）",
            meta: { wamid: msg.waMessageId, sessionId },
          },
        });
        publishNotify(conv.clinicId, "urgent:escalation", {
          conversationId: conv.id,
          intent: "URGENT_PAIN",
          urgency: "HIGH",
          contactId: conv.contactId,
          contactName: contact?.profileName ?? null,
          waMessageId: msg.waMessageId,
        });
        break;
      }
      case "SEND_FLOW": {
        // 源離線兜底：Flow 純收需求變體接力（session 已 ABANDONED）；window 過/失敗 → log 咗止
        try {
          await sendBookingFlow({ conversationId: conv.id, staffId: null });
        } catch (err) {
          if (err instanceof WindowClosedError) {
            log.info({ sessionId, conversationId: conv.id }, "session: SEND_FLOW window closed — staff 手動發");
          } else {
            log.error(
              { sessionId, conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
              "session: SEND_FLOW failed — staff 手動發"
            );
          }
        }
        break;
      }
      case "CREATE_CARD":
      case "AUTO_BOOK": {
        // 冪等：一 session 一卡（flowToken unique）；AUTO_BOOK 重用同一卡
        let booking = await prisma.bookingRequest.findFirst({ where: { flowToken: `sess-${sessionId}` } });
        if (!booking) {
          const s = out.patch.slots;
          // engine 只喺 provider+date+time 齊先 COMPLETED — defense：缺欄唔建卡
          if (!s.providerApricotId || !s.providerName || !s.date || !s.time) {
            log.error({ sessionId, conversationId: conv.id }, "session: CREATE_CARD 缺 slot — skip（engine 異常）");
            break;
          }
          booking = await prisma.bookingRequest.create({
            data: {
              conversationId: conv.id,
              clinicId: conv.clinicId,
              flowToken: `sess-${sessionId}`,
              providerApricotId: s.providerApricotId,
              providerName: s.providerName,
              requestedDate: s.date,
              requestedTime: s.time,
              precheckPassed: true,
              timeOfDay: null,
              chiefComplaint: conv.aiSummary?.slice(0, 50) ?? null,
            },
          });
        }
        if (eff.kind === "CREATE_CARD") {
          // 同 flow-reply 建卡後語義一致 — commit-then-emit
          publishNotify(conv.clinicId, "booking:new", {
            conversationId: conv.id,
            clinicId: conv.clinicId,
            booking: {
              id: booking.id,
              providerName: booking.providerName,
              requestedDate: booking.requestedDate,
              requestedTime: booking.requestedTime,
              timeOfDay: booking.timeOfDay,
              precheckPassed: booking.precheckPassed,
              status: booking.status,
              createdAt: booking.createdAt,
            },
          });
          break;
        }
        // AUTO_BOOK：confirm-core（失敗永不自動重試 — 鐵律）
        if (booking.status !== "PENDING") break; // 重跑 job：已確認 → 唔重複落單
        const r = await confirmBookingCore(booking.id, { type: "AI", sessionId });
        if (r.ok) {
          // L4 自動落單成功：staff 通知（title 用 booking 欄砌，零病人資料）
          const m = booking.requestedDate.split("-");
          const title = `AI 已自動落單 ${Number(m[1])}月${Number(m[2])}日 ${booking.requestedTime ?? ""} ${booking.providerName ?? ""}`
            .replace(/\s+/g, " ")
            .trim();
          await prisma.staffNotice.create({
            data: {
              clinicId: conv.clinicId,
              conversationId: conv.id,
              kind: "BOOKING_AUTO",
              title,
              meta: { sessionId, bookingId: booking.id },
            },
          });
          publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: "BOOKING_AUTO" });
        } else {
          // 失敗：booking 保持 PENDING 卡 + 人手接手通知 + 病人中性感（唔講失敗原因）
          await prisma.staffNotice.create({
            data: {
              clinicId: conv.clinicId,
              conversationId: conv.id,
              kind: "HANDOFF_REQUEST",
              title: `AI 自動落單失敗（${r.kind}）— 請人手處理`,
              meta: { sessionId, bookingId: booking.id },
            },
          });
          publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: "HANDOFF_REQUEST" });
          if (reply === null) reply = "收到！職員會好快幫你確認 🙂";
        }
        break;
      }
    }
  }

  // 7. replyText 非 null → sendSessionReply（行現有 outbound pipeline）
  if (reply !== null) {
    await sendSessionReply(sessionId, conv, reply, aiOut.action);
  }

  // 8. log metadata only（零 reply 原文、零病人姓名）
  log.info(
    {
      sessionId,
      status: out.patch.status,
      turns: out.patch.turns,
      action: aiOut.action,
      effects: out.effects.map((e) => e.kind),
      level: stepCtx.level,
    },
    "session: turn processed"
  );

  return { ok: true, session: sessionId, status: out.patch.status, effects: out.effects.map((e) => e.kind) };
}

/**
 * Session 回覆（C6.2）— 照 attemptAutoSend 個殼：
 * Message OUT（aiDraftId=null、bookingSessionId、aiAutoSent=true）+ outbound enqueue + enqueue fail 降級。
 * 冪等：同一 session 對同條訊息（waTimestamp ≥）已發過回覆 → skip（BullMQ retry 防雙發）。
 */
/**
 * ★ MD C6.2：session reply — 照 attemptAutoSend 個殼（Message OUT + outbound enqueue + enqueue fail 降級）。
 * 冪等：job 級 jobId=`ai-${messageId}` 已保證同一訊息唔會處理兩次 — 唔做 DB 級 dedup
 *（timestamp-range dedup 會誤殺同一秒內兩條 IN 訊息嘅第二條回覆 — e2e 實證 2026-08-25，WhatsApp ts 係秒級）。
 * enqueue fail → 唔重試，session 照 patch（病人下條訊息自然接力）。
 */
async function sendSessionReply(
  sessionId: string,
  conv: { id: string },
  text: string,
  action: string
): Promise<string | null> {
  const now = new Date();
  try {
    const outMsg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: text,
        status: "QUEUED",
        sentByStaffId: null,
        aiAutoSent: true,
        bookingSessionId: sessionId,
        // cwi-window-20260901（P1）：session 回覆（窗口內）= SERVICE
        billingCategory: "SERVICE",
        waTimestamp: now,
      },
    });
    await Promise.race([
      outboundQueue.add("send", { messageId: outMsg.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), 1500)),
    ]);
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: "AI_SESSION_REPLY",
          entity: "Message",
          entityId: outMsg.id,
          // metadata only：sessionId + action（零 reply 原文）
          meta: { conversationId: conv.id, sessionId, action },
        },
      })
      .catch(() => undefined);
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    return outMsg.id;
  } catch (err) {
    // enqueue fail → 唔重試，session 照 patch（病人下條訊息自然接力）
    log.error(
      { sessionId, conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "session: reply enqueue failed（session 照常）"
    );
    return null;
  }
}

/**
 * ★ CEO 補充（總綱 §5.4）：PatientFact v1 deterministic 抽取（零 LLM）。
 * session 首次轉 COMPLETED 時寫固定模板 PREFERENCE fact：
 * - preferred provider 有值 →「預約偏好：{醫生名}」（roster 全名 = business metadata）
 * - timeOfDay 有值 →「時段偏好：{朝早/下晝/晚上}」
 * 零病人姓名/電話；sourceMessageId = 提供該 slot 嘅 IN 訊息（跟唔到 → 該場之前最後一條 IN text）；
 * 冪等：同 contact+clinic+kind+text 已存在 → skip。
 */
async function writeSessionPatientFacts(opts: {
  contactId: string;
  clinicId: string;
  conversationId: string;
  slots: SessionSlots;
  slotsAi: { slotUpdates: SessionSlots };
  msg: { id: string; waMessageId: string | null; waTimestamp: Date };
}): Promise<void> {
  const prior = await prisma.message.findFirst({
    where: { conversationId: opts.conversationId, direction: "IN", type: "text", waTimestamp: { lt: opts.msg.waTimestamp } },
    orderBy: [{ waTimestamp: "desc" }, { createdAt: "desc" }],
    select: { id: true, waMessageId: true },
  });
  const fallback = { id: prior?.id ?? opts.msg.id, wamid: prior?.waMessageId ?? opts.msg.waMessageId };
  const srcOf = (fresh: string | null | undefined) => (fresh ? { id: opts.msg.id, wamid: opts.msg.waMessageId } : fallback);

  const facts: { text: string; src: { id: string; wamid: string | null } }[] = [];
  if (opts.slots.providerName) {
    facts.push({ text: `預約偏好：${opts.slots.providerName}`, src: srcOf(opts.slotsAi.slotUpdates.providerName) });
  }
  if (opts.slots.timeOfDay) {
    const tod = { MORNING: "朝早", AFTERNOON: "下晝", EVENING: "晚上" } as const;
    facts.push({ text: `時段偏好：${tod[opts.slots.timeOfDay]}`, src: srcOf(opts.slotsAi.slotUpdates.timeOfDay) });
  }
  if (facts.length === 0) return;

  for (const f of facts) {
    const existing = await prisma.patientFact.findFirst({
      where: { contactId: opts.contactId, clinicId: opts.clinicId, kind: "PREFERENCE", text: f.text },
      select: { id: true },
    });
    if (existing) continue; // 冪等
    await prisma.patientFact.create({
      data: {
        contactId: opts.contactId,
        clinicId: opts.clinicId,
        kind: "PREFERENCE",
        text: f.text,
        sourceMessageId: f.src.id,
        sourceWamid: f.src.wamid,
        model: null, // deterministic 抽（零 LLM）
      },
    });
  }
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
