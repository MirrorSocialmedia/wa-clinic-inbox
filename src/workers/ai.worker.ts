import { Worker, type Job } from "bullmq";
import { aiQueue, enqueueOutboundSend, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { AI_CONCURRENCY } from "./concurrency";
import log from "@/lib/log";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { publishNotify } from "@/lib/notify";
import { getWindowState } from "@/lib/wa/window";
import {
  classifyAndDraft,
  classifySessionTurn,
  classifyPainTurn,
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
import { getParams, getActiveInfo } from "@/lib/workflow/store";
import { fillVars } from "@/lib/workflow/definitions";

import { pickKnowledge, knowledgePromptBlock, matchPriceDocs } from "@/lib/knowledge/retrieve";
import { getKnowledgeCatalog, type CatalogDoc } from "@/lib/knowledge/catalog";
import { isPriceIntent, buildPriceDraft, runPriceGuard, NO_PRICE_TEXT } from "@/lib/ai/price-guard";
// ★ Part E（cwi-paintriage-20260903）：PAIN_TRIAGE 痛症分流（E.2 fast path / E.3 session / E.4 紅旗 / E.7 術後 / E.8 lexicon）
import { getLexicon, applyLexicon } from "@/lib/sessions/lexicon";
import { matchRedFlagTerms, effectiveRedFlagTerms } from "@/lib/sessions/red-flags";
import { painStep, parsePainState, PAIN_SESSION_TTL_MS } from "@/lib/sessions/pain-triage";
import { phoneHash } from "@/lib/phone-hash";
import { hkDateOffset } from "@/lib/availability";
import { lookupPatient, fetchAppointments } from "@/lib/workforce/client";
import { sendBookingFlow, WindowClosedError } from "@/lib/flows/send";

// ★ Part F（cwi-raggolden-20260904，F.7）：lexicon 命中詞（trace 用 — 只記 raw term，零 PII 風險：詞表係 staff 配置）
function lexiconHits(lex: { term: string; canonical: string }[], text: string | null): string[] {
  if (!text || lex.length === 0) return [];
  const out: string[] = [];
  for (const e of lex) {
    if (e.term === e.canonical) continue;
    if (text.includes(e.term)) out.push(e.term);
  }
  return out;
}

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
        // ★ Part F（cwi-raggolden-20260904，T128）：相片只做 signal — AI 唔判斷相片內容，卡標「有相待人手睇」
        title: `病人傳送咗${msg.type === "image" ? "相片" : "檔案"} — 有相待人手睇（AI 唔判斷相片內容）`,
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

  // ── ★ Part E（cwi-paintriage-20260903，E.3）：痛症問診 session 分流（同 Phase C booking session 模式）──
  // active PAIN_TRIAGE session → handlePainTriageTurn；真人接手 = session 即讓路
  const activePainSession = await prisma.painTriageSession.findFirst({
    where: { conversationId: conv.id, status: "ACTIVE", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (activePainSession) {
    if (conv.assigneeId !== null) {
      // 真人接手 = session 即讓路（同七閘 assigned 語義一致）
      await prisma.painTriageSession.update({
        where: { id: activePainSession.id },
        data: { status: "HANDOFF", closeReason: "HANDOFF" },
      });
      log.info(
        { painSessionId: activePainSession.id, conversationId: conv.id },
        "pain-triage: staff claimed → HANDOFF（讓路，跌落普通 classify）"
      );
    } else if (msg.type !== "text") {
      // 媒體訊息：Phase A 通知照出（上面已行），session 唔郁、唔覆
      return { ok: true, painSession: activePainSession.id, skipped: "media-in-pain-session" };
    } else {
      return await handlePainTriageTurn(activePainSession, msg, conv, clinic);
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

  // ── ★ Part F（cwi-raggolden-20260904，F.3）：RAG 兩階段檢索 — 階段一（選 id）喺 classify 前 ──
  //   只對 text 觸發訊息；**fail-soft：任何失敗 → picked=[] 照出草稿**（pickKnowledge 零 throw，catch 兜底）。
  const knowledge =
    msg.type === "text" && msg.body
      ? await pickKnowledge({
          clinicId: conv.clinicId,
          question: msg.body,
          context: ctxMessages
            .slice(0, -1) // 觸發訊息本身唔入 context
            .map((m) => m.body)
            .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
            .slice(-3),
        }).catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "knowledge: fail-soft — 跳過 RAG");
          return { ran: false, picked: [], discarded: 0, skipped: "fail-soft", latencyMs: 0 };
        })
      : { ran: false, picked: [], discarded: 0, skipped: "media", latencyMs: 0 };

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
      // ★ Part F（F.3）：`<knowledge>` 段（擺事實段之後、對話歷史之前；連 title 方便 trace）
      knowledgeBlock: knowledgePromptBlock(knowledge.picked),
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

  // ★ Part E（cwi-paintriage-20260903，E.2）：確定性紅旗 fast path — 訊息本身含 FLOOR ∪ params 紅旗詞
  //   （lexicon canonical 化後）→ 直升 URGENT_PAIN（fast path 唔問診；E.4 同一份詞表；LLM 只抽槽唔判級）。
  //   喺 COMPLAINT 通知之前行 — 紅旗 recall 優先（投訴文含紅旗詞 → 紅旗勝）。
  const ptLex = msg.type === "text" && msg.body ? await getLexicon(conv.clinicId) : [];
  const ptParams = await getParams("pain-triage", conv.clinicId);
  if (msg.type === "text" && msg.body) {
    const rf = matchRedFlagTerms([applyLexicon(msg.body, ptLex)], ptParams);
    if (rf.hit && result.intent !== "URGENT_PAIN") {
      log.info(
        { clinic: clinic.code, wamid: msg.waMessageId, categories: rf.categories, terms: rf.terms },
        "pain-triage: fast-path red flag (deterministic) → URGENT_PAIN"
      );
      result = { ...result, intent: "URGENT_PAIN", urgency: "HIGH", needsHuman: true, draft: null };
    }
  }

  // ── ★ Part F（cwi-raggolden-20260904，F.4）：報價鏈 + price-guard（deterministic）──────────
  //   報價鏈：intent=QUESTION 且 lexicon normalize 後命中價錢意圖 → 檢索優先 PRICE 其次 SERVICE：
  //   有 PRICE doc → 決定性報價（範圍 + 影響因素 + disclaimer code 強制）；無 → 唔准報價（人手提示 + needsHuman）。
  //   price-guard：草稿定稿後、入庫前 3 條 deterministic 檢查（① 零引用幻覺價 ② 漏 disclaimer 自動補 ③ 金額出範圍）。
  //   純決定性層 — mock/real 同一行為；PAIN/URGENT/COMPLAINT（draft null）唔入呢段。
  const priceTrace: {
    triggered: boolean;
    docId: string | null;
    guard: { blocked: boolean; disclaimerAppended: boolean; outOfRange: boolean };
  } = { triggered: false, docId: null, guard: { blocked: false, disclaimerAppended: false, outOfRange: false } };
  let citedPriceDoc: CatalogDoc | null = knowledge.picked.find((d) => d.kind === "PRICE") ?? null;
  if (msg.type === "text" && msg.body && result.intent === "QUESTION" && result.draft !== null) {
    const priceIntent = isPriceIntent(applyLexicon(msg.body, ptLex));
    priceTrace.triggered = priceIntent;
    if (priceIntent) {
      if (!citedPriceDoc) {
        // stage 1 冇揀到 PRICE → PRICE 目錄 keyword match 撳底（code 層、零 LLM）
        const catalog = await getKnowledgeCatalog(conv.clinicId);
        citedPriceDoc = matchPriceDocs(catalog, applyLexicon(msg.body, ptLex))[0] ?? null;
      }
      if (citedPriceDoc) {
        priceTrace.docId = citedPriceDoc.id;
        const built = buildPriceDraft(citedPriceDoc);
        if (built.text) {
          result = { ...result, draft: built.text };
        } else {
          // PRICE doc 冇 priceMin/Max → 唔出範圍（唔准報價）
          result = { ...result, draft: NO_PRICE_TEXT, needsHuman: true };
        }
      } else {
        log.info({ clinic: clinic.code, wamid: msg.waMessageId }, "price: no PRICE doc — 唔准報價（轉人手）");
        result = { ...result, draft: NO_PRICE_TEXT, needsHuman: true };
      }
    }
    // trace：本輪 citation 咗邊條 PRICE doc（有即記錄 — 不論報價鏈有冇觸發）
    if (citedPriceDoc) priceTrace.docId = citedPriceDoc.id;
    // price-guard（deterministic — 草稿生成後入庫前）
    const guard = runPriceGuard({ draft: result.draft, priceDoc: citedPriceDoc, priceIntent });
    priceTrace.guard = { blocked: guard.blocked, disclaimerAppended: guard.disclaimerAppended, outOfRange: guard.outOfRange };
    if (guard.blocked) {
      result = { ...result, draft: guard.draft, needsHuman: true };
    } else if (guard.disclaimerAppended) {
      result = { ...result, draft: guard.draft };
    }
  }

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

  // ── cwi-window-20260901（P2）：窗口狀態（W-2）──
  // 過窗：AI 草稿照生成但 mode=COPY_ONLY（UI 只准複製）；C6 session 唔開（session reply = 自動覆，
  // 過窗發唔出 → 避免一堆 FAILED outbound）；AUTO 自動覆本就有 window-closed 閘（下方 blocks）。
  const win = getWindowState(updatedConv.lastInboundAt);

  // ── C6：L3+ 開 session（BOOKING_REQUEST + 無人接手 + 文字訊息 + ★ P2：窗口內）──
  // 無 AutomationPolicy row 嘅店 = legacy L1/L2 → 一行都唔改（跌落現有 draft/AUTO）
  if (
    win.open && // cwi-window-20260901（P2）：過窗唔開 session（session reply 係自動覆 — 發唔出）
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

  // ── ★ Part E（cwi-paintriage-20260903，E.2/E.3）：PAIN intent（無紅旗詞）→ 開 PAIN_TRIAGE 問診 session ──
  //   觸發訊息 = 第一輪（同 booking session 模式）。P-4：出口固定 L1 草稿俾 staff 發（唔受 AutomationPolicy
  //   level 控制 — 無紅旗出口唔係自動動作）；over-window 唔開（session reply 係自動覆 — 發唔出，同 C6 同語義）。
  if (
    win.open &&
    result.intent === "PAIN" &&
    msg.type === "text" &&
    updatedConv.assigneeId === null &&
    !activePainSession
  ) {
    // E.7 術後自動判（fail-soft 零 throw：無 waId / 索引未 build / 無 match / fail → false + 問診 fallback）
    const autoPostOp = await resolveAutoPostOp(conv, contact, clinic, ptParams.postOpWindowDays);
    const session = await prisma.painTriageSession.create({
      data: {
        conversationId: conv.id,
        clinicId: conv.clinicId,
        autoPostOp,
        slots: { slots: {}, asked: [] } as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + PAIN_SESSION_TTL_MS),
      },
    });
    return await handlePainTriageTurn(session, msg, conv, clinic);
  }

  // ── 4. AI 草稿（鐵律：URGENT_PAIN / HIGH 永不生成 — code 層第一重擋） ─────
  // Phase 2b：needsHuman=true 都可以出 draft（staff 審批；AUTO 模式永遠唔會自動發）
  let draft: {
    id: string;
    draftText: string;
    status: string;
    /** cwi-window-20260901（P2）：NORMAL（窗口內）/ COPY_ONLY（過窗 — UI 只准複製） */
    mode: string;
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
            // cwi-window-20260901（P2 / W-2）：過窗草稿 = COPY_ONLY（內容有用但發唔出 — UI 只准複製去 App）
            mode: win.open ? "NORMAL" : "COPY_ONLY",
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
  let autoSent = false;
  const autoLevel = await getAutomationLevel(conv.clinicId, result.intent);
  if (clinic.aiMode === "AUTO" && autoLevel === "L1") {
    // 舊行為會自動發、新 policy 壓咗落 L1 — log 一次俾 debug（metadata only）
    log.info(
      { clinic: clinic.code, wamid: msg.waMessageId, intent: result.intent, reasons: "policy-L1" },
      "ai: AUTO mode — suppressed by AutomationPolicy L1 (draft only)"
    );
  }
  // ★ Part F（F.7）：trace gates 用 — autoLevel=L1 時 blocks 固定 ["policy-L1"]（舊行為等價）
  const blocks: string[] = autoLevel === "L1" ? ["policy-L1"] : [];
  if (autoLevel !== "L1") {
    if (result.intent === "URGENT_PAIN") blocks.push("URGENT_PAIN"); // 鐵律：code 第二重擋
    if (result.intent === "COMPLAINT") blocks.push("COMPLAINT");     // ★ Phase C：投訴絕不自動發（要人講）
    if (result.urgency === "HIGH") blocks.push("HIGH");             // 鐵律：code 第二重擋
    if (result.needsHuman) blocks.push("needsHuman");               // 鐵律：人工永遠唔自動發
    // ★ Part F（cwi-raggolden-20260904，F.3）：L2 自動覆前提 — 價錢問題（priceIntent）有引用先准自動覆，
    //   零引用強制降 L1（轉人手）。範圍 = priceIntent：「無引用唔准自動覆」嘅風險集中喺價錢聲稱（幻覺價）；
    //   非價錢 QUESTION 維持 F 前行為（W1/W4 golden 回歸「牙唔啱食嘢」零引用自動覆必須綠 — 七閘+回歸硬要求）。
    //   priceTrace.triggered = priceIntent；docId = 本輪最終 citation 咗嘅 PRICE doc（stage1 揀 ∪ code keyword fallback）。
    if (result.intent === "QUESTION" && priceTrace.triggered && !priceTrace.docId) blocks.push("no-knowledge-citation");
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
  // ★ Part F（cwi-raggolden-20260904，F.7）：trace panel — 每輪寫入 traceJson（gates/lexicon/檢索/price/latency）。
  let trace: Record<string, unknown> | null = null;
  if (draft) {
    try {
      const triageInfo = await getActiveInfo("triage", conv.clinicId);
      trace = {
        workflow: "triage",
        paramsVersion: { triage: triageInfo.version || "defaults", triageSource: triageInfo.source },
        gates: { autoLevel, blocks, autoSent, mode: win.open ? "NORMAL" : "COPY_ONLY" },
        lexicon: { hits: lexiconHits(ptLex, msg.body) },
        knowledge: {
          ran: knowledge.ran,
          skipped: knowledge.skipped,
          discarded: knowledge.discarded,
          latencyMs: knowledge.latencyMs,
          picked: knowledge.picked.map((d) => ({ id: d.id, title: d.title, kind: d.kind })),
        },
        impression: null,
        price: priceTrace,
        latencyMs: result.latencyMs,
      };
      await prisma.aiDraft.update({
        where: { id: draft.id },
        data: { traceJson: trace as Prisma.InputJsonValue },
      });
    } catch (err) {
      // fail-soft：trace 寫失敗唔阻 draft 流程（trace 係可观测性，非業務數據）
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "trace: write failed（fail-soft）");
      trace = null;
    }
  }
  if (draft && draft.status === "PROPOSED" && !autoSent) {
    publishNotify(conv.clinicId, "draft:ready", {
      conversationId: conv.id,
      draftId: draft.id,
      inReplyToMessageId: msg.id,
      draftText: draft.draftText,
      model: result.model,
      latencyMs: result.latencyMs,
      // cwi-window-20260901（P2）：COPY_ONLY 草稿 → UI banner + 複製掣（採用/發送 disable）
      mode: draft.mode,
      // ★ Part F（F.7）：trace panel 數據源（UI 可展開段）
      traceJson: trace,
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
      enqueueOutboundSend(outMsg.id),
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
  action: string,
  // ★ Part E（cwi-paintriage-20260903）：pain session 共用同一 outbound 殼 — bookingSessionId=null + 獨立 audit action
  opts?: { bookingSessionId?: string | null; auditAction?: string; logTag?: string }
): Promise<string | null> {
  const bookingSessionId = opts?.bookingSessionId === null ? null : (opts?.bookingSessionId ?? sessionId);
  const auditAction = opts?.auditAction ?? "AI_SESSION_REPLY";
  const tag = opts?.logTag ?? "session";
  // cwi-window-20260901（P2 / W-2）：過窗 → session reply 發唔出（會變 FAILED outbound）— skip 呢輪，
  // session 照常（病人下條 inbound 會重新開窗接力）。
  const freshConv = await prisma.conversation.findUnique({
    where: { id: conv.id },
    select: { lastInboundAt: true },
  });
  if (!getWindowState(freshConv?.lastInboundAt).open) {
    log.warn({ sessionId, conversationId: conv.id }, `${tag}: reply skipped — window closed（無 outbound）`);
    return null;
  }
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
        bookingSessionId,
        // cwi-window-20260901（P1）：session 回覆（窗口內）= SERVICE
        billingCategory: "SERVICE",
        waTimestamp: now,
      },
    });
    await Promise.race([
      enqueueOutboundSend(outMsg.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), 1500)),
    ]);
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: auditAction,
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
      `${tag}: reply enqueue failed（session 照常）`
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

// ── ★ Part E（cwi-paintriage-20260903）：PAIN_TRIAGE 痛症問診 runner ──────────────────
// 跟 handleSessionTurn 模式：最近 IN text → classifyPainTurn（LLM 只抽槽唔判級）
//   → painStep（pure — 即行 evaluateRedFlags，中即終止）→ patch → effects → replyText。
// PII 鐵律：log metadata only；slots = 症狀 business metadata（零病人自由文本）；reply 原文零 log。

/**
 * E.7 術後自動判（開波 hook）：phoneHash match → 近 postOpWindowDays 有本店治療記錄 → true（即紅旗）。
 * fail-soft 零 throw：無 waId / PHONE_HASH_KEY 未設 / workforce 離線 / 無 match / appointments fail → false（問診 fallback）。
 */
async function resolveAutoPostOp(
  conv: { id: string },
  contact: { waId: string | null } | null,
  clinic: { code: string },
  windowDays: number
): Promise<boolean> {
  try {
    if (!contact?.waId) return false;
    const hash = phoneHash(contact.waId);
    const lk = await lookupPatient(hash);
    if (!lk.matches || lk.matches.length === 0) return false; // 索引未 build / 無 match
    const ids = new Set(lk.matches.map((m) => m.patientApricotId));
    const appts = await fetchAppointments(hash, hkDateOffset(-windowDays), hkDateOffset(0));
    const hit = appts.appointments.some(
      (a) => ids.has(a.patientApricotId) && a.clinicCode === clinic.code
    );
    if (hit) {
      log.info(
        { clinic: clinic.code, conversationId: conv.id, days: windowDays },
        "pain-triage: auto post-op hit"
      );
    }
    return hit;
  } catch (err) {
    log.warn(
      { clinic: clinic.code, conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "pain-triage: post-op check degraded → false（問診 fallback）"
    );
    return false;
  }
}

async function handlePainTriageTurn(
  session: {
    id: string;
    conversationId: string;
    clinicId: string;
    status: string;
    slots: Prisma.JsonValue;
    turns: number;
    noProgress: number;
    autoPostOp: boolean;
  },
  msg: { id: string; waMessageId: string | null; type: string; waTimestamp: Date; aiDraftId: string | null },
  conv: { id: string; clinicId: string; contactId: string; aiSummary: string | null },
  clinic: { id: string; code: string; name: string }
): Promise<Record<string, unknown>> {
  const sessionId = session.id;
  const state0 = parsePainState(session.slots);
  const ptParams = await getParams("pain-triage", conv.clinicId);
  const lex = await getLexicon(conv.clinicId);

  // 1. 最近 6 條 IN text（canonical = lexicon 正規化後 — 紅旗 match；原文 — impression 主訴，見 lexicon.ts 註）
  const recent = await prisma.message.findMany({
    where: { conversationId: conv.id, direction: "IN", type: "text" },
    // 同秒 tie → createdAt 定序（同 booking session 嘅非確定性修）
    orderBy: [{ waTimestamp: "desc" }, { createdAt: "desc" }],
    take: 6,
  });
  const recentIn = [...recent].reverse().map((m) => m.body ?? "");
  const rawTexts = recentIn.map((t) => applyLexicon(t, lex));

  // 2. LLM 抽槽（每條病人訊息一次 call）— 失敗：record + throw（BullMQ retry；session 唔郁、唔覆）
  const aiOut = await classifyPainTurn({
    todayHk: hkToday(),
    clinicName: clinic.name,
    collected: state0.slots,
    recentIn,
    redFlagTerms: effectiveRedFlagTerms(ptParams),
    lexicon: lex,
  }).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiCall(false, message);
    log.error(
      { painSessionId: sessionId, wamid: msg.waMessageId, err: message },
      "pain-triage: LLM call failed — session 唔郁、唔覆（BullMQ retry）"
    );
    throw err;
  });
  await recordAiCall(true);

  // 3. engine step（pure — 紅旗即行、中即終止）
  const out = painStep(
    { state: state0, status: session.status, turns: session.turns, noProgress: session.noProgress },
    aiOut,
    { params: ptParams, rawTexts, autoPostOp: session.autoPostOp }
  );

  // 4. 落 patch
  await prisma.painTriageSession.update({
    where: { id: sessionId },
    data: {
      slots: { slots: out.patch.state.slots, asked: out.patch.state.asked } as Prisma.InputJsonValue,
      status: out.patch.status,
      turns: out.patch.turns,
      noProgress: out.patch.noProgress,
      closeReason: out.patch.closeReason,
      impression: out.patch.impression,
    },
  });

  // 5. effects 逐個執行
  const reply = out.replyText;
  for (const eff of out.effects) {
    switch (eff.kind) {
      case "NONE":
        break;
      case "URGENT_ESCALATE": {
        // P-8：中紅旗 = 現有 URGENT 全套（紅標 + StaffNotice + urgent:escalation + AI 收聲）— 鐵律零改動
        const c = await prisma.contact.findUnique({ where: { id: conv.contactId } });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { urgent: true, intent: "URGENT_PAIN", urgency: "HIGH" },
        });
        await prisma.staffNotice.create({
          data: {
            clinicId: conv.clinicId,
            conversationId: conv.id,
            kind: "URGENT_ESCALATION",
            // {categories} = engine 命中類（business metadata — 零病人原文）
            title: fillVars(ptParams.urgentInternalNote, { categories: eff.categories.join("/") }),
            meta: { wamid: msg.waMessageId, painSessionId: sessionId, categories: eff.categories },
          },
        });
        publishNotify(conv.clinicId, "urgent:escalation", {
          conversationId: conv.id,
          intent: "URGENT_PAIN",
          urgency: "HIGH",
          contactId: conv.contactId,
          contactName: c?.profileName ?? null,
          waMessageId: msg.waMessageId,
        });
        break;
      }
      case "NOTIFY_STAFF": {
        await prisma.staffNotice.create({
          data: {
            clinicId: conv.clinicId,
            conversationId: conv.id,
            kind: "HANDOFF_REQUEST",
            title: eff.title,
            meta: { painSessionId: sessionId },
          },
        });
        publishNotify(conv.clinicId, "notice:new", { conversationId: conv.id, kind: "HANDOFF_REQUEST" });
        break;
      }
      case "CREATE_DRAFT": {
        // 出口 E.5：L1 草稿俾 staff 發（P-4：唔自動入 booking session）；冪等同主流程（unique + 前置查）
        let existing = await prisma.aiDraft.findUnique({
          where: { conversationId_inReplyToMessageId: { conversationId: conv.id, inReplyToMessageId: msg.id } },
        });
        if (!existing) {
          try {
            const freshConv = await prisma.conversation.findUnique({
              where: { id: conv.id },
              select: { lastInboundAt: true },
            });
            // ★ Part F（cwi-raggolden-20260904，F.7）：痛症出口草稿亦寫 trace（workflow=pain-triage + impression key）
            let painTrace: Record<string, unknown> | null = null;
            try {
              const ptInfo = await getActiveInfo("pain-triage", conv.clinicId);
              painTrace = {
                workflow: "pain-triage",
                paramsVersion: { "pain-triage": ptInfo.version || "defaults", painTriageSource: ptInfo.source },
                gates: { autoLevel: "L1", blocks: ["pain-l1"], autoSent: false },
                lexicon: { hits: [] },
                knowledge: { ran: false, skipped: "pain-exit", discarded: 0, latencyMs: 0, picked: [] },
                impression: out.patch.impression ?? null,
                price: { triggered: false, docId: null, guard: { blocked: false, disclaimerAppended: false, outOfRange: false } },
                latencyMs: 0,
              };
            } catch {
              painTrace = null; // fail-soft
            }
            existing = await prisma.aiDraft.create({
              data: {
                conversationId: conv.id,
                inReplyToMessageId: msg.id,
                draftText: eff.draftText,
                model: "pain-triage-engine", // deterministic — 零 LLM
                latencyMs: 0,
                intent: "PAIN",
                mode: getWindowState(freshConv?.lastInboundAt).open ? "NORMAL" : "COPY_ONLY",
                ...(painTrace ? { traceJson: painTrace as Prisma.InputJsonValue } : {}),
              },
            });
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
              existing = await prisma.aiDraft.findUnique({
                where: { conversationId_inReplyToMessageId: { conversationId: conv.id, inReplyToMessageId: msg.id } },
              });
            } else {
              throw err;
            }
          }
        }
        if (existing && msg.aiDraftId !== existing.id) {
          await prisma.message.update({ where: { id: msg.id }, data: { aiDraftId: existing.id } });
        }
        break;
      }
    }
  }

  // 6. 出口（非紅旗 COMPLETED）：AI 分析側欄 = triage 結構化摘要（deterministic — 零 LLM）
  if (out.patch.status === "COMPLETED" && out.patch.closeReason !== "RED_FLAG") {
    const s = out.patch.state.slots;
    const parts: string[] = [];
    if (s.toothLocation) parts.push(s.toothLocation);
    if (s.severity !== null) parts.push(`痛級 ${s.severity}/10`);
    if (s.durationDays !== null) parts.push(`痛咗 ${s.durationDays} 日`);
    if (out.patch.impression) parts.push(`傾向 ${out.patch.impression}`);
    const c = await prisma.contact.findUnique({ where: { id: conv.contactId } });
    const summary = scrubAiSummary(`痛症問診：${parts.join("、") || "資料未齊"}`, {
      profileName: c?.profileName,
      waId: c?.waId,
    }).slice(0, 50);
    await prisma.conversation.update({ where: { id: conv.id }, data: { aiSummary: summary } });
  }

  // 7. replyText 非 null → 共用 session reply 殼（bookingSessionId=null；過窗 skip 喺殼內）
  if (reply !== null) {
    await sendSessionReply(sessionId, conv, reply, aiOut.action, {
      bookingSessionId: null,
      auditAction: "AI_PAIN_SESSION_REPLY",
      logTag: "pain-triage",
    });
  }

  // 8. log metadata only（零 reply 原文、零病人姓名）
  log.info(
    {
      painSessionId: sessionId,
      status: out.patch.status,
      turns: out.patch.turns,
      action: aiOut.action,
      effects: out.effects.map((e) => e.kind),
    },
    "pain-triage: turn processed"
  );

  return { ok: true, painSession: sessionId, status: out.patch.status };
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
