/**
 * ★ cwi-hub-b-20260914（Part B B.3）：AI 流程沙盤 — 真 pipeline 同款 function、零副作用。
 *
 * 鐵律（MD B.3.1，最高優先）：
 * 1. 走真 pipeline **同一套 function**（跟 src/workers/ai.worker.ts 非 session 主路徑逐段對應 —
 *    S0 inventory 喺 /tmp/kairo-progress-cwi-hub-b-20260914.md；S6 T366 e2e 斷言同真 worker 一致）。
 * 2. mode 分支**只准喺持久化同發送層**：本檔零 prisma.create/update/delete（全唯讀）、
 *    零 publishNotify / pushEvent / enqueueOutboundSend / recordAiCall / AuditLog。
 * 3. 紅旗命中 → 只顯示結果（steps[0] detail），唔建 StaffNotice、唔標 URGENT。
 * 4. 真 LLM call（主 classify / RAG 檢索 / consult extract / consult generate —
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
 * | runConsultEngineTurn   | ★ cwi-hubaudit S2：同一 function `runConsultEngineTurn`（session 讀寫經 redisConsultStore —
 *                         ConsultStore 唯一 mode 分岔點；terminal 副作用 no-op）|
 * | runConsultLlmTurn      | ★ cwi-hubaudit S2：同一 function `runConsultLlmTurn`（extract/generate/persistExtraction
 *                         同一份 + store）+ `runPriceGuard` + `runClaimGuard`（同 worker C4 順序）|
 * | AiDraft create         | 唔建（draft 字串直接回傳）                                        |
 * | AUTO 發 + socket + push| 唔發（⑦ 步只算 level + blocks 顯示）                              |
 * | booking/PAIN session   | 唔開（slot-filling session 唔屬 CONSULT 多輪範圍 — B.5 沙盤多輪 = consult engine）|
 */
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getRedis } from "@/lib/queue";
import {
  buildAiContext,
  runInboundAi,
  noopPersistPort,
  type InboundConvRef,
  type InboundAiOutcome,
} from "@/lib/ai/pipeline";
import { clearAutomationLevelCache } from "@/lib/ai/automation";
import { bustParamsCache } from "@/lib/workflow/store";
import { bustLexiconCache } from "@/lib/sessions/lexicon";
import {
  type ConsultSessionState,
  type TransitionResult,
} from "@/lib/sessions/consult-engine";
import { redisConsultStore } from "@/lib/sessions/consult-store";
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

  // ★ cwi-hubaudit-20260915（S1 H-1 修復）：觸發訊息（當前句）**必喺** ctxMessages — 同 worker
  //   `buildAiContext` 同一組裝點（worker 口徑：觸發訊息已喺 DB，ctxMessages 包含佢）。
  //   舊 `.slice(0, -1)` 係把 RAG-context 規則誤套落 ctxMessages 本身（H-2 平行實作分岔）→
  //   第一輪零輸入無草稿、第二輪答上一輪。
  const ctxMessages = buildAiContext(st.messages);

  // ── 2–10. ①〜⑥ 計算核心 → `runInboundAi`（★ cwi-hubaudit S4：同 worker 同一 function）──
  //   RAG → classify → 紅旗 → consult trigger → 報價鏈 → COMPLAINT → 窗口 → 分類（in-memory 副本）
  //   → 路由（display subset）→ consult engine turn → consult LLM turn（+price/claim guard）
  //   → canDraft → AUTO level+blocks（machine gates，⑦ 步顯示用同一份）。
  //   mode 分岔只喺 `noopPersistPort`（零 DB 寫 / 零通知 / 零用量統計 — 鐵律 3）
  //   + `redisConsultStore`（consult session 讀寫 — 同 worker 嘅 prisma store 同一 interface）。
  //   窗口判定照真 pipeline：本句到 = 窗口開（convRef.lastInboundAt = now — 同舊 getWindowState(new Date())）。
  const convRef: InboundConvRef = {
    id: sandboxId,
    clinicId: clinic.id,
    contactId: `sbx-${sandboxId}`,
    lastInboundAt: new Date(),
    assigneeId: null,
    status: "OPEN",
    humanTookOver: st.state?.humanTookOver ?? false,
    lastOutboundText: null,
    urgent: false,
    resolvedAt: null,
    reopenedAt: null,
    lastOutboundAt: null,
    pinnedPatientApricotId: null,
    routedRuleId: null,
  };
  const sandboxStore = redisConsultStore({
    getSession: () => st.state,
    setSession: (s) => {
      st.state = s;
    },
    sessionId: `sbx-${sandboxId}`,
  });
  const sandboxPort = noopPersistPort({ clinicCode: clinic.code });
  let outcome: InboundAiOutcome;
  try {
    outcome = await runInboundAi({
      clinic,
      msg: { id: `sbx-msg-${turn}`, type: "text", body: message, waMessageId: null, aiDraftId: null },
      conv: convRef,
      contact: null,
      ctxMessages,
      isMedia: false,
      consultStore: sandboxStore,
      persist: sandboxPort,
    });
  } catch (err) {
    // 同 worker 降級語義：classify 失敗 = state 唔改（回滾呢輪 push 嘅 IN）+ 502
    if (sandboxPort.classifyFailed) {
      st.messages.pop();
      throw new SandboxError(502, "AI 服務唔通（sglang 失敗）— 呢輪無結果，state 原封");
    }
    throw err;
  }
  const {
    result,
    knowledge,
    priceTrace,
    citedPriceDoc,
    rf,
    consultTrigger,
    win,
    consultGateAction,
    routing,
    consultOutcome,
    autoLevel: level,
    canDraft,
    draftMode: pipelineDraftMode,
    consultWindowExpired,
    consultTakeoverSuppressed,
    extractFailed,
  } = outcome;
  const suppressDraft = consultOutcome?.suppressDraft ?? false;
  const consultCreated = consultOutcome?.created ?? false;
  const consultAction = consultOutcome?.action ?? null;
  const engineTransition = consultOutcome?.transition ?? null;
  const llmCalls = (knowledge.ran ? 1 : 0) + 1 + outcome.consultLlmCalls;
  // ── 11. ⑦ 發唔發 — 同一套 getAutomationLevel（讀）+ blocks 顯示（唔發）──
  // ★ S4：level = runInboundAi 算好嘅 autoLevel（同一個 getAutomationLevel + 5min cache）
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

  // ── 12. 草稿最終判定 + draftMode（★ S4：canDraft/draftMode 由 runInboundAi 算好 — 同 worker 同一判定點）──
  const finalDraft: string | null = canDraft ? result.draft : null;
  const draftMode: string | null = canDraft ? pipelineDraftMode : "NO_DRAFT";
  if (!canDraft && consultWindowExpired) blocks.push("consult 過窗 — 唔出 free-form 草稿");
  else if (!canDraft && consultTakeoverSuppressed) blocks.push("店員接手（humanTookOver）— 停出草稿");
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
  if (engineTransition) {
    const s = st.state!;
    steps.push({
      n: 3, name: STEP_NAMES[3],
      status: s.terminal ? "paused" : "ok",
      summary: `${consultTrigger} session ${consultCreated ? "（新開）" : ""}：${state_stage_before(engineTransition, s)} → ${s.stage}（row ${engineTransition.row} / ${consultAction}）${s.terminal ? ` · 終止：${s.terminal}` : ""}`,
      detail: {
        workflow: consultTrigger, created: consultCreated, row: engineTransition.row, action: consultAction,
        stage: s.stage, stageBefore: engineTransition.stage, terminal: s.terminal,
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
  // transition.stage = 本輪**開始時**嘅 stage（engine transition base = session.stage）；
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
