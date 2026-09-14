/**
 * ★ cwi-hub-b-20260914（Part B B.3）：AI 流程沙盤 — 真 pipeline 同款 function、零副作用。
 *
 * 鐵律（MD B.3.1，最高優先）：
 * 1. 走真 pipeline **同一套 function**（跟 src/workers/ai.worker.ts 非 session 主路徑逐段對應 —
 *    S0 inventory 喺 /tmp/kairo-progress-cwi-hub-b-20260914.md；S6 T366 e2e 斷言同真 worker 一致）。
 * 2. mode 分支**只准喺持久化同發送層**：本檔零 prisma.create/update/delete（全唯讀）、
 *    零 publishNotify / pushEvent / enqueueOutboundSend / recordAiCall / AuditLog。
 * 3. 紅旗命中 → 只顯示結果（steps[0] detail），唔建 StaffNotice、唔標 URGENT。
 * 4. 真 LLM call（classifyAndDraft / pickKnowledge / consultExtractSlots / consultGenerateDraft —
 *    本地 GPU 零成本）；真知識庫、真 workforce 讀（fetchDutyRoster 唯讀）。
 * 5. 每次 run log（ai-sandbox scope — metadata only，零病人原文）。
 * 6. 多輪 state 存 Redis `sandbox:{staffId}:{sandboxId}`，TTL 30 分鐘，**永不落 DB**；
 *    state = ConsultSessionState 同款結構（toSessionState 型別）+ messages[]（≤20 條）。
 *
 * 與真 worker 嘅逐段差異（**只**係持久化/發送層 — 其餘 function 同一份）：
 * | worker 段落            | 沙盤處理                                                        |
 * | conversation/clinic 載入 | clinic 直讀（無 conv — synthetic 上下文 = Redis messages[]）   |
 * | Message 載入           | 入參 message（唔落 DB）                                          |
 * | recordAiCall           | 唔調（零用量統計）                                               |
 * | COMPLAINT staffNotice  | 唔建（只在 steps 顯示 intent）                                   |
 * | conversation.update    | 唔寫（intent/trigger 存 Redis state 快照回傳）                    |
 * | applyRouting           | 用同一 `resolveEffectiveRules` + `matchRule` + `resolvePatientType`，跳 claim/audit/notice |
 * | runConsultEngineTurn   | 用同一純函數 `detectConsultSignals` + `computePurchaseIntentDelta` + `consultTransition` +
 *                         `matchNamedProduct`（同 function），state 存 Redis 唔落 ConsultSession |
 * | runConsultLlmTurn      | 用同一 `consultExtractSlots`（Call#1）+ `consultGenerateDraft`（Call#2）+
 *                         `runPriceGuard` + `runClaimGuard`，slot merge 同款 latest-wins guard，跳 persist/audit |
 * | AiDraft create         | 唔建（draft 字串直接回傳）                                        |
 * | AUTO 發 + socket + push| 唔發（⑦ 步只算 level + blocks 顯示）                              |
 * | booking/PAIN session   | 唔開（slot-filling session 唔屬 CONSULT 多輪範圍 — B.5 沙盤多輪 = consult engine）|
 */
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";
import {
  classifyAndDraft,
  type AiContextMessage,
  type ClassifyAndDraftResult,
} from "@/lib/ai";
import { PROMPT_CONTEXT_MESSAGES } from "@/lib/ai/prompts";
import { getAutomationLevel, clearAutomationLevelCache } from "@/lib/ai/automation";
import { fetchDutyRoster, hkToday } from "@/lib/duty/client";
import { getParams } from "@/lib/workflow/store";
import { bustParamsCache } from "@/lib/workflow/store";
import { pickKnowledge, knowledgePromptBlock, matchPriceDocs } from "@/lib/knowledge/retrieve";
import { getKnowledgeCatalog } from "@/lib/knowledge/catalog";
import { isPriceIntent, buildPriceDraft, runPriceGuard, NO_PRICE_TEXT, selectPriceDisclaimer } from "@/lib/ai/price-guard";
import { runClaimGuard } from "@/lib/ai/claim-guard";
import { CONSULT_LLM_ACTIONS, consultExtractSlots, consultGenerateDraft, consultDiscoveryQuestion } from "@/lib/ai/consult-llm";
import { getLexicon, applyLexicon, type LexiconEntry } from "@/lib/sessions/lexicon";
import { bustLexiconCache } from "@/lib/sessions/lexicon";
import { matchRedFlagTerms, type RedFlagResult } from "@/lib/sessions/red-flags";
import { triggerFloor } from "@/lib/sessions/consult-trigger";
import {
  consultTransition,
  detectConsultSignals,
  computePurchaseIntentDelta,
  type ConsultSessionState,
  type TransitionResult,
} from "@/lib/sessions/consult-engine";
import type { ConsultWorkflow } from "@/lib/sessions/consult-types";
import { matchNamedProduct, type ConsultLlmProductCtx } from "@/lib/sessions/consult-runner";
import { isProductUsable } from "@/lib/sessions/consult-products";
import { loadConsultSettings } from "@/lib/sessions/consult-settings";
import { resolveEffectiveRules, matchRule, resolvePatientType } from "@/lib/routing/route";
import { getWindowState } from "@/lib/wa/window";
import type { AutomationLevel } from "@/lib/ai/automation";

const sLog = log.child({ scope: "ai-sandbox" });

// ── Redis state（TTL 30min，永不落 DB）─────────────────────────────────

export const SANDBOX_TTL_SECONDS = 30 * 60;

export interface SandboxMessage {
  dir: "IN" | "OUT";
  /** OUT = 沙盤草稿（sandboxDraft — 唔係真發出行） */
  body: string;
  ts: string; // ISO
}

export interface SandboxRedisState {
  sandboxId: string;
  clinicId: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一條 IN（窗口判定；沙盤每輪即時處理 → 照真 pipeline = 本句到 = 窗口開） */
  lastInboundAt: string;
  /** 對話歷史（IN = 病人句；OUT = 上一輪沙盤草稿 — 入 LLM context 同真 pipeline 口徑一致）≤20 條 */
  messages: SandboxMessage[];
  /** CONSULT 多輪 state（toSessionState 同款結構；null = 未開 consult session） */
  state: ConsultSessionState | null;
}

function sandboxKey(staffId: string, sandboxId: string): string {
  return `sandbox:${staffId}:${sandboxId}`;
}

async function loadState(staffId: string, sandboxId: string): Promise<SandboxRedisState | null> {
  const raw = await getRedis().get(sandboxKey(staffId, sandboxId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SandboxRedisState;
    if (!parsed?.sandboxId || !parsed?.clinicId || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveState(staffId: string, st: SandboxRedisState): Promise<void> {
  await getRedis().set(sandboxKey(staffId, st.sandboxId), JSON.stringify(st), "EX", SANDBOX_TTL_SECONDS);
}

async function clearState(staffId: string, sandboxId: string): Promise<void> {
  await getRedis().del(sandboxKey(staffId, sandboxId));
}

/** 新 CONSULT session 初始 state — 同 ConsultSession 建 row 嘅 DB defaults 經 toSessionState 後一致。 */
function freshConsultState(workflow: string): ConsultSessionState {
  return {
    workflow: workflow as ConsultWorkflow,
    stage: "DISCOVER",
    terminal: null,
    turnCount: 0,
    purchaseIntent: 0,
    slots: { clinicalSuitability: "UNKNOWN" },
    candidateCategory: null,
    comparedProducts: [],
    askedSlots: [],
    objections: [],
    ctaGiven: false,
    humanTookOver: false,
    lastAction: null,
  };
}

// ── 型別 ──────────────────────────────────────────────────────────────

export type StepStatus = "ok" | "paused" | "fail" | "skip"; // ✓ / ⏸ / ✗ / —

export interface SandboxStep {
  n: number;
  name: string;
  status: StepStatus;
  /** 一句摘要（沙盤 UI 逐行顯示；✓/⏸/✗/— 各配一句） */
  summary: string;
  detail: Record<string, unknown>;
}

export interface SandboxSessionSnapshot {
  workflow: string;
  stage: string;
  terminal: string | null;
  turnCount: number;
  purchaseIntent: number;
  lastAction: string | null;
  askedSlots: string[];
  slots: Record<string, unknown>;
}

export interface SandboxTurnResult {
  sandboxId: string;
  turn: number;
  steps: SandboxStep[];
  /** 最終草稿（null = 無 — 急症/紅旗/叫停/唔准報價等） */
  draft: string | null;
  draftMode: string | null; // NORMAL / COPY_ONLY / NO_DRAFT
  intent: string;
  urgency: string;
  needsHuman: boolean;
  consultTrigger: string | null;
  sessionSnapshot: SandboxSessionSnapshot | null;
  /** ⑦ 步 verdict（顯示用） */
  sendVerdict: { level: AutomationLevel; willAutoSend: boolean; blocks: string[] };
  latencyMs: number;
  /** 本輪 LLM call 數（1 = classify；+1 = consult extract；+1 = consult generate） */
  llmCalls: number;
}

export interface SandboxTurnInput {
  staffId: string;
  clinicId: string;
  message: string;
  sandboxId?: string;
}

export class SandboxError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const STEP_NAMES: Record<number, string> = {
  1: "安全閘",
  2: "理解",
  3: "對話模式",
  4: "搵資料",
  5: "派俾邊個",
  6: "出文",
  7: "發唔發",
};

// ── 主入口 ────────────────────────────────────────────────────────────

export async function runSandboxTurn(input: SandboxTurnInput): Promise<SandboxTurnResult> {
  const t0 = Date.now();
  const message = input.message.trim();
  if (!message) throw new SandboxError(400, "message 唔可以空");
  if (message.length > 4000) throw new SandboxError(400, "message 太長（>4000 字）");

  // 店必須存在（scope 由 API 層 requireAdmin + clinic 喺 scoped 集合內 — 呢度再校一次）
  const clinic = await prisma.clinic.findUnique({ where: { id: input.clinicId } });
  if (!clinic) throw new SandboxError(404, "clinic 唔存在");

  // sandbox state（Redis）— 新或續
  const sandboxId = input.sandboxId?.trim() || randomUUID().replace(/-/g, "").slice(0, 24);
  const loaded = await loadState(input.staffId, sandboxId).catch((err) => {
    sLog.error({ err: err instanceof Error ? err.message : String(err) }, "sandbox: redis load failed");
    throw new SandboxError(503, "Redis 斷 — 沙盤唔得用");
  });
  // clinic 唔配（同一 sandboxId 跨店）→ 當新 sandbox（唔混合兩間店嘅 state）
  const isNew = !loaded || loaded.clinicId !== clinic.id;
  let st: SandboxRedisState;
  if (isNew) {
    st = {
      sandboxId,
      clinicId: clinic.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastInboundAt: "",
      messages: [],
      state: null,
    };
  } else {
    st = loaded;
  }

  // 沙盤必須反映**即時**設定（T83 教訓：stale cache 誤壓）— web process 自己份 cache，
  // 同 publish API 同一個 bust function（worker process 唔受影響）。
  bustParamsCache();
  bustLexiconCache();
  clearAutomationLevelCache();

  // ── 1. 上下文（Redis messages[] = synthetic 對話歷史 — 同 worker ctxMessages 口徑）──
  st.messages.push({ dir: "IN", body: message, ts: new Date().toISOString() });
  if (st.messages.length > 20) st.messages = st.messages.slice(-20);
  st.lastInboundAt = st.messages[st.messages.length - 1].ts;
  const turn = st.messages.filter((m) => m.dir === "IN").length;

  const ctxMessages: AiContextMessage[] = st.messages
    .slice(0, -1) // 本句唔入 context（同 worker：觸發訊息本身唔入 context）
    .slice(-PROMPT_CONTEXT_MESSAGES)
    .map((m) => ({
      direction: m.dir,
      channel: "API",
      type: "text",
      body: m.body,
      waTimestamp: new Date(m.ts),
    }));

  // ── 2. ④ 搵資料 — RAG 兩階段（同 worker F.3：fail-soft → picked=[]）──
  const knowledge = await pickKnowledge({
    clinicId: clinic.id,
    question: message,
    context: ctxMessages.map((m) => m.body).filter((b): b is string => typeof b === "string" && b.trim().length > 0).slice(-3),
  }).catch((err) => {
    sLog.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox: knowledge fail-soft");
    return { ran: false, picked: [], discarded: 0, skipped: "fail-soft", latencyMs: 0 };
  });
  let llmCalls = knowledge.ran ? 1 : 0;

  // ── 3. ② 理解 — 主 classify（真 LLM #1；失敗 = 502 降級，state 唔改）──
  const dutyToday = hkToday();
  const dutyEntries = await fetchDutyRoster(clinic.code, dutyToday).catch(() => null);
  let result: ClassifyAndDraftResult;
  try {
    result = await classifyAndDraft({
      messages: ctxMessages,
      clinic: { name: clinic.name, greetingConfig: (clinic.greetingConfig as Record<string, unknown> | null) ?? null },
      dutyRoster: dutyEntries && dutyEntries.length > 0 ? { date: dutyToday, entries: dutyEntries } : null,
      knowledgeBlock: knowledgePromptBlock(knowledge.picked),
    });
  } catch (err) {
    // 同 worker 降級語義：state 唔改（回滚呢輪 push 嘅 IN）+ 502
    sLog.warn({ clinic: clinic.code, err: err instanceof Error ? err.message : String(err) }, "sandbox: classify failed — 502");
    st.messages.pop();
    throw new SandboxError(502, "AI 服務唔通（sglang 失敗）— 呢輪無結果，state 原封");
  }
  llmCalls += 1;
  // ★ 鐵律 2：唔 recordAiCall（零用量統計）

  // ── 4. ① 安全閘 — 紅旗 fast path（同 worker E.2：lexicon canonical 後 FLOOR∪params）──
  const lex: LexiconEntry[] = await getLexicon(clinic.id).catch(() => []);
  const ptParams = await getParams("pain-triage", clinic.id).catch(() => null);
  const rf: RedFlagResult = ptParams ? matchRedFlagTerms([applyLexicon(message, lex)], ptParams) : { hit: false, categories: [], terms: [] };
  if (rf.hit && result.intent !== "URGENT_PAIN") {
    result = { ...result, intent: "URGENT_PAIN", urgency: "HIGH", needsHuman: true, draft: null };
  }

  // ── 5. ② 理解 — consult trigger（FLOOR ?? LLM — 同 worker C1 口徑）──
  const consultTrigger = triggerFloor(message, applyLexicon(message, lex)) ?? result.sessionTrigger ?? null;

  // ── 6. ⑥ 出文 — 報價鏈（同 worker F.4：PRICE 檢索 → buildPriceDraft → price-guard）──
  const priceTrace = { triggered: false, docId: null as string | null, guard: { blocked: false, disclaimerAppended: false, outOfRange: false } };
  let citedPriceDoc = knowledge.picked.find((d) => d.kind === "PRICE") ?? null;
  if (result.intent === "QUESTION" && result.draft !== null) {
    const priceIntent = isPriceIntent(applyLexicon(message, lex));
    priceTrace.triggered = priceIntent;
    if (priceIntent) {
      if (!citedPriceDoc) {
        const catalog = await getKnowledgeCatalog(clinic.id);
        citedPriceDoc = matchPriceDocs(catalog, applyLexicon(message, lex))[0] ?? null;
      }
      if (citedPriceDoc) {
        priceTrace.docId = citedPriceDoc.id;
        const built = buildPriceDraft(citedPriceDoc);
        if (built.text) result = { ...result, draft: built.text };
        else result = { ...result, draft: NO_PRICE_TEXT, needsHuman: true };
      } else {
        result = { ...result, draft: NO_PRICE_TEXT, needsHuman: true };
      }
    }
    if (citedPriceDoc) priceTrace.docId = citedPriceDoc.id;
    const guard = runPriceGuard({ draft: result.draft, priceDoc: citedPriceDoc, priceIntent });
    priceTrace.guard = { blocked: guard.blocked, disclaimerAppended: guard.disclaimerAppended, outOfRange: guard.outOfRange };
    if (guard.blocked) result = { ...result, draft: guard.draft, needsHuman: true };
    else if (guard.disclaimerAppended) result = { ...result, draft: guard.draft };
  }

  // ── 7. 窗口（同 worker P2：沙盤 = 病人而家打字 → 本句到 = 窗口開）──
  const win = getWindowState(new Date());
  const consultGateAction = !win.open && consultTrigger !== null ? "WINDOW_EXPIRED_HANDOFF" : null;

  // ── 8. ⑤ 派俾邊個 — 同一套 resolveEffectiveRules + matchRule + resolvePatientType（跳 claim/audit/notice）──
  let routing: { rule: { id: string; name: string; targetType: string; targetGroupId: string | null; targetStaffId: string | null } | null } = { rule: null };
  try {
    const rules = await resolveEffectiveRules(clinic.id);
    const patientType = await resolvePatientType({ pinnedPatientApricotId: null, waId: null });
    const matched = matchRule(rules, {
      intent: result.intent,
      textRaw: message,
      textCanonical: applyLexicon(message, lex),
      patientType,
      lexicon: lex,
    });
    routing = { rule: matched ? { id: matched.id, name: matched.name, targetType: matched.targetType, targetGroupId: matched.targetGroupId, targetStaffId: matched.targetStaffId } : null };
  } catch (err) {
    sLog.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox: routing fail-soft");
  }

  // ── 9. ③ 對話模式 — CONSULT engine（同純函數 + Redis state；唔落 ConsultSession/AuditLog）──
  let consultTransitionResult: TransitionResult | null = null;
  let consultCreated = false;
  let suppressDraft = false;
  let consultAction: string | null = null;
  let consultSettings: Awaited<ReturnType<typeof loadConsultSettings>> | null = null;
  if (consultTrigger !== null && (st.state === null || st.state.terminal === null)) {
    if (st.state === null || st.state.terminal !== null) {
      st.state = freshConsultState(consultTrigger);
      consultCreated = true;
    }
    const state = st.state;
    consultSettings = await loadConsultSettings(prisma, clinic.id).catch(() => null);
    const settings = consultSettings;
    const namedProduct = await matchNamedProduct(prisma, clinic.id, consultTrigger, `${message} ${applyLexicon(message, lex)}`);
    const priceAskCount = state.slots.meta?.priceAskCount ?? 0;
    const textSignals = detectConsultSignals({
      canonicalText: applyLexicon(message, lex),
      rawText: message,
      workflow: state.workflow,
      external: { redFlagHit: rf.hit, complaint: result.intent === "COMPLAINT", windowExpired: !win.open, namedProduct },
    });
    const sig = {
      ...textSignals,
      intentDelta: computePurchaseIntentDelta(applyLexicon(message, lex), message, { priceAskCount, asksPrice: textSignals.asksPrice }),
      idleExpired: false,
    };
    const transition = consultTransition(state, sig, settings
      ? {
          maxTurns: settings.advanced.maxTurns,
          ctaAfterTurns: settings.advanced.ctaAfterTurns,
          disabledRules: settings.disabledRules,
          discovery: { skipSlots: settings.discoverySkipSlots },
        }
      : undefined);
    consultTransitionResult = transition;
    consultAction = transition.action;
    // ── persist 到 Redis state（同 runner step 5 嘅欄語義；processed:false 零改動）──
    if (transition.processed) {
      const updatedObjection = transition.objection;
      const objections = updatedObjection
        ? [...state.objections.filter((o) => o.type !== updatedObjection.type), updatedObjection]
        : state.objections;
      const slots: Record<string, unknown> = { ...state.slots };
      if (sig.asksPrice) slots.meta = { ...(slots.meta as object | undefined), priceAskCount: priceAskCount + 1 };
      const askedSlots =
        transition.askedSlot && !state.askedSlots.includes(transition.askedSlot)
          ? [...state.askedSlots, transition.askedSlot]
          : state.askedSlots;
      st.state = {
        ...state,
        stage: transition.stage,
        turnCount: state.turnCount + 1,
        purchaseIntent: transition.intentAfter,
        lastAction: transition.action,
        objections,
        askedSlots,
        ctaGiven: transition.ctaGiven,
        terminal: transition.terminal !== null ? transition.terminal : state.terminal,
        candidateCategory: transition.candidateCategory !== null ? transition.candidateCategory : state.candidateCategory,
        slots: sig.asksPrice ? (slots as ConsultSessionState["slots"]) : state.slots,
      };
    }
    if (transition.action === "END_SESSION") suppressDraft = true;
    // ★ 鐵律 3：HANDOFF_HUMAN / PAIN_TRIAGE terminal → 只顯示，唔建 StaffNotice
  }

  // ── 10. ⑥ 出文 — CONSULT LLM（同 worker C4 gate：8 action + processed + intent/urgency 未壓）──
  let extractFailed = false;
  if (
    result.draft !== null &&
    consultTransitionResult &&
    consultTransitionResult.processed === true &&
    consultAction !== null &&
    CONSULT_LLM_ACTIONS.has(consultAction) &&
    result.intent !== "URGENT_PAIN" &&
    result.intent !== "COMPLAINT" &&
    result.urgency !== "HIGH"
  ) {
    try {
      // 1. usable 產品（同 runner：isProductUsable 鐵律 — unapproved 永遠唔入 prompt）
      const products = await prisma.consultProduct.findMany({
        where: { workflow: consultTrigger!, OR: [{ clinicId: clinic.id }, { clinicId: null }] },
        orderBy: { sortOrder: "asc" },
      });
      const usable = products.filter(isProductUsable);
      const usableProducts: ConsultLlmProductCtx[] = usable.map((p) => ({
        code: p.code,
        displayName: p.displayName,
        brand: p.brand,
        timeWording: p.timeWording,
        avoidPhrases: p.avoidPhrases,
      }));
      // 2. Call #1 抽槽（同 function；失敗 = 降級保留原 draft，state 不變）
      let extract: Awaited<ReturnType<typeof consultExtractSlots>>;
      try {
        extract = await consultExtractSlots({
          text: message,
          workflow: consultTrigger!,
          recent: ctxMessages.map((m) => ({ direction: m.direction, body: m.body })),
        });
        llmCalls += 1;
      } catch (err) {
        extractFailed = true;
        sLog.warn({ clinic: clinic.code, err: err instanceof Error ? err.message : String(err) }, "sandbox: extract failed — 保留原 draft");
        extract = null as unknown as typeof extract;
      }
      if (extract) {
        // slot merge（同 persistConsultExtraction latest-wins + clinicalSuitability/meta 鐵律 guard）
        if (st.state) {
          const cur = st.state.slots ?? {};
          const next: Record<string, unknown> = { ...cur };
          for (const [k, v] of Object.entries(extract.slotUpdates ?? {})) {
            if (k === "clinicalSuitability" || k === "meta") continue; // 鐵律
            next[k] = v;
          }
          st.state = { ...st.state, slots: next as ConsultSessionState["slots"] };
        }
        // 3. Call #2 生成（同 payload 欄位 — MD §6.2）
        const payload = {
          action: consultAction,
          stage: consultTransitionResult.stage,
          workflow: consultTrigger!,
          candidateCategory: consultTransitionResult.candidateCategory,
          products: usable.map((p) => ({
            displayName: p.displayName,
            positioning: p.positioning,
            approvedWording: p.approvedWording,
            timeWording: p.timeWording,
          })),
          priceRange: citedPriceDoc
            ? { min: citedPriceDoc.priceMin, max: citedPriceDoc.priceMax, shortDisclaimer: selectPriceDisclaimer(citedPriceDoc) }
            : null,
          avoidPhrases: [...new Set(usable.flatMap((p) => p.avoidPhrases))],
          discoveryQuestion:
            consultAction === "ASK_DISCOVERY"
              ? consultDiscoveryQuestion(consultTrigger!, consultTransitionResult.askedSlot, consultSettings?.discoveryQuestionOverrides ?? undefined)
              : null,
          recentMessages: ctxMessages
            .filter((m) => typeof m.body === "string" && m.body.trim().length > 0)
            .slice(-6)
            .map((m) => ({ direction: (m.direction === "IN" ? "IN" : "OUT") as "IN" | "OUT", body: m.body as string })),
        };
        const gen = await consultGenerateDraft(payload);
        llmCalls += 1;
        if (gen.text) {
          let finalDraft: string = gen.text;
          result = { ...result, draft: finalDraft, model: gen.model ?? result.model };
          // price-guard 重跑（同 worker — consult draft 取代咗舊 draft）
          const pg = runPriceGuard({ draft: finalDraft, priceDoc: citedPriceDoc, priceIntent: priceTrace.triggered });
          priceTrace.guard = { blocked: pg.blocked, disclaimerAppended: pg.disclaimerAppended, outOfRange: pg.outOfRange };
          if (pg.blocked) {
            finalDraft = pg.draft;
            result = { ...result, draft: pg.draft, needsHuman: true };
          } else if (pg.disclaimerAppended) {
            finalDraft = pg.draft;
            result = { ...result, draft: pg.draft };
          }
          // claim guard（同 worker §5 — BLOCK → 棄用草稿 → 人手提示 + needsHuman）
          const cg = runClaimGuard({
            draft: finalDraft,
            products: usableProducts.map((p) => ({ ...p })),
            hasBackendSlot: false,
            priceDoc: citedPriceDoc ? { priceMin: citedPriceDoc.priceMin, priceMax: citedPriceDoc.priceMax } : null,
          });
          if (cg.blocked && cg.code) {
            sLog.warn({ clinic: clinic.code, code: cg.code }, "sandbox: claim-guard blocked");
            result = { ...result, draft: cg.draft, needsHuman: true };
          }
        }
      }
    } catch (err) {
      // 同 runner fail-soft：保留原 draft（對話照行）
      sLog.warn({ clinic: clinic.code, err: err instanceof Error ? err.message : String(err) }, "sandbox: consult llm turn failed — 保留原 draft");
    }
  }

  // ── 11. ⑦ 發唔發 — 同一套 getAutomationLevel（讀）+ blocks 顯示（唔發）──
  const level = await getAutomationLevel(clinic.id, result.intent);
  const blocks: string[] = [];
  if (result.intent === "URGENT_PAIN" || result.urgency === "HIGH") blocks.push("急症/高緊急 — 任何模式永不自動發");
  if (rf.hit) blocks.push("紅旗命中 — 轉真人（沙盤只顯示）");
  if (suppressDraft) blocks.push("病人叫停/推搪（END_SESSION）— 唔覆");
  if (result.draft === null) blocks.push("無草稿");
  if (result.needsHuman) blocks.push("needsHuman — 只草稿俾職員");
  if (!win.open) blocks.push("窗口已過 — COPY_ONLY");
  if (level === "L1") blocks.push("L1 — 只出草稿俾職員");
  if ((level === "L3" || level === "L4") && result.intent === "BOOKING_REQUEST")
    blocks.push("L3/L4 — 真 pipeline 開 booking slot-filling session（沙盤唔開）");
  const willAutoSend = level === "L2" && blocks.length === 0 && result.draft !== null;

  // ── 12. 草稿最終判定 + draftMode（同 worker P2/M-1/M-3 語義）──
  const consultWindowExpired = !win.open && consultTrigger !== null;
  const consultTakeoverSuppressed = st.state?.humanTookOver === true && consultTrigger !== null;
  let finalDraft: string | null = result.draft;
  let draftMode: string | null = finalDraft === null ? "NO_DRAFT" : win.open ? "NORMAL" : "COPY_ONLY";
  if (consultWindowExpired || consultTakeoverSuppressed) {
    finalDraft = null;
    draftMode = "NO_DRAFT";
    blocks.push(consultWindowExpired ? "consult 過窗 — 唔出 free-form 草稿" : "店員接手（humanTookOver）— 停出草稿");
  }
  if (finalDraft !== null) {
    // OUT = 沙盤草稿入 context（下輪 LLM 睇到 — 同真 pipeline 對話歷史口徑）
    st.messages.push({ dir: "OUT", body: finalDraft, ts: new Date().toISOString() });
    if (st.messages.length > 20) st.messages = st.messages.slice(-20);
  }

  // ── 13. 七步摘要（顯示順序 = 老細批准嘅七步；執行順序 = 真 pipeline）──
  const steps: SandboxStep[] = [];
  // ① 安全閘
  steps.push(
    rf.hit
      ? {
          n: 1, name: STEP_NAMES[1], status: "ok",
          summary: `紅旗命中：${rf.categories.join("、")}（${rf.terms.slice(0, 3).join("、")}）→ 轉真人（只顯示）`,
          detail: { hit: true, categories: rf.categories, terms: rf.terms },
        }
      : { n: 1, name: STEP_NAMES[1], status: "ok", summary: "無紅旗詞（FLOOR ∪ 附加詞）", detail: { hit: false } }
  );
  // ② 理解
  steps.push({
    n: 2, name: STEP_NAMES[2], status: "ok",
    summary: `${result.intent}（conf ${result.confidence?.toFixed(2) ?? "—"}）${consultTrigger ? ` · consult trigger：${consultTrigger}` : ""}`,
    detail: { intent: result.intent, confidence: result.confidence, urgency: result.urgency, needsHuman: result.needsHuman, consultTrigger, sessionTriggerLlm: result.sessionTrigger ?? null },
  });
  // ③ 對話模式
  if (consultTransitionResult) {
    const s = st.state!;
    steps.push({
      n: 3, name: STEP_NAMES[3],
      status: s.terminal ? "paused" : "ok",
      summary: `${consultTrigger} session ${consultCreated ? "（新開）" : ""}：${state_stage_before(consultTransitionResult, s)} → ${s.stage}（row ${consultTransitionResult.row} / ${consultAction}）${s.terminal ? ` · 終止：${s.terminal}` : ""}`,
      detail: {
        workflow: consultTrigger, created: consultCreated, row: consultTransitionResult.row, action: consultAction,
        stage: s.stage, stageBefore: consultTransitionResult.stage, terminal: s.terminal,
        turnCount: s.turnCount, purchaseIntent: s.purchaseIntent, suppressDraft, gate: consultGateAction,
      },
    });
  } else if (consultTrigger !== null) {
    steps.push({ n: 3, name: STEP_NAMES[3], status: "paused", summary: `consult trigger（${consultTrigger}）但引擎未處理（${consultGateAction ?? "gate"}）`, detail: { consultTrigger, gate: consultGateAction } });
  } else {
    const mode = result.intent === "BOOKING_REQUEST" ? "booking（L3/L4 先開 slot-filling — 沙盤唔開）" : result.intent === "PAIN" ? "痛症問診（沙盤唔開 session）" : "普通對話";
    steps.push({ n: 3, name: STEP_NAMES[3], status: "skip", summary: `— ${mode}（無 consult trigger）`, detail: { mode } });
  }
  // ④ 搵資料
  steps.push({
    n: 4, name: STEP_NAMES[4], status: knowledge.picked.length > 0 ? "ok" : "skip",
    summary: knowledge.picked.length > 0 ? `RAG 揀咗 ${knowledge.picked.length} 條：${knowledge.picked.map((d) => d.title).join("、")}` : "無引用（RAG 零命中 / fail-soft）",
    detail: { ran: knowledge.ran, picked: knowledge.picked.map((d) => ({ id: d.id, kind: d.kind, title: d.title })), citedPriceDocId: priceTrace.docId },
  });
  // ⑤ 派俾邊個
  steps.push(
    routing.rule
      ? {
          n: 5, name: STEP_NAMES[5], status: "ok",
          summary: `命中規則「${routing.rule.name}」→ ${routing.rule.targetType === "GROUP" ? "技能組" : "職員"}（沙盤唔落 assignee）`,
          detail: { ruleId: routing.rule.id, ruleName: routing.rule.name, targetType: routing.rule.targetType, targetGroupId: routing.rule.targetGroupId, targetStaffId: routing.rule.targetStaffId },
        }
      : { n: 5, name: STEP_NAMES[5], status: "skip", summary: "無規則命中（對話留公海）", detail: { rule: null } }
  );
  // ⑥ 出文
  const guardBits: string[] = [];
  if (priceTrace.guard.blocked) guardBits.push("price-guard 攔截");
  if (priceTrace.guard.disclaimerAppended) guardBits.push("補 disclaimer");
  if (priceTrace.guard.outOfRange) guardBits.push("金額出範圍");
  if (extractFailed) guardBits.push("抽槽失敗（降級原草稿）");
  steps.push(
    finalDraft !== null
      ? {
          n: 6, name: STEP_NAMES[6], status: "ok",
          summary: `草稿 ${finalDraft.length} 字${priceTrace.docId ? `（引用 ${citedPriceDoc?.title ?? "PRICE doc"}）` : ""}${guardBits.length ? ` · ${guardBits.join("、")}` : ""}`,
          detail: { draftLen: finalDraft.length, citedPriceDocId: priceTrace.docId, priceIntent: priceTrace.triggered, guard: priceTrace.guard, llmCalls },
        }
      : { n: 6, name: STEP_NAMES[6], status: "skip", summary: `無草稿（${blocks.find((b) => b.includes("無草稿") || b.includes("急症") || b.includes("叫停") || b.includes("過窗") || b.includes("接手")) ?? "gate"}）`, detail: { draft: null } }
  );
  // ⑦ 發唔發
  const isBookingL34 = (level === "L3" || level === "L4") && result.intent === "BOOKING_REQUEST";
  steps.push({
    n: 7, name: STEP_NAMES[7],
    status: willAutoSend ? "ok" : "paused",
    summary: willAutoSend
      ? "L2 全綠 — 真 pipeline 會自動發（沙盤唔發）"
      : isBookingL34
        ? `${level} — booking slot-filling 軌（沙盤唔開 session）`
        : `${level} · 唔自動發：${blocks.slice(0, 2).join("；") || "無草稿"}`,
    detail: { level, willAutoSend, blocks, winOpen: win.open },
  });

  // ── 14. 存 Redis（TTL 30min refresh）+ log（metadata only）──
  st.updatedAt = new Date().toISOString();
  await saveState(input.staffId, st).catch((err) => {
    sLog.error({ err: err instanceof Error ? err.message : String(err) }, "sandbox: redis save failed");
    throw new SandboxError(503, "Redis 斷 — 呢輪結果冇得存");
  });
  const latencyMs = Date.now() - t0;
  sLog.info(
    {
      sandboxId, clinic: clinic.code, turn, intent: result.intent, consultTrigger,
      consultAction, stage: st.state?.stage ?? null, redFlagHit: rf.hit, llmCalls, latencyMs, draft: finalDraft !== null,
    },
    "sandbox: turn done"
  );

  return {
    sandboxId,
    turn,
    steps,
    draft: finalDraft,
    draftMode,
    intent: result.intent,
    urgency: result.urgency,
    needsHuman: result.needsHuman,
    consultTrigger,
    sessionSnapshot: st.state
      ? {
          workflow: st.state.workflow,
          stage: st.state.stage,
          terminal: st.state.terminal,
          turnCount: st.state.turnCount,
          purchaseIntent: st.state.purchaseIntent,
          lastAction: st.state.lastAction,
          askedSlots: st.state.askedSlots,
          slots: (st.state.slots ?? {}) as Record<string, unknown>,
        }
      : null,
    sendVerdict: { level, willAutoSend, blocks },
    latencyMs,
    llmCalls,
  };
}

// ── helpers（step 摘要用 — 零邏輯，純呈現）────────────────────────────

function state_stage_before(t: TransitionResult, after: ConsultSessionState): string {
  // transition.stage = 本輪**開始時**嘅 stage（consultTransition base = session.stage）；
  // after.stage = 更新後。顯示「開始 → 更新後」。
  return t.stage === after.stage ? t.stage : `${t.stage}→${after.stage}`;
}

/**
 * 重啟沙盤（B.5 [重新開始]）：清 Redis key（state + 對話歷史全清；永不落 DB 所以冇 DB 殘留）。
 */
export async function resetSandbox(staffId: string, sandboxId: string): Promise<void> {
  await clearState(staffId, sandboxId);
  sLog.info({ sandboxId, staff: staffId.slice(0, 8) }, "sandbox: reset");
}
