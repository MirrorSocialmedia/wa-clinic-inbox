/**
 * ★ cwi-hubaudit-20260915（H-2 共用 pipeline）：worker 同沙盤共用嘅 inbound AI 組裝/執行層。
 *
 * 鐵律（MD §B.3.1）：走真 pipeline **同一套 function**；mode 分支只准喺持久化同發送層。
 *
 * 本檔內容：
 * - `buildAiContext`（S1）— 對話歷史 → AiContextMessage[] 嘅**唯一**組裝點（H-1 根源修復）：
 *   觸發訊息（當前句）**喺** context 內（worker 口徑 — 佢已喺 DB，ctxMessages 包含佢）；
 *   只冇觸發訊息嘅舊 context（例如 RAG 嘅 `context` 參數）先由 caller 自攞 `.slice(0, -1)`。
 *   H-1 事故根源：沙盤把 RAG 嗰個 `.slice(0, -1)` 誤套落 ctxMessages 本身 → 第一輪零輸入無草稿、
 *   第二輪答上一輪。
 * - `runInboundAi` + `PersistPort`（S4 / H-2）— worker 同沙盤共同嘅**計算核心**：
 *   RAG 檢索 → classify → red flag fast path → consult trigger → 報價鏈 → COMPLAINT 通知 →
 *   窗口 → 分類落 Conversation → 規則路由 → consult engine turn → consult LLM turn（+price/claim
 *   guard）→ canDraft/draftMode → AUTO level + blocks。
 *   所有持久化/發送點全部經 `PersistPort`（**唯一 mode 分岔點**）：
 *   - `livePersistPort`（worker）：真 DB 寫 / StaffNotice / socket / recordAiCall / AuditLog —
 *     每段都係原 ai.worker.ts 代碼逐字搬入，行為零改動（鐵律 1）。
 *   - `noopPersistPort`（沙盤）：零 DB 寫、零通知、零用量統計（鐵律 3；T363 零副作用）。
 *   worker 留喺 caller 嘅部分（純結構重排）：context 載入 / session 分流（C6/Part E）/ R-7 template /
 *   draft 入庫（port.createDraft）/ AUTO 發送（attemptAutoSend）/ trace 寫 / socket 推。
 */
import { Prisma } from "@prisma/client";
import type { Clinic } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { publishConvEvent, convRef } from "@/lib/notify";
import {
  classifyAndDraft,
  getAiConfig,
  isAiMockEnabled,
  recordAiCall,
  type ClassifyAndDraftResult,
} from "@/lib/ai";
import { PROMPT_CONTEXT_MESSAGES } from "@/lib/ai/prompts";
import type { AiContextMessage } from "@/lib/ai/types";
import { scrubAiSummary } from "@/lib/ai/scrub";
import { getAutomationLevel, type AutomationLevel } from "@/lib/ai/automation";
import { fetchDutyRoster, hkToday } from "@/lib/duty/client";
import {
  applyRouting,
  resolveEffectiveRules,
  matchRule,
  resolvePatientType,
  type RoutingInput,
  type RoutingResult,
} from "@/lib/routing/route";
import { getParams } from "@/lib/workflow/store";
import {
  pickKnowledge,
  knowledgePromptBlock,
  matchPriceDocs,
  type KnowledgePickResult,
} from "@/lib/knowledge/retrieve";
import { getKnowledgeCatalog, type CatalogDoc } from "@/lib/knowledge/catalog";
import { isPriceIntent, buildPriceDraft, runPriceGuard, NO_PRICE_TEXT } from "@/lib/ai/price-guard";
import { runClaimGuard } from "@/lib/ai/claim-guard";
import { CONSULT_LLM_ACTIONS } from "@/lib/ai/consult-llm";
import { getLexicon, applyLexicon, type LexiconEntry } from "@/lib/sessions/lexicon";
import { matchRedFlagTerms, type RedFlagResult } from "@/lib/sessions/red-flags";
import { triggerFloor } from "@/lib/sessions/consult-trigger";
import {
  runConsultEngineTurn,
  runConsultLlmTurn,
  type ConsultTurnOutcome,
} from "@/lib/sessions/consult-runner";
import { type ConsultStore } from "@/lib/sessions/consult-store";
import { loadConsultSettings } from "@/lib/sessions/consult-settings";
import { getWindowState, type WindowState } from "@/lib/wa/window";

// ★ cwi-followup-v3 B-6：術後關懷窗 = 72 小時（C 類跟進建議發出後 — 痛症入 PAIN_TRIAGE + claim-guard CG-010 零療程零報價）
export const POSTOP_CARE_WINDOW_MS = 72 * 3600 * 1000;
import {
  AUTO_RESOLVE_NOTE_PREFIX,
  isReopenedFirstReply,
  isReopenedFirstReplySafe,
} from "@/lib/reopen-reply";

// ─────────────────────────────────────────────────────────────────────
// S1（H-1）：對話歷史組裝 — 唯一組裝點
// ─────────────────────────────────────────────────────────────────────

/**
 * buildAiContext 輸入（已按時間**由舊到新**排序嘅對話訊息）。
 * - worker：`prisma.message` row（direction/type/channel 原值；take = PROMPT_CONTEXT_MESSAGES）。
 * - 沙盤：Redis messages[]（type 缺省 "text"、channel 缺省 "API" — 沙盤只有文字）。
 */
export interface AiCtxSourceMessage {
  dir: "IN" | "OUT";
  /** 同 AiContextMessage.body（DB Message.body 可 null — media/壞資料行）。 */
  body: string | null;
  ts: Date | string;
  /** 缺省 "text"（沙盤口徑）；worker 傳 DB 原值（text/image/…）。 */
  type?: string;
  /** 缺省 "API"（沙盤口徑）；worker 傳 DB 原值。 */
  channel?: string;
}

/**
 * 對話歷史 → AiContextMessage[]（尾截最近 `limit` 條，保持由舊到新）。
 * ★ 包含觸發訊息（當前句）— 同 worker `ai.worker.ts` 原行口徑一致。
 * 純函數、零 IO — worker/沙盤/unit 共用。
 */
export function buildAiContext(
  messages: AiCtxSourceMessage[],
  limit: number = PROMPT_CONTEXT_MESSAGES
): AiContextMessage[] {
  return messages.slice(-limit).map((m) => ({
    direction: m.dir,
    channel: m.channel ?? "API",
    type: m.type ?? "text",
    body: m.body,
    waTimestamp: m.ts instanceof Date ? m.ts : new Date(m.ts),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// S4（H-2）：runInboundAi + PersistPort
// ─────────────────────────────────────────────────────────────────────

/**
 * 對話快照 ref（worker = DB row 全欄；沙盤 = synthetic）。
 * runInboundAi 入參（原始 row）同 applyClassification 回值（updated row）都用呢個型。
 */
export interface InboundConvRef {
  id: string;
  clinicId: string;
  contactId: string;
  lastInboundAt: Date | null;
  assigneeId: string | null;
  status: string;
  humanTookOver: boolean;
  lastOutboundText: string | null;
  urgent: boolean;
  resolvedAt: Date | null;
  reopenedAt: Date | null;
  lastOutboundAt: Date | null;
  pinnedPatientApricotId: string | null;
  routedRuleId: string | null;
  /** ★ cwi-followup-v3 B-6：C 類（術後）跟進建議發出時間 — 72h 內 inbound 痛症 → 強制 PAIN_TRIAGE（唔入 CONSULT）+ claim-guard CG-010 */
  postOpFollowupAt: Date | null;
}

/** draft row（worker = AiDraft row；沙盤 port 回 null）。 */
export interface DraftRow {
  id: string;
  draftText: string;
  status: string;
  mode: string;
}

export interface InboundAiOutcome {
  result: ClassifyAndDraftResult; // （已經 rf fast path / 報價鏈 / consult LLM 改寫）
  knowledge: KnowledgePickResult;
  priceTrace: {
    triggered: boolean;
    docId: string | null;
    guard: { blocked: boolean; disclaimerAppended: boolean; outOfRange: boolean };
  };
  citedPriceDoc: CatalogDoc | null;
  rf: RedFlagResult;
  lexicon: LexiconEntry[];
  /** pain-triage params（caller 用 — 例 worker Part E `postOpWindowDays`；沙盤唔用）。 */
  redFlagParams: Awaited<ReturnType<typeof getParams<"pain-triage">>>;
  consultTrigger: string | null;
  win: WindowState;
  consultGateAction: string | null;
  safeSummary: string;
  urgent: boolean;
  updatedConv: InboundConvRef;
  routing: RoutingResult;
  consultOutcome: ConsultTurnOutcome | null;
  /** C4 consult LLM turn 嘅 LLM call 數（0 = 未行 C4）— 沙盤 llmCalls 顯示用。 */
  consultLlmCalls: number;
  /** C4 extract 失敗（降級原草稿）— 沙盤 guardBits 顯示用。 */
  extractFailed: boolean;
  autoLevel: AutomationLevel;
  blocks: string[];
  canDraft: boolean;
  /** "NORMAL"（窗口內）/ "COPY_ONLY"（過窗）— canDraft=false 時無意義。 */
  draftMode: string;
  consultWindowExpired: boolean;
  consultTakeoverSuppressed: boolean;
}

/**
 * PersistPort — worker 同沙盤之間嘅**唯一 mode 分岔點**（鐵律 2）。
 * 所有 DB 寫 / 通知 / 用量統計 / audit 都收喺呢度；計算核心（runInboundAi）零分岔。
 */
export interface PersistPort {
  /** AI 用量統計（worker 記；沙盤鐵律 2 零統計）。 */
  recordAiCall(ok: boolean, errMsg?: string, latencyMs?: number, tokens?: number): Promise<void>;
  /** classify 失敗：worker = record(false) + error log（原 ai.worker.ts catch 逐字）；沙盤 = 標記 + warn。 */
  onClassifyFailure(err: unknown, message: string): Promise<void>;
  /** COMPLAINT → StaffNotice(HANDOFF_REQUEST) + socket notice:new（worker ；commit-then-emit）。 */
  notifyComplaint(args: {
    clinicId: string;
    conversationId: string;
    wamid: string | null;
    intent: string;
  }): Promise<void>;
  /** 分類落 Conversation（worker = prisma update 返 updated row；沙盤 = in-memory 副本，零 DB）。 */
  applyClassification(args: {
    conv: InboundConvRef;
    intent: string;
    confidence: number;
    urgency: string;
    aiSummary: string | null;
    urgent: boolean;
    sessionTrigger: string | null;
    consultGateAction: string | null;
  }): Promise<InboundConvRef>;
  /** 規則路由（worker = 真 applyRouting（DB 標記 + 組通知）；沙盤 = display subset（同 function、跳副作用））。 */
  applyRouting(input: RoutingInput): Promise<RoutingResult>;
  /** claim-guard BLOCK → AuditLog（worker；fail-soft）。沙盤 = log only（零 audit 寫）。 */
  auditClaimGuard(args: {
    sessionId: string;
    code: string;
    codes: string[];
    action: string;
    stage: string;
  }): Promise<void>;
  /**
   * draft 入庫（worker = 冪等 create + message.aiDraftId 連結；沙盤 = 唔建 → null）。
   * 由 caller 喺 canDraft 判定後先調（canDraft 判定本身喺 runInboundAi 內）。
   */
  createDraft(args: {
    convId: string;
    msgId: string;
    msgAiDraftId: string | null;
    draftText: string;
    model: string;
    latencyMs: number;
    intent: string;
    mode: string;
  }): Promise<DraftRow | null>;
  /** reopenedFirstReply 閘：翻開前最後一次 auto-resolve 備註嘅 waTimestamp（worker = DB 讀；沙盤 = null）。 */
  loadReopenNote(args: { convId: string; reopenedAt: Date }): Promise<Date | null>;
  /** human-recent cooldown 閘：最後一筆 OUT（非 INTERNAL）（worker = DB 讀；沙盤 = null）。 */
  loadLastOutboundMeta(args: {
    convId: string;
  }): Promise<{ sentVia: string | null; createdAt: Date } | null>;
}

/** livePersist 依赖（job metadata 俾 classify 失敗 log 用 — 同原 ai.worker.ts 口徑）。 */
export interface LivePersistDeps {
  jobAttemptsMade?: number;
  jobAttemptsTotal?: number;
  wamid: string | null;
  clinicId: string;
  clinicCode: string;
}

/**
 * worker 用嘅 PersistPort — 每段實作 = 原 ai.worker.ts 對應段落**逐字搬入**（鐵律 1 行為零改動）。
 */
export function livePersistPort(deps: LivePersistDeps): PersistPort {
  return {
    async recordAiCall(ok, errMsg, latencyMs, tokens) {
      await recordAiCall(ok, errMsg, latencyMs, tokens);
    },

    async onClassifyFailure(_err, message) {
      await recordAiCall(false, message);
      const attemptsTotal = deps.jobAttemptsTotal ?? 3;
      const finalAttempt = (deps.jobAttemptsMade ?? 0) + 1 >= attemptsTotal;
      log.error(
        {
          clinic: deps.clinicId,
          wamid: deps.wamid,
          mode: isAiMockEnabled() ? "mock" : "real",
          model: isAiMockEnabled() ? null : getAiConfig().primaryModel,
          attemptsMade: deps.jobAttemptsMade,
          finalAttempt,
          err: message,
        },
        "ai: call failed — degraded（舊 intent/summary 保留，無 draft，inbox 照常）"
      );
    },

    async notifyComplaint({ clinicId, conversationId, wamid, intent }) {
      // ★ Phase C (cwi-sess-20260824-c1)：投訴 → 內部通知軌（HANDOFF_REQUEST — 要真人跟進）
      //   R2 鐵律：commit-then-emit（create 已 commit 先發 socket）。
      await prisma.staffNotice.create({
        data: {
          clinicId,
          conversationId,
          kind: "HANDOFF_REQUEST",
          title: "病人投訴 — 需要真人跟進",
          meta: { wamid, intent },
        },
      });
      // ★ cwi-final S1-4：此處只有 clinicId + conversationId → 補五欄
      const convRow = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      });
      if (convRow) await publishConvEvent(convRef(convRow), "notice:new", { conversationId, kind: "HANDOFF_REQUEST" });
    },

    async applyClassification({ conv, intent, confidence, urgency, aiSummary, urgent, sessionTrigger, consultGateAction }) {
      // ── 3. 分類落 Conversation（原 ai.worker.ts 逐字）──
      // ★ H-3 第二層（deterministic scrub）：scrub 後嘅 safeSummary 先落庫（caller 已算好）。
      // urgent 只 set true 唔 set false — 已標急症嘅對話唔會被新一條普通訊息蓋掉。
      return await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          intent,
          intentConfidence: confidence,
          urgency,
          aiSummary: aiSummary,
          ...(urgent ? { urgent: true } : {}),
          // ★ consult v2.1 C1（§2.2 M-2）：最近一輪最終 consult trigger（FLOOR ?? LLM）
          sessionTrigger,
          // ★ consult v2.1 C1（§2.3 M-3 gate 級）：最近一輪 consult 閘動作（過窗 + trigger）
          consultGateAction,
        },
      });
    },

    async applyRouting(input) {
      // ── ★ cwi-routing-20260906（§2）：規則式路由 — 標記 + 通知（原 ai.worker.ts 逐字）──
      //   fail-soft：引擎內部吞錯 — 路由失敗唔阻 AI pipeline（對話照落公海）。
      return await applyRouting(input);
    },

    async auditClaimGuard({ sessionId, code, codes, action, stage }) {
      log.warn({ clinic: deps.clinicCode, wamid: deps.wamid, code, codes }, `claim-guard: ${code}`);
      await prisma.auditLog
        .create({
          data: {
            staffId: null,
            action: "CONSULT_CLAIM_GUARD_BLOCK",
            entity: "ConsultSession",
            entityId: sessionId,
            meta: { code, codes, action, stage } as object,
          },
        })
        .catch((err: unknown) => log.warn({ err: String(err) }, "claim-guard: audit failed（fail-soft）"));
    },

    async createDraft({ convId, msgId, msgAiDraftId, draftText, model, latencyMs, intent, mode }) {
      // ── 4. AI 草稿入庫（原 ai.worker.ts 逐字 — 冪等：unique(conversationId, inReplyToMessageId)）──
      let existing = await prisma.aiDraft.findUnique({
        where: {
          conversationId_inReplyToMessageId: {
            conversationId: convId,
            inReplyToMessageId: msgId,
          },
        },
      });
      if (!existing) {
        try {
          existing = await prisma.aiDraft.create({
            data: {
              conversationId: convId,
              inReplyToMessageId: msgId,
              draftText,
              model,
              latencyMs,
              // ★ Phase E（cwi-ai-20260825-t5）：per-draft intent 快照
              intent,
              // cwi-window-20260901（P2 / W-2）：過窗草稿 = COPY_ONLY
              mode,
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            // 競態（並行 retry 撞 unique）→ 取已存在嗰條
            existing = await prisma.aiDraft.findUnique({
              where: {
                conversationId_inReplyToMessageId: {
                  conversationId: convId,
                  inReplyToMessageId: msgId,
                },
              },
            });
          } else {
            throw err;
          }
        }
      }
      // 連結 message ↔ draft（send route 用嚟判採用狀態；UI 顯示上下文）
      if (msgAiDraftId !== existing!.id) {
        await prisma.message.update({ where: { id: msgId }, data: { aiDraftId: existing!.id } });
      }
      return existing;
    },

    async loadReopenNote({ convId, reopenedAt }) {
      // ★ cwi-reopenreply-20260910：「翻開前最後一次解決時間」— 最新 auto-resolve INTERNAL 備註
      //   （waTimestamp <= reopenedAt）。原 ai.worker.ts 逐字。
      const note = await prisma.message.findFirst({
        where: {
          conversationId: convId,
          direction: "OUT",
          channel: "INTERNAL",
          type: "note",
          body: { startsWith: AUTO_RESOLVE_NOTE_PREFIX },
          waTimestamp: { lte: reopenedAt },
        },
        orderBy: { waTimestamp: "desc" },
        select: { waTimestamp: true },
      });
      return note?.waTimestamp ?? null;
    },

    async loadLastOutboundMeta({ convId }) {
      // ★ consult v2.1 C1（§2.1 M-1）：cooldown 只計最後 OUT 係 HUMAN_TYPED（原 ai.worker.ts 逐字）。
      //   INTERNAL 備註（assign/transfer 自動落）唔係「覆病人」— 唔觸發冷靜期。
      const lastOut = await prisma.message.findFirst({
        where: {
          conversationId: convId,
          direction: "OUT",
          channel: { not: "INTERNAL" },
        },
        orderBy: { createdAt: "desc" },
        select: { sentVia: true, createdAt: true },
      });
      return lastOut ? { sentVia: lastOut.sentVia, createdAt: lastOut.createdAt } : null;
    },
  };
}

/**
 * 沙盤用嘅 PersistPort — 零 DB 寫 / 零通知 / 零用量統計（鐵律 3；T363 零副作用維持）。
 * 路由 = 同一套 `resolveEffectiveRules` + `matchRule` + `resolvePatientType`（跳 claim/audit/notice）。
 * `classifyFailed` 標記：沙盤 caller 攞到 runInboundAi throw 時先查 — classify 失敗先 pop IN + 502。
 */
export interface SandboxPersistPort extends PersistPort {
  readonly classifyFailed: boolean;
}
export function noopPersistPort(deps: { clinicCode: string }): SandboxPersistPort {
  const state = { classifyFailed: false };
  const port: SandboxPersistPort = {
    get classifyFailed() {
      return state.classifyFailed;
    },
    async recordAiCall() {
      // ★ 鐵律 2：唔 recordAiCall（零用量統計）
    },
    async onClassifyFailure(_err, message) {
      state.classifyFailed = true;
      log.warn({ clinic: deps.clinicCode, err: message }, "sandbox: classify failed — 502");
    },
    async notifyComplaint() {
      // 沙盤：唔建 StaffNotice（只在 steps 顯示 intent）
    },
    async applyClassification({ conv, urgent }) {
      // 沙盤：唔寫 DB — in-memory 副本（urgent 只 set true 唔 set false — 同 worker 語義）
      return { ...conv, urgent: conv.urgent || urgent };
    },
    async applyRouting(input) {
      // ★ 沙盤 subset（原 sandbox.ts step 8 逐字搬入）：同 function、跳 claim/audit/notice
      try {
        const rules = await resolveEffectiveRules(input.conv.clinicId);
        const patientType = await resolvePatientType({
          pinnedPatientApricotId: input.conv.pinnedPatientApricotId,
          waId: input.contact?.waId ?? null,
        });
        const matched = matchRule(rules, {
          intent: input.intent,
          textRaw: input.msg.body,
          textCanonical: applyLexicon(input.msg.body, input.lexicon),
          patientType,
          lexicon: input.lexicon,
        });
        return {
          rule: matched ?? null,
          marked: matched !== null,
          groupId: matched?.targetGroupId ?? null,
          groupName: null,
          staffId: matched?.targetStaffId ?? null,
          matchedButUnmarked: null,
        };
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox: routing fail-soft");
        return { rule: null, marked: false, groupId: null, groupName: null, staffId: null, matchedButUnmarked: null };
      }
    },
    async auditClaimGuard({ code, codes }) {
      log.warn({ clinic: deps.clinicCode, code, codes }, "sandbox: claim-guard blocked（display only — 零 audit 寫）");
    },
    async createDraft() {
      // 沙盤：唔建 AiDraft（draft 字串直接喺 outcome.result.draft）
      return null;
    },
    async loadReopenNote() {
      return null; // 沙盤：synthetic conv 冇翻開史
    },
    async loadLastOutboundMeta() {
      return null; // 沙盤：零 OUT 歷史
    },
  };
  return port;
}

/**
 * runInboundAi — worker 同沙盤共用嘅 inbound AI **計算核心**（鐵律 2：mode 分岔只喺 PersistPort）。
 *
 * 步驟（同原 ai.worker.ts 主路徑順序一致）：
 * ① RAG 兩階段檢索（fail-soft）→ ② classify（失敗 → port.onClassifyFailure 後 rethrow）→
 * ③ red flag fast path → ④ consult trigger（FLOOR ?? LLM）→ ⑤ 報價鏈 + price-guard →
 * ⑥ COMPLAINT 通知（port）→ ⑦ 窗口 + gate action + scrub → ⑧ 分類落 Conversation（port）→
 * ⑨ 規則路由（port）→ ⑩ consult engine turn（shared runner + ConsultStore）→
 * ⑪ consult LLM turn + price/claim guard（port.auditClaimGuard）→ ⑫ canDraft + draftMode →
 * ⑬ AUTO level + blocks（worker machine gates；沙盤 ⑦ 步顯示用同一份）。
 *
 * 唔屬本函數（留喺 caller）：context 載入 / session 分流（C6/Part E 開 session + early return）/
 * R-7 template / draft 入庫（port.createDraft）/ AUTO 發送（attemptAutoSend）/ trace 寫 / socket 推。
 */
export async function runInboundAi(input: {
  clinic: Clinic;
  msg: {
    id: string;
    type: string;
    body: string | null;
    waMessageId: string | null;
    aiDraftId?: string | null;
  };
  /** 對話快照（worker = DB row；沙盤 = synthetic）。 */
  conv: InboundConvRef;
  contact: { profileName: string | null; waId: string | null } | null;
  ctxMessages: AiContextMessage[];
  /** 媒體訊息（worker = MEDIA_TYPES.has(msg.type)；沙盤恒 false — 沙盤只有文字）。 */
  isMedia: boolean;
  /** consult session 存儲（沙盤 = redisConsultStore；worker = undefined → prismaConsultStore 預設）。 */
  consultStore?: ConsultStore;
  persist: PersistPort;
}): Promise<InboundAiOutcome> {
  const { clinic, msg, conv, contact, ctxMessages, persist } = input;
  const { isMedia, consultStore } = input;

  // ── ① ★ Part F（cwi-raggolden-20260904，F.3）：RAG 兩階段檢索 — 階段一（選 id）喺 classify 前 ──
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

  // ── ② AI call（失敗 = 降級：port.onClassifyFailure + rethrow 俾 caller retry/502）──
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
    const m = err instanceof Error ? err.message : String(err);
    await persist.onClassifyFailure(err, m);
    throw err;
  }
  await persist.recordAiCall(true, undefined, result.latencyMs, result.tokens);

  // ★ Part E（cwi-paintriage-20260903，E.2）：確定性紅旗 fast path — 訊息本身含 FLOOR ∪ params 紅旗詞
  //   （lexicon canonical 化後）→ 直升 URGENT_PAIN（fast path 唔問診；E.4 同一份詞表；LLM 只抽槽唔判級）。
  //   喺 COMPLAINT 通知之前行 — 紅旗 recall 優先（投訴文含紅旗詞 → 紅旗勝）。
  //   （getLexicon/getParams 均 fail-soft 永不 throw — 沙盤原 .catch 兜底嘅行為同值。）
  const ptLex = msg.type === "text" && msg.body ? await getLexicon(conv.clinicId) : [];
  const ptParams = await getParams("pain-triage", conv.clinicId);
  let rf: RedFlagResult = { hit: false, categories: [], terms: [] };
  if (msg.type === "text" && msg.body) {
    rf = matchRedFlagTerms([applyLexicon(msg.body, ptLex)], ptParams);
    if (rf.hit && result.intent !== "URGENT_PAIN") {
      log.info(
        { clinic: clinic.code, wamid: msg.waMessageId, categories: rf.categories, terms: rf.terms },
        "pain-triage: fast-path red flag (deterministic) → URGENT_PAIN"
      );
      result = { ...result, intent: "URGENT_PAIN", urgency: "HIGH", needsHuman: true, draft: null };
    }
  }

  // ── ★ consult v2.1 C1（§2.2 M-2）：consult session trigger 最終值 = FLOOR（deterministic）?? LLM 值 ──
  // FLOOR = code 常數（CONSULT_TRIGGER_FLOOR，UI 顯示但唔可刪）—「觸發唔靠 LLM」；
  // LLM 值（result.sessionTrigger）只喺 FLOOR 唔中時補充。floor 優先（MD §2.2）。
  let consultTrigger =
    msg.type === "text" && msg.body
      ? triggerFloor(msg.body, applyLexicon(msg.body, ptLex)) ?? result.sessionTrigger ?? null
      : null;

  // ── ★ cwi-followup-v3 B-6：術後關懷窗（C 類跟進建議發出後 72h 內）──────────
  // 紅旗詞 → URGENT 全套（上面 rf fast path 已處理）；
  // 痛症訊號（intent=PAIN）→ 強制 PAIN_TRIAGE 路徑，唔准入 CONSULT 銷售 session（壓 consultTrigger）。
  const postOpCareWindow =
    !!conv.postOpFollowupAt && Date.now() - conv.postOpFollowupAt.getTime() <= POSTOP_CARE_WINDOW_MS;
  if (postOpCareWindow && consultTrigger !== null && result.intent === "PAIN") {
    log.info(
      { clinic: clinic.code, wamid: msg.waMessageId, trigger: consultTrigger },
      "B-6: post-op care window (72h) + PAIN intent → suppress consult (forced PAIN_TRIAGE, no sales session)"
    );
    consultTrigger = null;
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

  // ── ⑥ COMPLAINT → 內部通知軌（port：worker = StaffNotice + socket；沙盤 = no-op）──────────
  if (result.intent === "COMPLAINT") {
    await persist.notifyComplaint({
      clinicId: conv.clinicId,
      conversationId: conv.id,
      wamid: msg.waMessageId,
      intent: result.intent,
    });
  }

  // ── ⑦ 窗口狀態 + gate action + scrub ─────────────────────────────────
  // ── cwi-window-20260901（P2）：窗口狀態（W-2）──
  // 過窗：AI 草稿照生成但 mode=COPY_ONLY（UI 只准複製）；C6 session 唔開（session reply = 自動覆，
  // 過窗發唔出 → 避免一堆 FAILED outbound）；AUTO 自動覆本就有 window-closed 閘（下方 blocks）。
  // ★ consult v2.1 C1：喺 step 3 update 之前攞（update 唔改 lastInboundAt）— M-3 gate action 要用。
  const win = getWindowState(conv.lastInboundAt);
  // ★ consult v2.1 C1（§2.3 M-3 gate 級）：窗口已過 + consult trigger → WINDOW_EXPIRED_HANDOFF
  //   （唔生成 free-form 草稿、出既有三出路、對話保留唔關；完整 transition table 屬 C3）。
  const consultGateAction = !win.open && consultTrigger !== null ? "WINDOW_EXPIRED_HANDOFF" : null;

  // ★ H-3 第二層（deterministic scrub，零 AI 依賴）：AI 可能唔聽 prompt 寫咗身份資料 —
  //   落庫/推送前將 profileName（完整 + ≥2 字子串）同 waId 後 8 位替換做 病人/***
  const safeSummary = scrubAiSummary(result.summary, { profileName: contact?.profileName, waId: contact?.waId });
  const urgent = result.intent === "URGENT_PAIN" || result.urgency === "HIGH";

  // ── ⑧ 分類落 Conversation（port：worker = prisma update；沙盤 = in-memory 副本）────────────
  const updatedConv = await persist.applyClassification({
    conv,
    intent: result.intent,
    confidence: result.confidence,
    urgency: result.urgency,
    aiSummary: safeSummary.length > 0 ? safeSummary.slice(0, 50) : null,
    urgent,
    sessionTrigger: consultTrigger,
    consultGateAction,
  });

  // ── ⑨ 規則路由（port：worker = 真 applyRouting；沙盤 = display subset）─────────────────
  // ── ★ cwi-routing-20260906（§2）：掛鉤點 = classify 落 DB 之後、任何通知之前。
  //   R-8：URGENT_PAIN/HIGH 嘅全店 urgent:escalation 廣播（caller step 5 路徑）照行。
  const routing = await persist.applyRouting({
    conv: {
      id: conv.id,
      clinicId: conv.clinicId,
      contactId: conv.contactId,
      assigneeId: updatedConv.assigneeId,
      pinnedPatientApricotId: conv.pinnedPatientApricotId,
      status: conv.status,
      routedRuleId: conv.routedRuleId,
    },
    clinic,
    contact,
    msg: { id: msg.id, type: msg.type, body: msg.body ?? "", waMessageId: msg.waMessageId },
    intent: result.intent,
    urgency: result.urgency,
    lexicon: ptLex,
  });

  // ── ⑩ ★ consult v2.1 C3（§4 規則引擎 — 純函數零 LLM）：每 consult turn transition ─────────
  // 觸發 = consultTrigger（FLOOR ?? LLM，C1 口徑）；get/create active session（C2 守衛）+ 25 行
  // first match wins + action/stage/terminal/purchaseIntent/turnCount 落 store + audit。
  // fail-soft：engine 失敗唔阻 pipeline（runner 內部 catch）。
  // ★ C5（MD §8.1）：UI 設定 — 每 consult turn fresh load（fail-soft → default = C3/C4 原行為）；
  //   engine turn + LLM turn 共用同一份。
  const consultUi =
    msg.type === "text" && msg.body && consultTrigger !== null
      ? await loadConsultSettings(prisma, conv.clinicId)
      : null;
  let consultOutcome: ConsultTurnOutcome | null = null;
  if (msg.type === "text" && msg.body && consultTrigger !== null) {
    consultOutcome = await runConsultEngineTurn({
      prisma,
      conv,
      clinic,
      msg: { id: msg.id, waMessageId: msg.waMessageId, type: msg.type, body: msg.body },
      intent: result.intent,
      consultTrigger,
      winOpen: win.open,
      lexicon: ptLex,
      redFlagParams: ptParams,
      settings: consultUi,
      store: consultStore,
    });
  }

  // ── ⑪ ★ consult v2.1 C4（MD §6）：LLM 兩次 call（Call #1 抽槽 + Call #2 生成）+ §5 Claim Guard ──
  // 觸發 = engine content action（8 個）+ processed + intent/urgency 未壓（喺 canDraft 之前先攞 LLM 草稿）。
  // 「suppressDraft 嘅 turn 唔准有 LLM call」鐵律由結構保證。call 數 ≤3/turn。
  // pipeline：extract（失敗 → 降級保留原 draft，state 不變）→ generate（isProductUsable 鐵律過濾）
  //   → price-guard 重跑（deterministic）→ claim guard（§5，喺 price-guard 之後）→ audit（port）。
  // fail-soft：任何失敗 → 保留原 draft（對話照行）；非 8-action turn 零 LLM call。
  let consultLlmCalls = 0;
  let extractFailed = false;
  if (
    msg.type === "text" &&
    msg.body &&
    result.draft !== null &&
    consultOutcome &&
    consultOutcome.sessionId &&
    consultOutcome.transition?.processed === true &&
    consultOutcome.action !== null &&
    CONSULT_LLM_ACTIONS.has(consultOutcome.action) &&
    result.intent !== "URGENT_PAIN" &&
    result.intent !== "COMPLAINT" &&
    result.urgency !== "HIGH"
  ) {
    const llm = await runConsultLlmTurn({
      prisma,
      conv,
      clinic,
      msg: { id: msg.id, waMessageId: msg.waMessageId, body: msg.body },
      sessionId: consultOutcome.sessionId,
      workflow: consultTrigger as string,
      action: consultOutcome.action,
      stage: consultOutcome.stage,
      candidateCategory: consultOutcome.transition?.candidateCategory ?? null,
      askedSlot: consultOutcome.transition?.askedSlot ?? null,
      priceDoc: citedPriceDoc,
      ctxMessages,
      questionOverrides: consultUi?.discoveryQuestionOverrides ?? null,
      store: consultStore,
    });
    consultLlmCalls = llm.calls;
    extractFailed = llm.extractFailed;
    if (llm.draft !== null) {
      // ① draft 換入（主 classify 只係 fallback — extract 失敗時保留）
      let finalDraft: string = llm.draft;
      result = { ...result, draft: finalDraft, model: llm.model ?? result.model };
      // ② price-guard 重跑（deterministic — 先行；consult draft 取代咗舊 draft，原 guard 結果作廢）
      const pg = runPriceGuard({ draft: finalDraft, priceDoc: citedPriceDoc, priceIntent: priceTrace.triggered });
      priceTrace.guard = { blocked: pg.blocked, disclaimerAppended: pg.disclaimerAppended, outOfRange: pg.outOfRange };
      if (pg.blocked) {
        finalDraft = pg.draft;
        result = { ...result, draft: pg.draft, needsHuman: true };
      } else if (pg.disclaimerAppended) {
        finalDraft = pg.draft;
        result = { ...result, draft: pg.draft };
      }
      // ③ claim guard（MD §5 — 喺 price-guard 之後；BLOCK → 棄用草稿 → 人手提示 + needsHuman + trace）
      const cg = runClaimGuard({
        draft: finalDraft,
        products: llm.usableProducts.map((p) => ({ ...p })),
        hasBackendSlot: false, // free-form consult 路徑 — 只 booking flow 先有 backend slot
        priceDoc: citedPriceDoc ? { priceMin: citedPriceDoc.priceMin, priceMax: citedPriceDoc.priceMax } : null,
        // ★ cwi-followup-v3 B-6：術後關懷窗（72h）— CG-010 零療程零報價
        postOpCareWindow,
      });
      if (cg.blocked && cg.code) {
        await persist.auditClaimGuard({
          sessionId: consultOutcome.sessionId,
          code: cg.code,
          codes: cg.codes,
          action: consultOutcome.action,
          stage: consultOutcome.stage,
        });
        result = { ...result, draft: cg.draft, needsHuman: true };
      }
    }
  }

  // ── ⑫ 草稿最終判定（worker step 4 語義 — canDraft + draftMode；入庫由 caller 經 port）──────
  // ── 4. AI 草稿（鐵律：URGENT_PAIN / HIGH 永不生成 — code 層第一重擋） ─────
  // Phase 2b：needsHuman=true 都可以出 draft（staff 審批；AUTO 模式永遠唔會自動發）
  // ★ consult v2.1 C1（§2.3 M-3）：過窗 + consult trigger → 唔出 free-form 草稿（出既有三出路；對話保留）。
  const consultWindowExpired = !win.open && consultTrigger !== null;
  // ★ consult v2.1 C1（§2.1 M-1）：店員自己打字接手（humanTookOver）+ 本輪係 consult trigger → 停出草稿
  const consultTakeoverSuppressed = updatedConv.humanTookOver && consultTrigger !== null;
  if (consultWindowExpired) {
    log.info(
      { clinic: clinic.code, wamid: msg.waMessageId, trigger: consultTrigger, gate: consultGateAction },
      "ai: consult window expired — no free-form draft（既有三出路：App 覆 / template / 等病人；對話保留）"
    );
  } else if (consultTakeoverSuppressed) {
    log.info(
      { clinic: clinic.code, wamid: msg.waMessageId, trigger: consultTrigger },
      "ai: human took over — consult draft suppressed（等「交返 AI 繼續」）"
    );
  }
  const canDraft =
    result.intent !== "URGENT_PAIN" &&
    result.intent !== "COMPLAINT" && // ★ Phase C：投訴唔出 AI 草稿 — 呢啲說話要人講
    result.urgency !== "HIGH" &&
    result.draft !== null &&
    msg.type === "text" && // ★ AI Workflow T1 (A2)：媒體唔出草稿（只內部通知職員）
    !consultWindowExpired &&
    !consultTakeoverSuppressed &&
    !consultOutcome?.suppressDraft; // ★ C3：END_SESSION（叫停/推搪）後唔 auto-reply
  const draftMode = win.open ? "NORMAL" : "COPY_ONLY";

  // ── ⑬ AUTO level + blocks（worker 4.5 語義 — 全部 gate 喺度一次算好；沙盤 ⑦ 步顯示同一份）──
  // ★ Fix B（cwi-fix-20260825-f1）：自動覆資格由 resolver 決定（per intent）。
  //   行為保證：冇 policy row 嘅店 = resolver fallback aiMode（AUTO→L2 / DRAFT→L1）→ byte 不變。
  const autoLevel = await getAutomationLevel(conv.clinicId, result.intent);
  const blocks: string[] = autoLevel === "L1" ? ["policy-L1"] : [];
  if (autoLevel !== "L1") {
    if (result.intent === "URGENT_PAIN") blocks.push("URGENT_PAIN"); // 鐵律：code 第二重擋
    if (result.intent === "COMPLAINT") blocks.push("COMPLAINT"); // ★ Phase C：投訴絕不自動發（要人講）
    if (result.urgency === "HIGH") blocks.push("HIGH"); // 鐵律：code 第二重擋
    if (result.needsHuman) blocks.push("needsHuman"); // 鐵律：人工永遠唔自動發
    // ★ Part F（cwi-raggolden-20260904，F.3）：L2 自動覆前提 — 價錢問題（priceIntent）有引用先准自動覆。
    if (result.intent === "QUESTION" && priceTrace.triggered && !priceTrace.docId) blocks.push("no-knowledge-citation");
    if (!canDraft) blocks.push("no-draft"); // 原 worker：draft row === null ⟺ !canDraft（row 只喺 canDraft 時建）
    if (!win.open) blocks.push("window-closed");
    // ★ Phase A：真人接手 = AI 收聲（Send Lock 語義補完）
    if (updatedConv.assigneeId !== null) blocks.push("assigned");
    // RESOLVED 對話病人翻頭一句「唔該」唔應該觸發自動覆
    if (updatedConv.status === "RESOLVED") blocks.push("resolved");
    // ★ cwi-reopenreply-20260910（T84 決策 (b) 收窄版）：翻開後**首句**三條件閘
    if (isReopenedFirstReply(updatedConv)) {
      // 「翻開前最後一次解決時間」：resolvedAt（T2 翻開已清，防禦性）→ 否則最新 auto-resolve INTERNAL 備註
      //   （waTimestamp <= reopenedAt）→ 仍無 = null = 條件②唔中（保守 DRAFT；手動 resolve 無痕可溯）。
      let lastResolved: Date | null = updatedConv.resolvedAt;
      if (lastResolved == null && updatedConv.reopenedAt != null) {
        lastResolved = await persist.loadReopenNote({ convId: conv.id, reopenedAt: updatedConv.reopenedAt });
      }
      const rr = isReopenedFirstReplySafe({
        intent: result.intent,
        lastResolvedAt: lastResolved,
        raw: msg.body,
        canonical: msg.body && ptLex.length > 0 ? applyLexicon(msg.body, ptLex) : null,
      });
      if (!rr.safe) {
        blocks.push("reopenedFirstReply");
        // metadata only（intent 名 + 原因 token — 零病人原文）
        log.info(
          { clinic: clinic.code, wamid: msg.waMessageId, intent: result.intent, reasons: rr.reasons.join("+") },
          "ai: reopenedFirstReply gate — 翻開首句三條件唔齊（draft only）"
        );
      }
    }
    // ★ Phase A (A2)：媒體訊息 — 唔覆客、唔出草稿、只通知職員
    if (isMedia) blocks.push("media");
    // 可選第八閘：未 claim 但真人啱啱插咗嘴（冷靜期 — ★ Phase D：params 由 WorkflowDefinition
    // 「triage」ACTIVE row 讀（三級 fallback + fail-soft；env AI_HUMAN_COOLDOWN_MS 保留做底））
    // ★ consult v2.1 C1（§2.1 M-1，MD §2.1 代碼）：cooldown 只計最後 OUT 係 HUMAN_TYPED（店員自己打字）。
    const triageParams = await getParams("triage", conv.clinicId);
    const cooldownMs = triageParams.humanCooldownMs;
    const lastOut = await persist.loadLastOutboundMeta({ convId: conv.id });
    const humanCooldownActive =
      lastOut !== null &&
      lastOut.sentVia === "HUMAN_TYPED" &&
      Date.now() - lastOut.createdAt.getTime() < cooldownMs;
    if (humanCooldownActive) blocks.push("human-recent");
    // ★ Phase D 第九閘：confidence 低過 floor → low-confidence（floor 由 triage params 校）
    if (result.confidence < triageParams.confidenceFloor) blocks.push("low-confidence");
  }

  return {
    result,
    knowledge,
    priceTrace,
    citedPriceDoc,
    rf,
    lexicon: ptLex,
    redFlagParams: ptParams,
    consultTrigger,
    win,
    consultGateAction,
    safeSummary,
    urgent,
    updatedConv,
    routing,
    consultOutcome,
    consultLlmCalls,
    extractFailed,
    autoLevel,
    blocks,
    canDraft,
    draftMode,
    consultWindowExpired,
    consultTakeoverSuppressed,
  };
}
