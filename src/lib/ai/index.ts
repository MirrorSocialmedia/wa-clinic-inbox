/**
 * AI triage 統一入口（Phase 2）。
 *
 * `classifyAndDraft(input)`：
 * - `AI_MOCK=1` → deterministic mock（同 interface）
 * - 否則 → 真 vLLM（primary 重試 1 次 → fallback 重試 1 次 → breaker）
 *
 * 失敗一律 throw AiCallError — 由 ai.worker 接住做降級（清 draft / 保留舊 intent /
 * inbox 照常可用 + log metadata only）。呢度唔做 fallback 到「冇 AI」嘅靜默處理，
 * 因為降級語義（retry 幾多次、點計 stats）係 worker 嘅決定。
 */
import {
  AiCallError,
  type AiIntent,
  type AiUrgency,
  type ClassifyAndDraftInput,
  type ClassifyAndDraftResult,
} from "./types";
import { AI_INTENTS, AI_URGENCIES } from "./types";
import { mockClassifyAndDraft, isAiMockEnabled, isAiMockFailEnabled, mockSessionTurn, mockPainTurn } from "./mock";
import { chatWithFallback, getAiConfig, getBreakerState } from "./vllm";
import { buildSystemPrompt, buildUserPrompt, CLASSIFY_DRAFT_JSON_SCHEMA } from "./prompts";
import {
  buildSessionSystemPrompt,
  buildSessionUserPrompt,
  SESSION_JSON_SCHEMA,
  type SessionPromptInput,
} from "./session-prompts";
import { SESSION_ACTIONS, type SessionAiOutput } from "./session-types";
import {
  buildPainSystemPrompt,
  buildPainUserPrompt,
  PAIN_JSON_SCHEMA,
  type PainPromptInput,
} from "./pain-prompts";
import { PainSlots, type PainAiOutput, type PainSlotsType, PAIN_ACTIONS } from "@/lib/sessions/pain-triage";
import log from "@/lib/log";

function extractJson(content: string): string {
  let s = content.trim();
  // 容錯：模型偶爾包 code fence
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AiCallError("ai output: no JSON object found");
  }
  return s.slice(start, end + 1);
}

/**
 * 驗證模型輸出（guided_json 已強制結構，呢度 defense in depth）。
 * ★ 錯誤訊息只描述結構問題 — 唔可以回顯 output 內容（可能含病人文字）。
 */
function parseAndValidate(content: string): {
  intent: AiIntent;
  urgency: AiUrgency;
  needsHuman: boolean;
  confidence: number;
  summary: string;
  draft: string | null;
} {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(extractJson(content));
  } catch {
    throw new AiCallError("ai output: invalid JSON");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    throw new AiCallError("ai output: not an object");
  }

  if (!AI_INTENTS.includes(o["intent"] as AiIntent)) {
    throw new AiCallError("ai output: invalid intent");
  }
  if (!AI_URGENCIES.includes(o["urgency"] as AiUrgency)) {
    throw new AiCallError("ai output: invalid urgency");
  }
  const confidence =
    typeof o["confidence"] === "number" && Number.isFinite(o["confidence"])
      ? Math.min(1, Math.max(0, o["confidence"]))
      : 0.5;
  const summary = typeof o["summary"] === "string" ? o["summary"].slice(0, 50) : "";
  const draft =
    typeof o["draft"] === "string" && o["draft"].trim().length > 0 ? o["draft"].trim() : null;

  return {
    intent: o["intent"] as AiIntent,
    urgency: o["urgency"] as AiUrgency,
    needsHuman: Boolean(o["needsHuman"]),
    confidence,
    summary,
    draft,
  };
}

export async function classifyAndDraft(
  input: ClassifyAndDraftInput
): Promise<ClassifyAndDraftResult> {
  // ── mock mode ─────────────────────────────────────────────────────────
  if (isAiMockEnabled()) {
    return mockClassifyAndDraft(input);
  }

  // ── real mode（vLLM） ─────────────────────────────────────────────────
  const cfg = getAiConfig();
  const messages = [
    { role: "system" as const, content: buildSystemPrompt(input.lexiconBlock ?? "") }, // ★ Part E E.8：lexicon 注入
    { role: "user" as const, content: buildUserPrompt(input) },
  ];
  const r = await chatWithFallback(cfg, { messages, guidedJson: CLASSIFY_DRAFT_JSON_SCHEMA });
  const parsed = parseAndValidate(r.content);
  log.debug({ model: r.model, latencyMs: r.latencyMs, tokens: r.tokens }, "ai call ok");
  return { ...parsed, model: r.model, latencyMs: r.latencyMs, tokens: r.tokens };
}

// ── Phase C（cwi-sess-20260824-c1）：slot-filling session turn ─────────
// 每條病人訊息一次 LLM call；LLM 只出語氣句 + slotUpdates 抽取（事實鐵律）。

export async function classifySessionTurn(input: SessionPromptInput): Promise<SessionAiOutput> {
  if (isAiMockEnabled()) return mockSessionTurn(input); // C3.4 決定性 mock
  const cfg = getAiConfig();
  const messages = [
    { role: "system" as const, content: buildSessionSystemPrompt() },
    { role: "user" as const, content: buildSessionUserPrompt(input) },
  ];
  const r = await chatWithFallback(cfg, { messages, guidedJson: SESSION_JSON_SCHEMA });
  return parseSessionOutput(r.content);
}

/**
 * parse 端驗證（sglang 忽略 guided_json → 三重保險第三層）。
 * ★ 錯誤訊息只描述結構問題 — 唔可以回顯 output 內容（可能含病人文字）。
 */
export function parseSessionOutput(content: string): SessionAiOutput {
  let raw: string;
  try {
    raw = extractJson(content);
    // JSON.parse 喺呢度包住 → SyntaxError 都轉 AiCallError（worker 統一 catch AiCallError）
  } catch (err) {
    if (err instanceof AiCallError) throw err;
    throw new AiCallError("ai output: invalid JSON");
  }
  const o = JSON.parse(raw) as Record<string, unknown>;
  const su = (o["slotUpdates"] ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const date = str(su["date"]);
  const time = str(su["time"]);
  const tod = str(su["timeOfDay"]);
  const action = SESSION_ACTIONS.includes(o["action"] as (typeof SESSION_ACTIONS)[number])
    ? (o["action"] as (typeof SESSION_ACTIONS)[number])
    : "CONTINUE";
  return {
    slotUpdates: {
      providerName: str(su["providerName"]),
      date: date && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date) ? date : null, // 格式/範圍唔啱當冇講（2026-13-99 → null）
      time: time && /^\d{2}:\d{2}$/.test(time) ? time : null,
      timeOfDay: tod === "MORNING" || tod === "AFTERNOON" || tod === "EVENING" ? tod : null,
    },
    action,
    reply: typeof o["reply"] === "string" ? o["reply"].slice(0, 200) : "",
  };
}

// ── ★ Part E（cwi-paintriage-20260903）：PAIN_TRIAGE 抽槽 turn ───────────────
// 鐵律：LLM 只抽槽唔判級 — 紅旗升級由 worker 嘅 evaluateRedFlags（確定性）決定。

export async function classifyPainTurn(input: PainPromptInput): Promise<PainAiOutput> {
  if (isAiMockEnabled()) return mockPainTurn(input); // 決定性 mock（e2e T97–T103）
  const cfg = getAiConfig();
  const messages = [
    { role: "system" as const, content: buildPainSystemPrompt(input) },
    { role: "user" as const, content: buildPainUserPrompt(input) },
  ];
  const r = await chatWithFallback(cfg, { messages, guidedJson: PAIN_JSON_SCHEMA });
  return parsePainOutput(r.content);
}

/** parse 端驗證（同 parseSessionOutput 模式；結構問題先 throw，內容永不入錯誤訊息）。 */
export function parsePainOutput(content: string): PainAiOutput {
  let raw: string;
  try {
    raw = extractJson(content);
  } catch (err) {
    if (err instanceof AiCallError) throw err;
    throw new AiCallError("ai output: invalid JSON");
  }
  const o = JSON.parse(raw) as Record<string, unknown>;
  const parsedSlots = PainSlots.safeParse(o["slotUpdates"] ?? {});
  const su = parsedSlots.success ? parsedSlots.data : PainSlots.parse({});
  // 只保留「有值」嘅欄當更新（null/undefined/空 array = 未講）— merge 層再 union
  const upd: Partial<PainSlotsType> = {};
  if (su.toothLocation !== null) upd.toothLocation = su.toothLocation;
  if (su.durationDays !== null) upd.durationDays = su.durationDays;
  if (su.severity !== null) upd.severity = su.severity;
  if (su.stimulusLinger !== null) upd.stimulusLinger = su.stimulusLinger;
  if (su.spontaneousPain !== null) upd.spontaneousPain = su.spontaneousPain;
  if (su.nightPain !== null) upd.nightPain = su.nightPain;
  if (su.bitePain !== null) upd.bitePain = su.bitePain;
  if (su.swelling !== null) upd.swelling = su.swelling;
  if (su.functionalImpact.length > 0) upd.functionalImpact = su.functionalImpact;
  if (su.redFlagSymptoms.length > 0) upd.redFlagSymptoms = su.redFlagSymptoms;
  if (su.recentTreatment !== null) upd.recentTreatment = su.recentTreatment;
  if (su.photoOffered === true) upd.photoOffered = true;
  const action = PAIN_ACTIONS.includes(o["action"] as (typeof PAIN_ACTIONS)[number])
    ? (o["action"] as (typeof PAIN_ACTIONS)[number])
    : "CONTINUE";
  return { slotUpdates: upd, action, reply: typeof o["reply"] === "string" ? o["reply"].slice(0, 200) : "" };
}

export interface AiRuntimeInfo {
  mode: "mock" | "real";
  mockFail: boolean;
  primaryModel: string;
  fallbackModel: string;
  baseUrlConfigured: boolean;
  breaker: { state: "closed" | "open"; openUntilMs: number | null };
}

/** admin AI 狀態卡用嘅 runtime 快照（唔含 stats/probe — 嗰啲喺 lib/ai/stats + health）。 */
export function getAiRuntimeInfo(): AiRuntimeInfo {
  const cfg = getAiConfig();
  return {
    mode: isAiMockEnabled() ? "mock" : "real",
    mockFail: isAiMockFailEnabled(),
    primaryModel: cfg.primaryModel,
    fallbackModel: cfg.fallbackModel,
    baseUrlConfigured: cfg.baseUrl.length > 0,
    breaker: getBreakerState(),
  };
}

export { AiCallError } from "./types";
export type { ClassifyAndDraftInput, ClassifyAndDraftResult, AiIntent, AiUrgency, AiContextMessage } from "./types";
export { isAiMockEnabled, isAiMockFailEnabled } from "./mock";
export { getAiConfig, getBreakerState } from "./vllm";
export type { SessionAiOutput, SessionSlots, SessionAction } from "./session-types";
export type { SessionPromptInput } from "./session-prompts";
export type { PainPromptInput } from "./pain-prompts";
export type { PainAiOutput, PainSlotsType } from "@/lib/sessions/pain-triage";
export { checkAiHealth, type AiHealth } from "./health";
export { getAiCallStats, recordAiCall, type AiCallStatsRow } from "./stats";
