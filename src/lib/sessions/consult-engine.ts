/**
 * ★ consult v2.1 C3（MD §4 規則引擎 — 純函數，零 LLM）：CONSULT 銷售 session 每輪 transition。
 *
 * 鐵律：
 * - 本檔 = **純函數**（零 IO / 零 DB / 零 LLM）— 所有輸入由 caller（consult-runner / e2e / unit）傳入。
 * - Transition table 25 行由上而下 **first match wins**（MD §4.2 逐字）。
 * - `allowClinicalSelection` 永遠 false — 冇任何規則會產生「呢款最適合你」（MD §4.3 註）。
 * - 植牙唔做任何產品建議（MD §4.4 — IMPLANT_RULES 冇 candidateCategory derive）。
 *
 * 口徑決定（C3 記錄 — MD 冇寫死嘅位）：
 * - #9 高意向 lexical = booking 行為詞（幾時有位/點約/幫我約/星期X得唔得…）。「我想做/決定咗」
 *   只貢獻 purchaseIntent Δ+0.4（§4.5），唔單方面觸發 #9 — 依 GC-09（「我想cool牙，咩收費？」→
 *   PRESENT_OPTIONS）+ GC-13（「我想箍牙，最緊要靚」→ PRESENT_OPTIONS）；「我想做 I GO，幾時有位？」
 *   靠「幾時有位」觸發 #9（GC-12）。
 * - START_BOOKING（#9/#20/#21）= stage BOOKING + terminal COMPLETED — MD terminal 清單
 *   （HANDOFF/COMPLETED/EXPIRED/HUMAN_TOOK_OVER）唔含 BOOKING；成功嘅 consult 以 COMPLETED 結束，
 *   交返既有 booking flow（避免 48h cron 誤 EXPIRED 成功 session + T244 守門 ④ 永久擋 auto-resolve）。
 * - #4（窗口已過）/ #6（humanTookOver）= processed:false — 該 inbound 唔係已處理 consult turn
 *   （C1 gate 已擋草稿 + conv.consultGateAction 已記錄）→ turnCount 唔加、idle 時鐘唔洗。
 * - #8 判定用**本輪更新後**嘅 PRICE count（GC-18：「太貴啦」→「五萬真係好貴」= 第二句即 count=2
 *   RECURRED → HANDOFF_HUMAN）。
 * - purchaseIntent 評估值 = 現有 intent + 本輪 Δ（§1 流：call #1 抽 signal → engine 判定）；clamp 0–1。
 * - row -1 = 冇任何 row 命中（stay）— 只可能喺 EDUCATE/PRESENT_OPTIONS/CONSULTATION 嘅中性訊息。
 * - slots.meta.priceAskCount = engine meta（§4.5「第二次或以上問價」計數器；JSON 欄，零 migration）。
 * - #23（48h 無 inbound）= cron 路徑 — per-turn 由 `sig.idleExpired` 傳入（per-turn caller 永遠 false；
 *   cron sweep 經 applyIdleExpiry + 本表 row 23）。follow-up = audit/log placeholder
 *   （FollowupTask model 本 repo 未實施 — 只記錄，唔開 model）。
 */
import {
  type ConsultWorkflow,
  type OrthoSlots,
  type ImplantSlots,
  type ObjectionState,
} from "./consult-types";

// ── 常數（MD §4.2/§4.5） ──────────────────────────────────────────────

export const CONSULT_MAX_TURNS = 8; // #7 maxTurns
export const CONSULT_CTA_AFTER_TURNS = 6; // #24 ctaAfterTurns
export const CONSULT_HIGH_INTENT_THRESHOLD = 0.6; // §4.5 高意向
export const CONSULT_IDLE_EXPIRE_HOURS = 48; // #23 預設（env CONSULT_SESSION_IDLE_HOURS 可覆寫 — Tab 3 UI = C5）
export const CONSULT_EXPIRE_INTENT_DELTA = -0.15; // §4.5 第 7 行

export const CONSULT_STAGES = [
  "DISCOVER",
  "EDUCATE",
  "PRESENT_OPTIONS",
  "CONSULTATION",
  "BOOKING",
  "HANDOFF",
  "COMPLETED",
  "EXPIRED",
] as const;
export type ConsultStage = (typeof CONSULT_STAGES)[number];

/** 引擎 action 字面 = C2 ConsultAction 字面量 ∪ C3 新增兩個（PAIN_TRIAGE = #1「轉 PAIN_TRIAGE」；NO_DRAFT = #6「唔出草稿」）。 */
export type EngineAction =
  | "ASK_DISCOVERY"
  | "EDUCATE_COMPARE"
  | "EDUCATE_DETAIL"
  | "PRESENT_OPTIONS"
  | "ANSWER_PRICE"
  | "HANDLE_OBJECTION"
  | "BUILD_TRUST"
  | "ASK_FOR_CONSULTATION"
  | "START_BOOKING"
  | "WINDOW_EXPIRED_HANDOFF"
  | "HANDOFF_HUMAN"
  | "END_SESSION"
  | "PAIN_TRIAGE"
  | "NO_DRAFT";

// ── session 狀態（純 — caller 由 ConsultSession row 經 toSessionState 映射） ──

/** workflow-specific slots（session.slots Json 平鋪）+ engine meta。 */
export type ConsultSlots = (OrthoSlots | ImplantSlots) & {
  meta?: { priceAskCount?: number };
};

export interface ConsultSessionState {
  workflow: ConsultWorkflow;
  stage: string;
  terminal: string | null;
  turnCount: number;
  purchaseIntent: number;
  slots: ConsultSlots;
  candidateCategory: string | null;
  comparedProducts: string[];
  askedSlots: string[];
  objections: ObjectionState[];
  ctaGiven: boolean;
  humanTookOver: boolean;
  /** #18 comparisonDone 判定：上一輪 action。 */
  lastAction: string | null;
}

// ── 訊號（純函數輸入） ─────────────────────────────────────────────────

export type ObjectionType = ObjectionState["type"];

export interface ConsultSignals {
  /** #0 紅旗 FLOOR（matchRedFlagTerms FLOOR ∪ params — red-flags.ts）。 */
  redFlagHit: boolean;
  /** #1 痛症訊號（痛/腫/流血/出血/發燒/崩/甩 — broad，recall 優先）。 */
  painSignal: boolean;
  /** #2 COMPLAINT（classify intent）。 */
  complaint: boolean;
  /** #3 明確要求真人。 */
  humanRequested: boolean;
  /** #4 窗口已過（C1 getWindowState）。 */
  windowExpired: boolean;
  /** #5 病人叫停。 */
  patientStopped: boolean;
  /** #9 高意向 lexical（booking 行為詞）。 */
  highIntent: boolean;
  /** #10 新 objection（null = 冇）。 */
  newObjection: ObjectionType | null;
  /** #11 問「邊款最適合我」。 */
  asksWhichSuitsMe: boolean;
  /** #12 問療程時間。 */
  asksDuration: boolean;
  /** #13 問脫牙／骨釘／IPR／骨量（箍牙）／骨量／補骨／影像／即日植牙／年期（植牙）。 */
  asksClinicalDetail: boolean;
  /** #14 問價。 */
  asksPrice: boolean;
  /** #14 指名產品（isProductUsable 過濾後產品詞匹配 — caller 計算）。 */
  namedProduct: string | null;
  /** #15 要求比較。 */
  askedComparison: boolean;
  /** #21 病人接受（諮詢邀請）。 */
  acceptsConsultation: boolean;
  /** #22 病人推搪。 */
  declinesConsultation: boolean;
  /** §4.5 本輪 purchaseIntent Δ（caller 經 computePurchaseIntentDelta 計好 — 含問價計數）。 */
  intentDelta: number;
  /** #23 cron 路徑輸入旗（per-turn caller 永遠 false；cron sweep 傳 true）。 */
  idleExpired: boolean;
}

// ── 詞表（code 常數 — 決定性、零 LLM；PII：詞表只係詞，輸入只喺 memory 內比對） ──

/** #1 痛症訊號（broad — recall 優先；FLOOR 紅旗詞先由 #0 食走）。 */
export const PAIN_SIGNAL_TERMS = ["痛", "腫", "流血", "出血", "發燒", "崩", "甩", "pain", "hurt", "ache", "swollen", "bleed", "fever"];
/** #3 明確要求真人（同 mock RE_NEEDS_HUMAN 同詞 — 行為一致）。 */
export const HUMAN_REQUEST_TERMS = ["人工", "真人", "human agent", "talk to a human"];
/** #5 病人叫停（停止 AI 對話）。 */
export const PATIENT_STOP_TERMS = ["唔使再講", "唔使再問", "唔使再send", "唔使再跟", "停手", "你地自己處理", "你地自己睇", "stop"];
/** #9 高意向 lexical = booking 行為詞（§4.5「幾時有位/點約/幫我約/星期X得唔得」+ booking 同義）。
 * 注意：冇「幾時做」（會撞 #12 療程時間問「幾時做完」）；「星期X得唔得」經「得唔得」命中。 */
export const HIGH_INTENT_BOOKING_TERMS = [
  "幾時有位", "有冇位", "點約", "幫我約", "幫我book", "book下", "book先",
  "想約", "預約", "約下", "幾時睇得到", "得唔得",
];
/** §4.5「我想做/決定咗」— 只入 intent Δ，唔觸發 #9（GC-09/GC-13 口徑）。 */
export const INTENT_DECIDED_TERMS = ["我想做", "決定咗", "就係咁喇", "搞先"];
/** #10 objection 詞表（逐 type；PRICE/UNCERTAINTY 同 §4.5 Δ 詞共用 — 同一訊號兩用）。 */
export const OBJECTION_TERMS: Record<ObjectionType, string[]> = {
  PRICE: ["太貴", "好貴", "貴到", "好大條", "pricey", "expensive"],
  TIME: ["好耐", "太耐", "太長期"],
  PAIN: ["會唔會痛", "痛唔痛", "好疼"],
  APPEARANCE: ["唔夠靚", "唔自然", "太明顯", "好明顯"],
  TRUST: ["靠唔住", "唔信", "冇聽過", "hear of"],
  FEAR: ["驚", "怕", "唔敢"],
  COMPARISON: ["邊個好", "邊樣好", "有冇其他牌子", "有冇平啲"],
  UNCERTAINTY: ["諗吓先", "諗下先", "再睇睇", "再諗吓", "考慮下", "考慮一番", "唔確定"],
};
/** #11 問「邊款最適合我」。 */
export const WHICH_SUITS_ME_TERMS = ["邊款最適合", "邊樣最適合", "咩最適合", "哪款適合", "邊個最適合", "邊款適合"];
/** #12 問療程時間（MD §4.2 #12 + GC-04「半年做唔做得完？」）。 */
export const DURATION_TERMS = ["幾耐", "幾時做完", "幾時完成", "要幾耐", "療程幾耐", "做唔做得完", "幾年先", "幾久"];
/** #13 臨床三問 — 箍牙（MD §4.2 #13：脫牙／骨釘／IPR／骨量）。 */
export const CLINICAL_ORTH_TERMS = ["脫牙", "拔牙", "抽牙", "骨釘", "IPR", "ipr", "調磨", "磨牙", "骨量", "骨頭夠"];
/** #13 臨床三問 — 植牙（MD §4.4：骨量／補骨／影像／即日植牙／年期）。 */
export const CLINICAL_IMPLANT_TERMS = ["骨量", "骨釘", "補骨", "植骨", "影像", "即日植牙", "年期", "x光", "x-ray", "ct", "電腦斷層"];
/** #15 要求比較。 */
export const COMPARISON_TERMS = ["比較", "差咩", "咩分別", "分別係咩", "邊個好", "邊樣好"];
/** #21 病人接受（諮詢邀請後嘅接受；booking 行為詞由 #9 先食走）。
 * 只收多字詞 — 單字「好/得」會誤中「好貴/唔好」（「唔好」係否定）；「可以」會誤中「可以平啲？」。 */
export const ACCEPT_TERMS = ["好啊", "好呀", "得呀", "冇問題", "ok", "okay", "就咁", "安排"];
/** #22 病人推搪（同 OBJECTION_TERMS.UNCERTAINTY / PATIENT_STOP_TERMS 互斥 — 見 unit test）。 */
export const DECLINE_TERMS = ["算啦", "改日", "遲啲先", "先唔好", "再諗下", "唔急", "再講啦"];
/** #14 問價（同報價鏈 isPriceIntent 詞表對齊 — price-guard.ts）。 */
export const PRICE_TERMS = ["幾錢", "幾多錢", "咩收費", "收費", "價錢", "價位", "幾價", "price", "平唔平", "貴唔貴"];

// ── 訊號偵測（純） ─────────────────────────────────────────────────────

function hitAny(text: string, terms: string[]): boolean {
  const t = (text ?? "").toLowerCase();
  return terms.some((x) => x.length > 0 && t.includes(x.toLowerCase()));
}

/** 偵測單一 objection type（第一命中優先，順序 = OBJECTION_TERMS key 序 — deterministic）。 */
export function detectObjection(canonicalText: string, rawText: string): ObjectionType | null {
  const blob = `${canonicalText ?? ""} ${rawText ?? ""}`;
  for (const [type, terms] of Object.entries(OBJECTION_TERMS) as [ObjectionType, string[]][]) {
    if (hitAny(blob, terms)) return type;
  }
  return null;
}

/**
 * §4.5 purchaseIntent Δ（純 — 本輪所有命中訊號求和；clamp 0–1 由 caller 做）。
 * - 「幾時有位/點約/幫我約/星期X得唔得」(booking act) +0.4
 * - 「我想做/決定咗」 +0.4
 * - 第二次或以上問價 +0.15 / 首次問價 +0.10（priceAskCount = 本輪前計數）
 * - 「太貴」 −0.1
 * - 「我諗下先/再睇睇」 −0.2
 * - 48h 無回覆（cron） −0.15（#23 — 由 applyIdleExpiry / row 23 用，唔喺呢度）
 */
export function computePurchaseIntentDelta(
  canonicalText: string,
  rawText: string,
  opts: { priceAskCount: number; asksPrice: boolean }
): number {
  const blob = `${canonicalText ?? ""} ${rawText ?? ""}`;
  let d = 0;
  if (hitAny(blob, HIGH_INTENT_BOOKING_TERMS)) d += 0.4;
  if (hitAny(blob, INTENT_DECIDED_TERMS)) d += 0.4;
  if (opts.asksPrice) d += opts.priceAskCount >= 1 ? 0.15 : 0.1;
  if (hitAny(blob, OBJECTION_TERMS.PRICE)) d -= 0.1;
  if (hitAny(blob, OBJECTION_TERMS.UNCERTAINTY)) d -= 0.2;
  return Math.round(d * 1000) / 1000; // 浮點 noise 清理（0.30000000000000004 → 0.3）
}

/** clamp 0–1（§4.5）。 */
export function clampIntent(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 3 位小數 round（§9.2 persist 口徑 — 浮點 noise 清理）。 */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 文字類訊號偵測（純）。外部類訊號（redFlagHit / complaint / windowExpired / namedProduct）
 * 由 caller 計算後經 `external` 傳入。
 */
export function detectConsultSignals(opts: {
  canonicalText: string;
  rawText: string;
  workflow: ConsultWorkflow;
  external: Pick<ConsultSignals, "redFlagHit" | "complaint" | "windowExpired" | "namedProduct">;
}): Omit<ConsultSignals, "intentDelta" | "idleExpired"> {
  const { canonicalText, rawText, workflow, external } = opts;
  const blob = `${canonicalText} ${rawText}`;
  return {
    redFlagHit: external.redFlagHit,
    painSignal: hitAny(blob, PAIN_SIGNAL_TERMS),
    complaint: external.complaint,
    humanRequested: hitAny(blob, HUMAN_REQUEST_TERMS),
    windowExpired: external.windowExpired,
    patientStopped: hitAny(blob, PATIENT_STOP_TERMS),
    highIntent: hitAny(blob, HIGH_INTENT_BOOKING_TERMS),
    newObjection: detectObjection(canonicalText, rawText),
    asksWhichSuitsMe: hitAny(blob, WHICH_SUITS_ME_TERMS),
    asksDuration: hitAny(blob, DURATION_TERMS),
    asksClinicalDetail: hitAny(blob, workflow === "IMPLANT_CONSULT" ? CLINICAL_IMPLANT_TERMS : CLINICAL_ORTH_TERMS),
    asksPrice: hitAny(blob, PRICE_TERMS),
    namedProduct: external.namedProduct,
    askedComparison: hitAny(blob, COMPARISON_TERMS),
    acceptsConsultation: hitAny(blob, ACCEPT_TERMS),
    declinesConsultation: hitAny(blob, DECLINE_TERMS),
  };
}

// ── Discovery（MD §4.6 — 唔問預算） ────────────────────────────────────

/** MD §4.6 逐字 — ORTHo_SLOT_VALUE（budgetSensitivity 唔喺 discovery 清單）。 */
export const ORTHO_SLOT_VALUE: Record<string, number> = {
  appearancePriority: 0.9,
  speedPriority: 0.85,
  timeline: 0.55,
  previousOrtho: 0.4,
};
/** 植牙 discovery 清單（MD §4.6 只定義 ORTHo；植牙只問最低要求槽起 — missingCount 為 minimum）。 */
export const IMPLANT_SLOT_VALUE: Record<string, number> = {
  missingCount: 0.9,
  missingDuration: 0.6,
  hasSeenDentist: 0.4,
};

/** minimum slots 齊口徑（consult-types.ts 註逐字）：箍牙 = appearance 或 speed 至少一個；植牙 = missingCount。 */
export function minimumSlotsMet(workflow: ConsultWorkflow, slots: ConsultSlots): boolean {
  if (workflow === "IMPLANT_CONSULT") {
    return (slots as ImplantSlots).missingCount != null;
  }
  const s = slots as OrthoSlots;
  return s.appearancePriority != null || s.speedPriority != null;
}

/**
 * chooseNextQuestion（MD §4.6）：每輪最多一條；問完入 askedSlots 唔再問（唔重問）；
 * 已填值嘅 slot 唔問；按 value 高→低 deterministic。
 */
export function chooseNextQuestion(
  workflow: ConsultWorkflow,
  slots: ConsultSlots,
  askedSlots: string[],
  /** ★ C5（MD §8.1 Tab 2 discovery）：關咗嘅問題對應 slot（無 = 全部可問，C3/C4 原行為）。 */
  skipSlots?: string[]
): string | null {
  const table = workflow === "IMPLANT_CONSULT" ? IMPLANT_SLOT_VALUE : ORTHO_SLOT_VALUE;
  const skip = skipSlots ?? [];
  const cands = Object.entries(table)
    .filter(([k]) => !askedSlots.includes(k))
    .filter(([k]) => !skip.includes(k))
    .filter(([k]) => (slots[k as keyof ConsultSlots] ?? null) == null)
    .sort((a, b) => b[1] - a[1]);
  return cands.length > 0 ? cands[0][0] : null;
}

// ── ORTHO_RULES / IMPLANT_RULES（MD §4.3/§4.4 逐字/逐義） ──────────────

export interface RuleCtx {
  askedComparison: boolean;
  asksWhichSuitsMe: boolean;
  asksDuration: boolean;
  asksClinicalDetail: boolean;
  askedPrice: boolean;
  asksPriceDifference: boolean;
}

export type RuleSlots = OrthoSlots & ImplantSlots & { purchaseIntent: number };

export interface ConsultRule {
  id: string;
  when: (s: RuleSlots, c: RuleCtx) => boolean;
  derive?: { candidateCategory?: string; allowProductComparison?: boolean; allowClinicalSelection?: boolean };
  action: EngineAction;
  guards?: { clinicalRecommendation?: "BLOCKED" };
}

/** MD §4.3 逐字。`allowClinicalSelection` 永遠 false — 冇任何規則會產生「呢款最適合你」。 */
export const ORTHO_RULES: ConsultRule[] = [
  { id: "ORTHO-001", when: (s) => s.appearancePriority === "HIGH", derive: { candidateCategory: "CLEAR_ALIGNER" }, action: "PRESENT_OPTIONS" },
  {
    id: "ORTHO-002",
    when: (s) => s.appearancePriority === "HIGH" && s.speedPriority === "HIGH",
    derive: { candidateCategory: "CLEAR_ALIGNER", allowProductComparison: true, allowClinicalSelection: false },
    action: "PRESENT_OPTIONS",
  },
  { id: "ORTHO-003", when: (_s, c) => c.askedComparison, action: "EDUCATE_COMPARE" },
  { id: "ORTHO-004", when: (s) => s.budgetSensitivity === "HIGH", action: "ANSWER_PRICE" },
  {
    id: "ORTHO-005",
    when: (s, c) => s.clinicalSuitability === "UNKNOWN" && c.asksWhichSuitsMe,
    action: "ASK_FOR_CONSULTATION",
    guards: { clinicalRecommendation: "BLOCKED" },
  },
  { id: "ORTHO-006", when: (s) => s.customerProductInterest !== null, action: "EDUCATE_DETAIL" },
  { id: "ORTHO-007", when: (_s, c) => c.asksDuration, action: "EDUCATE_DETAIL" },
  { id: "ORTHO-008", when: (_s, c) => c.asksClinicalDetail, action: "ASK_FOR_CONSULTATION" },
  { id: "ORTHO-009", when: (_s, c) => c.askedPrice, action: "ANSWER_PRICE" },
  { id: "ORTHO-010", when: (s) => s.purchaseIntent >= 0.6, action: "START_BOOKING" },
];

/** MD §4.4 逐義 — 植牙唔做任何產品建議（冇 candidateCategory derive）。 */
export const IMPLANT_RULES: ConsultRule[] = [
  // IMPLANT-001 問價 → ANSWER_PRICE + 講明最終費用視乎評估
  { id: "IMPLANT-001", when: (_s, c) => c.askedPrice, action: "ANSWER_PRICE" },
  // IMPLANT-002 品牌比較 → EDUCATE_COMPARE（只比 approved model/material/surface/package/warranty/price）
  { id: "IMPLANT-002", when: (_s, c) => c.askedComparison, action: "EDUCATE_COMPARE" },
  // IMPLANT-003 問差價 → 用 KB approved 解釋，冇就用通用句，禁止自創品牌溢價理由
  { id: "IMPLANT-003", when: (_s, c) => c.asksPriceDifference, action: "EDUCATE_DETAIL" },
  // 骨量／補骨／影像／即日植牙／年期 → ASK_FOR_CONSULTATION（臨床 — 同 #13 同口徑）
  { id: "IMPLANT-004", when: (_s, c) => c.asksClinicalDetail, action: "ASK_FOR_CONSULTATION" },
];

/** 第一命中 rule（deterministic 順序）— 冇命中 = null。`s` = slots ∪ { purchaseIntent }。
 * ★ C5：`disabled`（Tab 2 關咗嘅 rule id）→ 該 rule 視為唔命中（無 row = C3/C4 原行為）。 */
export function matchRule(
  workflow: ConsultWorkflow,
  slots: ConsultSlots,
  ctx: RuleCtx,
  purchaseIntent: number,
  disabled?: ReadonlySet<string>
): ConsultRule | null {
  const rules = workflow === "IMPLANT_CONSULT" ? IMPLANT_RULES : ORTHO_RULES;
  const s: RuleSlots = { ...(slots as OrthoSlots & ImplantSlots), purchaseIntent };
  for (const r of rules) {
    if (disabled && disabled.has(r.id)) continue;
    try {
      if (r.when(s, ctx)) return r;
    } catch {
      // 壞 slots shape（DB 手改）→ 該 rule 視為唔命中（fail-soft，唔阻 engine）
    }
  }
  return null;
}

/** #17/#18 derive：入 PRESENT_OPTIONS 時嘅 candidateCategory（ortho 由 ORTHO-001/002；implant 永遠 null — 唔做產品建議）。 */
export function deriveCandidateCategory(
  workflow: ConsultWorkflow,
  slots: ConsultSlots,
  ctx: RuleCtx,
  purchaseIntent: number,
  disabled?: ReadonlySet<string>
): { candidateCategory: string | null; ruleId: string | null } {
  const rule = matchRule(workflow, slots, ctx, purchaseIntent, disabled);
  if (workflow !== "ORTHODONTIC_CONSULT") return { candidateCategory: null, ruleId: rule?.id ?? null };
  if (rule?.derive?.candidateCategory) return { candidateCategory: rule.derive.candidateCategory, ruleId: rule.id };
  return { candidateCategory: null, ruleId: rule?.id ?? null };
}

// ── Transition table（MD §4.2 — 25 行 first match wins） ──────────────

export interface TransitionOpts {
  maxTurns?: number; // default 8
  ctaAfterTurns?: number; // default 6
  /** ★ C5（MD §8.1 Tab 2）：關咗嘅 rule id — 對應 transition row 唔命中（無 = C3/C4 原行為）。 */
  disabledRules?: ReadonlySet<string>;
  /** ★ C5（MD §8.1 Tab 2 discovery）：關咗嘅發現問題對應 slot（chooseNextQuestion skip）。 */
  discovery?: { skipSlots?: string[] };
}

export interface TransitionResult {
  /** 命中 row（0–24）；-1 = 冇命中（stay）。 */
  row: number;
  /** 下一 stage（row -1 / 「不變」= 現 stage）。 */
  stage: string;
  /** 要寫嘅 terminal（null = 唔變）。 */
  terminal: string | null;
  /** 本輪 action（null = 冇 action）。 */
  action: EngineAction | null;
  /** 涉及 rule id（trace §8.3 用）；無 = null。 */
  ruleId: string | null;
  /** §4.5 purchaseIntent Δ（caller clamp 後加）。 */
  delta: number;
  /** 評估用 intent（現值 + 本輪 Δ，clamp 0–1）— #20 判定口徑。 */
  intentAfter: number;
  /** #17/#18 derive candidateCategory。 */
  candidateCategory: string | null;
  /** #16 ASK_DISCOVERY 下條問緊嘅 slot（null = 冇）。 */
  askedSlot: string | null;
  /** #10 更新後嘅 objection state（null = 冇 objection 變動）。 */
  objection: ObjectionState | null;
  /** ctaGiven 更新後（#24）。 */
  ctaGiven: boolean;
  /** false = #4/#6/#23 — turnCount 唔加（#4/#6：C1 gate 已處理對話層；#23：cron 路徑）。 */
  processed: boolean;
  /** #22/#23 → 排 follow-up（audit placeholder — FollowupTask model 未實施）。 */
  followUp: boolean;
  /** action === START_BOOKING（caller 轉既有 booking flow）。 */
  booking: boolean;
  note?: string;
}

function ruleCtxFromSignals(sig: ConsultSignals): RuleCtx {
  return {
    askedComparison: sig.askedComparison,
    asksWhichSuitsMe: sig.asksWhichSuitsMe,
    asksDuration: sig.asksDuration,
    asksClinicalDetail: sig.asksClinicalDetail,
    askedPrice: sig.asksPrice,
    asksPriceDifference: sig.asksPrice && sig.namedProduct === null,
  };
}

/**
 * 主 transition 函數 — MD §4.2 25 行由上而下 first match wins。
 * 純函數：session state + signals → 結果（零副作用）。
 */
export function consultTransition(
  session: ConsultSessionState,
  sig: ConsultSignals,
  opts: TransitionOpts = {}
): TransitionResult {
  const maxTurns = opts.maxTurns ?? CONSULT_MAX_TURNS;
  const ctaAfterTurns = opts.ctaAfterTurns ?? CONSULT_CTA_AFTER_TURNS;
  const stage = session.stage;
  const intentAfter = round3(clampIntent(session.purchaseIntent + (sig.intentDelta ?? 0)));

  const base = {
    stage,
    terminal: null as string | null,
    action: null as EngineAction | null,
    ruleId: null as string | null,
    delta: sig.intentDelta ?? 0,
    intentAfter,
    candidateCategory: null as string | null,
    askedSlot: null as string | null,
    objection: null as ObjectionState | null,
    ctaGiven: session.ctaGiven,
    processed: true,
    followUp: false,
    booking: false,
    note: undefined as string | undefined,
  };
  const emit = (row: number, patch: Partial<typeof base> = {}): TransitionResult => ({
    row,
    ...base,
    ...patch,
  });
  // ★ C5（MD §8.1 Tab 2）：rule 關咗 → 對應 row 視為唔命中（first-match 繼續往下）。
  const off = opts.disabledRules;
  const offRule = (id: string | null): boolean => id !== null && off?.has(id) === true;

  // 本輪 objection 狀態（#8 判定用**本輪更新後**嘅 count — GC-18 口徑）
  let thisTurnObjection: ObjectionState | null = null;
  if (sig.newObjection !== null) {
    const prev = session.objections.find((o) => o.type === sig.newObjection);
    const now = new Date().toISOString();
    thisTurnObjection = prev
      ? { type: prev.type, status: "RECURRED", count: prev.count + 1, firstAt: prev.firstAt, lastAt: now }
      : { type: sig.newObjection, status: "OPEN", count: 1, firstAt: now, lastAt: now };
  }
  const effectivePriceCount =
    thisTurnObjection?.type === "PRICE"
      ? thisTurnObjection.count
      : session.objections.find((o) => o.type === "PRICE")?.count ?? 0;

  // ── #0 紅旗 FLOOR ──
  if (sig.redFlagHit) {
    return emit(0, { stage: "HANDOFF", terminal: "HANDOFF", action: "HANDOFF_HUMAN", note: "red flag FLOOR" });
  }
  // ── #1 痛症訊號 → 轉 PAIN_TRIAGE ──
  if (sig.painSignal) {
    return emit(1, { stage: "HANDOFF", terminal: "HANDOFF", action: "PAIN_TRIAGE", note: "pain signal → PAIN_TRIAGE" });
  }
  // ── #2 COMPLAINT ──
  if (sig.complaint) {
    return emit(2, { stage: "HANDOFF", terminal: "HANDOFF", action: "HANDOFF_HUMAN", note: "COMPLAINT" });
  }
  // ── #3 明確要求真人 ──
  if (sig.humanRequested) {
    return emit(3, { stage: "HANDOFF", terminal: "HANDOFF", action: "HANDOFF_HUMAN", note: "human requested" });
  }
  // ── #4 窗口已過（stage 不變；C1 gate 已記 conv.consultGateAction — processed:false，Δ 唔計） ──
  if (sig.windowExpired) {
    return emit(4, {
      action: "WINDOW_EXPIRED_HANDOFF", processed: false,
      delta: 0, intentAfter: session.purchaseIntent, note: "window expired",
    });
  }
  // ── #5 病人叫停 ──
  if (sig.patientStopped) {
    return emit(5, { stage: "COMPLETED", terminal: "COMPLETED", action: "END_SESSION", note: "patient stopped" });
  }
  // ── #6 humanTookOver（唔出草稿 — processed:false，Δ 唔計） ──
  if (session.humanTookOver) {
    return emit(6, {
      action: "NO_DRAFT", processed: false,
      delta: 0, intentAfter: session.purchaseIntent, note: "human took over",
    });
  }
  // ── #7 turnCount >= maxTurns(8) ──
  if (session.turnCount >= maxTurns) {
    return emit(7, { stage: "HANDOFF", terminal: "HANDOFF", action: "HANDOFF_HUMAN", note: `maxTurns ${maxTurns}` });
  }
  // ── #8 objections.PRICE.count >= 2（stage 不變，terminal HANDOFF — GC-18） ──
  if (effectivePriceCount >= 2) {
    return emit(8, { terminal: "HANDOFF", action: "HANDOFF_HUMAN", objection: thisTurnObjection, note: "PRICE objection x2" });
  }
  // ── #9 高意向 lexical → BOOKING ──
  if (sig.highIntent) {
    return emit(9, { stage: "BOOKING", terminal: "COMPLETED", action: "START_BOOKING", booking: true, note: "high intent lexical" });
  }
  // ── #10 新 objection（stage 不變） ──
  if (thisTurnObjection !== null) {
    return emit(10, { action: "HANDLE_OBJECTION", objection: thisTurnObjection, note: `objection ${thisTurnObjection.type} x${thisTurnObjection.count}` });
  }
  // ── #11 問「邊款最適合我」（臨床推薦 BLOCKED） ──
  if (sig.asksWhichSuitsMe) {
    return emit(11, { stage: "CONSULTATION", action: "ASK_FOR_CONSULTATION", ruleId: "ORTHO-005", note: "which suits me — clinicalRecommendation BLOCKED" });
  }
  // ── #12 問療程時間（只用 timeWording）— 植牙冇對應 rule id（MD §4.4 未定義 duration rule） ──
  if (sig.asksDuration) {
    return emit(12, {
      action: "EDUCATE_DETAIL",
      ruleId: session.workflow === "IMPLANT_CONSULT" ? null : "ORTHO-007",
      note: "duration — timeWording only",
    });
  }
  // ── #13 問脫牙／骨釘／IPR／骨量 ──
  if (sig.asksClinicalDetail) {
    return emit(13, {
      stage: "CONSULTATION",
      action: "ASK_FOR_CONSULTATION",
      ruleId: session.workflow === "IMPLANT_CONSULT" ? "IMPLANT-004" : "ORTHO-008",
      note: "clinical detail",
    });
  }
  // ── #14 DISCOVER 指名產品 + 問價（C5：ORTHO-009 關咗 → 唔命中） ──
  if (stage === "DISCOVER" && sig.asksPrice && sig.namedProduct && !offRule("ORTHO-009")) {
    return emit(14, { action: "ANSWER_PRICE", ruleId: "ORTHO-009", note: "named product + price" });
  }
  // ── #15 DISCOVER 要求比較（C5：ORTHO-003 關咗 → 唔命中） ──
  if (stage === "DISCOVER" && sig.askedComparison && !offRule("ORTHO-003")) {
    return emit(15, { stage: "EDUCATE", action: "EDUCATE_COMPARE", ruleId: "ORTHO-003", note: "comparison" });
  }
  // ── #16 DISCOVER minimum slots 未齊（C5：discovery skipSlots） ──
  if (stage === "DISCOVER" && !minimumSlotsMet(session.workflow, session.slots)) {
    // 每輪最多一條 + askedSlots 唔重問 — 冇得問（全部問過、答案未落 = C4 抽取待中）→ 唔重問（stay）
    const nextSlot = chooseNextQuestion(session.workflow, session.slots, session.askedSlots, opts.discovery?.skipSlots);
    if (nextSlot !== null) {
      return emit(16, { action: "ASK_DISCOVERY", askedSlot: nextSlot, note: "minimum slots incomplete" });
    }
  }
  // ── #17 DISCOVER minimum slots 齊（C5：rule 關咗 → 只去 candidateCategory derive，row 照行） ──
  if (stage === "DISCOVER" && minimumSlotsMet(session.workflow, session.slots)) {
    const d = deriveCandidateCategory(session.workflow, session.slots, ruleCtxFromSignals(sig), intentAfter, off);
    return emit(17, { stage: "PRESENT_OPTIONS", action: "PRESENT_OPTIONS", candidateCategory: d.candidateCategory, ruleId: d.ruleId, note: "minimum slots met" });
  }
  // ── #18 EDUCATE 比較完成（C5：同上） ──
  if (stage === "EDUCATE" && (session.lastAction === "EDUCATE_COMPARE" || session.comparedProducts.length > 0)) {
    const d = deriveCandidateCategory(session.workflow, session.slots, ruleCtxFromSignals(sig), intentAfter, off);
    return emit(18, { stage: "PRESENT_OPTIONS", action: "PRESENT_OPTIONS", candidateCategory: d.candidateCategory, ruleId: d.ruleId, note: "comparison done" });
  }
  // ── #19 PRESENT_OPTIONS clinicalSuitability = UNKNOWN ──
  if (stage === "PRESENT_OPTIONS" && (session.slots as OrthoSlots).clinicalSuitability === "UNKNOWN") {
    return emit(19, { stage: "CONSULTATION", action: "ASK_FOR_CONSULTATION", ruleId: "ORTHO-005", note: "clinical UNKNOWN — ask consultation" });
  }
  // ── #20 PRESENT_OPTIONS purchaseIntent >= 0.6（C5：ORTHO-010 關咗 → 唔命中） ──
  if (stage === "PRESENT_OPTIONS" && intentAfter >= CONSULT_HIGH_INTENT_THRESHOLD && !offRule("ORTHO-010")) {
    return emit(20, { stage: "BOOKING", terminal: "COMPLETED", action: "START_BOOKING", booking: true, ruleId: "ORTHO-010", note: "intent >= 0.6" });
  }
  // ── #21 CONSULTATION 病人接受 ──
  if (stage === "CONSULTATION" && sig.acceptsConsultation) {
    return emit(21, { stage: "BOOKING", terminal: "COMPLETED", action: "START_BOOKING", booking: true, note: "accepted consultation" });
  }
  // ── #22 CONSULTATION 病人推搪（END_SESSION + 排 follow-up） ──
  if (stage === "CONSULTATION" && sig.declinesConsultation) {
    return emit(22, { stage: "COMPLETED", terminal: "COMPLETED", action: "END_SESSION", followUp: true, note: "declined consultation" });
  }
  // ── #23 48 小時無 inbound（cron 路徑 — idleExpired 旗） ──
  if (sig.idleExpired) {
    return emit(23, {
      stage: "EXPIRED",
      terminal: "EXPIRED",
      delta: CONSULT_EXPIRE_INTENT_DELTA,
      intentAfter: round3(clampIntent(session.purchaseIntent + CONSULT_EXPIRE_INTENT_DELTA)),
      followUp: true,
      processed: false,
      note: "idle 48h — follow-up placeholder",
    });
  }
  // ── #24 CTA：turnCount >= ctaAfterTurns(6) ∧ !ctaGiven ──
  if (session.turnCount >= ctaAfterTurns && !session.ctaGiven) {
    return emit(24, { action: "ASK_FOR_CONSULTATION", ctaGiven: true, note: "forced CTA" });
  }
  // ── 兜底：冇命中（stay） ──
  return emit(-1, { note: "no transition — stay" });
}

// ── #23 idle expiry（純 — cron sweep 用） ─────────────────────────────

/**
 * #23：48 小時無 inbound（cron）。純判定 — persist 由 runConsultExpireSweep 做。
 * follow-up = audit/log placeholder（FollowupTask model 本 repo 未實施 — 只記錄，唔開 model）。
 */
export function applyIdleExpiry(
  session: ConsultSessionState,
  updatedAt: Date,
  opts: { idleHours?: number; now?: Date } = {}
): { row: number; expired: boolean; delta: number; intentAfter: number; followUp: boolean } {
  const idleHours = opts.idleHours ?? CONSULT_IDLE_EXPIRE_HOURS;
  const now = opts.now ?? new Date();
  const idleMs = now.getTime() - updatedAt.getTime();
  const expired = session.terminal === null && idleMs >= idleHours * 3_600_000;
  if (!expired) {
    return { row: -1, expired: false, delta: 0, intentAfter: session.purchaseIntent, followUp: false };
  }
  return {
    row: 23,
    expired: true,
    delta: CONSULT_EXPIRE_INTENT_DELTA,
    intentAfter: round3(clampIntent(session.purchaseIntent + CONSULT_EXPIRE_INTENT_DELTA)),
    followUp: true,
  };
}

/** caller 用：ConsultSession row → ConsultSessionState（fail-soft 壞 shape → default）。 */
export function toSessionState(row: {
  workflow: string;
  stage: string;
  terminal: string | null;
  turnCount: number;
  purchaseIntent: number;
  slots: unknown;
  candidateCategory: string | null;
  comparedProducts: string[];
  askedSlots: string[];
  objections: unknown;
  ctaGiven: boolean;
  humanTookOver: boolean;
  lastAction: string | null;
}): ConsultSessionState {
  return {
    workflow: row.workflow as ConsultWorkflow,
    stage: row.stage,
    terminal: row.terminal,
    turnCount: row.turnCount,
    purchaseIntent: row.purchaseIntent,
    // clinicalSuitability 預設 UNKNOWN（DB slots={}/舊 row 缺欄 normalize — #19 判定靠佢）
    slots: { clinicalSuitability: "UNKNOWN", ...((row.slots && typeof row.slots === "object" ? row.slots : {}) as object) } as ConsultSlots,
    candidateCategory: row.candidateCategory,
    comparedProducts: Array.isArray(row.comparedProducts) ? row.comparedProducts : [],
    askedSlots: Array.isArray(row.askedSlots) ? row.askedSlots : [],
    objections: Array.isArray(row.objections) ? (row.objections as ObjectionState[]) : [],
    ctaGiven: row.ctaGiven,
    humanTookOver: row.humanTookOver,
    lastAction: row.lastAction,
  };
}
