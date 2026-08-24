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
import { mockClassifyAndDraft, isAiMockEnabled, isAiMockFailEnabled, mockSessionTurn } from "./mock";
import { chatWithFallback, getAiConfig, getBreakerState } from "./vllm";
import { buildSystemPrompt, buildUserPrompt, CLASSIFY_DRAFT_JSON_SCHEMA } from "./prompts";
import {
  buildSessionSystemPrompt,
  buildSessionUserPrompt,
  SESSION_JSON_SCHEMA,
  type SessionPromptInput,
} from "./session-prompts";
import { SESSION_ACTIONS, type SessionAiOutput } from "./session-types";
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
    { role: "system" as const, content: buildSystemPrompt() },
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
export { checkAiHealth, type AiHealth } from "./health";
export { getAiCallStats, recordAiCall, type AiCallStatsRow } from "./stats";
