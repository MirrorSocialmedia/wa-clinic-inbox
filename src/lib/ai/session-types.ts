/**
 * ★ AI Workflow Phase C（cwi-sess-20260824-c1）：slot-filling 對話式預約 — AI 層類型。
 *
 * SessionSlots 只存 business metadata（醫生 id/名、日期、時間、時段偏好）—
 * 零病人自由文本落庫（PII 鐵律）。所有欄位必須經 engine 驗證過先算數（見 session-engine.ts）。
 */
export interface SessionSlots {
  providerApricotId?: string | null;
  providerName?: string | null;
  date?: string | null; // YYYY-MM-DD（engine 驗證過先算數）
  time?: string | null; // HH:mm（engine 對 getSlots 驗證過先算數）
  timeOfDay?: "MORNING" | "AFTERNOON" | "EVENING" | null;
}

export const SESSION_ACTIONS = ["CONTINUE", "CONFIRM", "CANCEL", "OFF_TOPIC", "HUMAN", "URGENT"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export interface SessionAiOutput {
  slotUpdates: SessionSlots; // 只含今條訊息新講嘅嘢；冇更新 = 全 null
  action: SessionAction;
  reply: string; // 語氣句（≤2 句）；事實句 engine 另砌
}
