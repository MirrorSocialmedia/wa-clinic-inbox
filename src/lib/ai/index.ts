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
import { mockClassifyAndDraft, isAiMockEnabled, isAiMockFailEnabled } from "./mock";
import { chatWithFallback, getAiConfig, getBreakerState } from "./vllm";
import { buildSystemPrompt, buildUserPrompt, CLASSIFY_DRAFT_JSON_SCHEMA } from "./prompts";
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
export { checkAiHealth, type AiHealth } from "./health";
export { getAiCallStats, recordAiCall, type AiCallStatsRow } from "./stats";
