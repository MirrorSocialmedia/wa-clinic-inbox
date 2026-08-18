/**
 * AI triage 共用型別（框架 MD §7 + Phase 2 任務規格）。
 *
 * ★ PII 鐵律：
 * - 呢啲型別入面嘅 `summary` / `draft` 係病人訊息嘅衍生內容 —
 *   只准落 DB / 經 Socket 推自己 VPS 嘅前端，**永不入 log**。
 * - log 只准 metadata：intent / urgency / model / latencyMs / tokens / clinic / wamid。
 */

export const AI_INTENTS = [
  "BOOKING_REQUEST",
  "QUESTION",
  "URGENT_PAIN",
  "OUT_OF_SCOPE",
  "OTHER",
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

export const AI_URGENCIES = ["LOW", "MED", "HIGH"] as const;
export type AiUrgency = (typeof AI_URGENCIES)[number];

/** 餵入 AI 嘅上下文訊息（最近 N 條，含 in/out，HISTORY 都算 context）。 */
export interface AiContextMessage {
  direction: "IN" | "OUT";
  channel: string;
  type: string;
  /** 文字內容 — 只進入本地 vLLM prompt（D4：AI 全本地，唔去任何第三方） */
  body: string | null;
  waTimestamp: Date;
}

export interface AiClinicInfo {
  name: string;
  /** Clinic.greetingConfig（Json?）：地址/營業時間/醫生名單/FAQ — 草稿嘅唯一事實來源 */
  greetingConfig: Record<string, unknown> | null;
}

export interface ClassifyAndDraftInput {
  /** 按 waTimestamp 升序（舊 → 新），最後一條通常係觸發嘅 inbound */
  messages: AiContextMessage[];
  clinic: AiClinicInfo;
}

/**
 * 統一分類 + 草稿輸出（mock 同真 client 同一 shape）。
 * `draft = null` 嘅情況：intent=URGENT_PAIN（鐵律）/ needsHuman=true / urgency=HIGH。
 */
export interface ClassifyAndDraftResult {
  intent: AiIntent;
  urgency: AiUrgency;
  needsHuman: boolean;
  confidence: number;
  /** ≤50 字摘要，語言跟病人（繁中/英/粵）— 入 Conversation.aiSummary */
  summary: string;
  /** 建議覆 reply（只係建議；staff 一鍵採用先入 composer，發送仍係人手） */
  draft: string | null;
  model: string;
  latencyMs: number;
  tokens: number;
}

/** AI call 失敗（超時 / 連唔到 / fallback 都失敗 / 輸出不合 schema）。 */
export class AiCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiCallError";
  }
}
