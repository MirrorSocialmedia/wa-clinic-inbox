/**
 * ★ consult v2.1 C2（MD §3.1 Slots）：CONSULT 規則引擎嘅純 TS types。
 *
 * 呢個檔只係 type（零 runtime）— C3 規則引擎 / 抽槽 LLM call #1 用。
 * slot 值存 ConsultSession.slots（Json），shape 由呢度定義；
 * objections 存 ConsultSession.objections（Json[]，ObjectionState[]）。
 *
 * 鐵律：`clinicalSuitability` 永遠唔可以由 AI 改（只有店員可改 — MD §3.1）。
 * Required minimum（C3 守衛口徑）：
 *   箍牙 = appearancePriority 或 speedPriority 至少一個非 null；
 *   植牙 = missingCount 非 null。
 */

// ── Slots（MD §3.1 逐字） ────────────────────────────────────────────────

export interface OrthoSlots {
  treatmentGoal: "CROOKED" | "BITE" | "APPEARANCE" | "OTHER" | null;
  appearancePriority: "HIGH" | "LOW" | null;      // 三態，冇 MEDIUM
  speedPriority: "HIGH" | "LOW" | null;
  budgetSensitivity: "HIGH" | "LOW" | null;
  statedBudget: number | null;
  clinicalSuitability: "UNKNOWN" | "ASSESSED";    // ★ 只有店員可改
  customerProductInterest: "TRAD" | "IGO" | "IFULL" | null;
  previousOrtho: "YES" | "NO" | null;
  timeline: "ASAP" | "WITHIN_3M" | "WITHIN_6M" | "NO_RUSH" | null;
}

export interface ImplantSlots {
  missingCount: "ONE" | "FEW" | "MANY" | null;
  missingDuration: "RECENT" | "OVER_YEAR" | null;
  budgetSensitivity: "HIGH" | "LOW" | null;
  hasSeenDentist: boolean | null;
  customerBrandInterest: string | null;
  clinicalSuitability: "UNKNOWN" | "ASSESSED";
}

export interface ObjectionState {
  type: "PRICE"|"TIME"|"PAIN"|"APPEARANCE"|"TRUST"|"FEAR"|"COMPARISON"|"UNCERTAINTY";
  status: "OPEN" | "HANDLED" | "RECURRED"; count: number; firstAt: string; lastAt: string;
}

export type ConsultAction =
  | "ASK_DISCOVERY" | "EDUCATE_COMPARE" | "EDUCATE_DETAIL" | "PRESENT_OPTIONS" | "ANSWER_PRICE"
  | "HANDLE_OBJECTION" | "BUILD_TRUST" | "ASK_FOR_CONSULTATION" | "START_BOOKING"
  | "WINDOW_EXPIRED_HANDOFF" | "HANDOFF_HUMAN" | "END_SESSION";

// ── workflow / terminal 字面量（MD §3 model 註） ─────────────────────────

export const CONSULT_WORKFLOWS = ["ORTHODONTIC_CONSULT", "IMPLANT_CONSULT"] as const;
export type ConsultWorkflow = (typeof CONSULT_WORKFLOWS)[number];

export const CONSULT_TERMINALS = ["COMPLETED", "HANDOFF", "EXPIRED", "HUMAN_TOOK_OVER"] as const;
export type ConsultTerminal = (typeof CONSULT_TERMINALS)[number];

/** candidateCategory = 類別（唔係產品）— MD §0.1 A：`ConsultSession.recommended` 改名 candidateCategory。 */
export const ORTHO_CATEGORIES = ["CLEAR_ALIGNER", "FIXED"] as const;
export type OrthoCategory = (typeof ORTHO_CATEGORIES)[number];
