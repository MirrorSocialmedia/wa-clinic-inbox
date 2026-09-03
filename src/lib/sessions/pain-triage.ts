/**
 * ★ Part E（cwi-paintriage-20260903，MD §Part E E.3）：PAIN_TRIAGE 痛症問診 engine（pure 優先）。
 *
 * 跟 BookingSession（prisma :292）持久化模式 + src/lib/booking/session-engine.ts pure step 模式：
 *   入 (session, aiOut, ctx) 出 (patch, replyText, effects) — 零 IO。
 *
 * 行為（MD E.3）：
 *   每輪 LLM 抽槽 → 即行 evaluateRedFlags **中即終止**（close reason=RED_FLAG → URGENT 全套鐵律零改動）
 *   → 未中按 params questions[] 順序問下一條未填（一 turn 一條，最多兩條短嘅併埋）
 *   → 完成條件：紅旗類問完 + (severity ∨ functionalImpact) + toothLocation，或 maxTurns 到 → 出口 E.5。
 *
 * 問題臨床理據（MD 註，唔准自由改寫 — 默認問句按呢個理據寫定）：
 *   位置＝定位兼影響收費／痛幾耐＝急慢性／凍熱刺激痛完即收 vs 持續幾分鐘＝可逆 vs 不可逆牙髓，
 *   急迫性差好遠／自發痛·夜痛＝急迫性上升／咬合痛＝根尖周或牙周方向／腫＝紅旗探測／
 *   功能影響＝病人可答性高做嚴重度交叉驗證／1–10＝閾值 ≥8 紅旗／最近兩星期治療＝術後紅旗／影相＝只做 signal。
 *
 * session.slots Json shape（落庫）：{ slots: PainSlotsType, asked: string[] }（問句 id 已問追蹤）。
 * PII：只存症狀 business metadata；零病人自由文本落庫。
 */
import { z } from "zod";
import { evaluateRedFlags } from "./red-flags";
import { buildExitDraft, evaluateImpressions, type ImpressionKey } from "./impressions";
import type { PainTriageParamsType } from "@/lib/workflow/definitions";

// ── 槽位（MD E.3 完整版）────────────────────────────────────────────────
export const PAIN_QUESTION_SLOT_VALUES = [
  "toothLocation",
  "durationDays",
  "severity",
  "stimulusLinger",
  "spontaneousPain",
  "nightPain",
  "bitePain",
  "swelling",
  "functionalImpact",
  "redFlagSymptoms",
  "recentTreatment",
  "photo",
] as const;
export type PainQuestionSlot = (typeof PAIN_QUESTION_SLOT_VALUES)[number];

export const PainQuestion = z.object({
  id: z.string().min(1),
  slot: z.enum(PAIN_QUESTION_SLOT_VALUES),
  text: z.string().min(1),
  enabled: z.boolean().default(true),
  order: z.number().int(),
});
export type PainQuestionType = z.infer<typeof PainQuestion>;

export const PainSlots = z.object({
  toothLocation: z.string().nullable().default(null),
  durationDays: z.number().nullable().default(null),
  severity: z.number().min(1).max(10).nullable().default(null),
  stimulusLinger: z.enum(["instant", "lingering", "none"]).nullable().default(null), // ★ 最有價值一條
  spontaneousPain: z.boolean().nullable().default(null),
  nightPain: z.boolean().nullable().default(null),
  bitePain: z.boolean().nullable().default(null),
  swelling: z.boolean().nullable().default(null),
  functionalImpact: z.array(z.enum(["cant_eat", "pain_talking", "cant_sleep"])).default([]),
  redFlagSymptoms: z.array(z.string()).default([]),
  recentTreatment: z.boolean().nullable().default(null),
  photoOffered: z.boolean().default(false),
});
export type PainSlotsType = z.infer<typeof PainSlots>;

export interface PainSessionState {
  slots: PainSlotsType;
  asked: string[]; // 已問問題 id（functionalImpact/redFlagSymptoms 空陣 = 「冇」都算已問）
}

export function emptyPainState(): PainSessionState {
  return { slots: PainSlots.parse({}), asked: [] };
}

/**
 * DB slots Json → PainSessionState（fail-soft：壞 shape → 空 state，唔 throw —
 * 問診 session 唔可以因為舊行 shape 演進死咗成個 conversation）。
 */
export function parsePainState(raw: unknown): PainSessionState {
  const empty = emptyPainState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const o = raw as { slots?: unknown; asked?: unknown };
  const slots = PainSlots.safeParse(o.slots ?? {});
  const asked = Array.isArray(o.asked) ? o.asked.filter((x): x is string => typeof x === "string") : [];
  return { slots: slots.success ? slots.data : empty.slots, asked };
}

// ── code 常數（MD params 冇 maxTurns 欄 — 拍板：code 常數，唔 params 化）──
export const MAX_PAIN_TURNS = 10;
export const MAX_PAIN_NO_PROGRESS = 3;
export const PAIN_SESSION_TTL_MS = 24 * 3_600_000;
/** 紅旗類問題（完成條件要問完嗰幾條 — 腫＝紅旗探測 / 術後 / 紅旗症狀） */
const RED_FLAG_Q_SLOTS: ReadonlySet<PainQuestionSlot> = new Set(["swelling", "recentTreatment", "redFlagSymptoms"]);
/** 「已問」先算填（病人答「冇影響」→ [] 同「未問」分唔到） */
const ASKED_BASED_SLOTS: ReadonlySet<PainQuestionSlot> = new Set(["functionalImpact", "redFlagSymptoms", "photo"]);

// ── 默認問題清單（臨床理據句 — UI 可改文案，slot 綁定鎖死）─────────────
export const DEFAULT_PAIN_QUESTIONS: PainQuestionType[] = [
  { id: "q-location", slot: "toothLocation", text: "想先了解邊隻牙痛？（例如：右後牙 / 左前牙 / 智慧齒）", enabled: true, order: 0 },
  { id: "q-duration", slot: "durationDays", text: "痛咗幾耐呀？（例如：2 日 / 一星期）", enabled: true, order: 1 },
  { id: "q-stimulus", slot: "stimulusLinger", text: "食凍熱嘢嗰陣痛，停咗之後痛會即收，定係持續幾分鐘？", enabled: true, order: 2 },
  { id: "q-spontaneous", slot: "spontaneousPain", text: "唔食嘢嘅時候會唔會自己痛？", enabled: true, order: 3 },
  { id: "q-night", slot: "nightPain", text: "瞓覺嗰陣會唔會痛醒？", enabled: true, order: 4 },
  { id: "q-bite", slot: "bitePain", text: "咬嘢嗰陣會唔會痛？", enabled: true, order: 5 },
  { id: "q-recent", slot: "recentTreatment", text: "最近兩星期有冇做過牙醫治療（補牙 / 杜牙根 / 拔牙）？", enabled: true, order: 6 },
  { id: "q-swelling", slot: "swelling", text: "面、頸或者眼有冇腫？", enabled: true, order: 7 },
  { id: "q-redflag", slot: "redFlagSymptoms", text: "有冇以下情況：流血止唔到、發燒、吞唔到嘢 / 呼吸唔順、外傷？如果有請即刻講。", enabled: true, order: 8 },
  { id: "q-severity", slot: "severity", text: "而家痛幾痛？1–10 分（10 = 痛到忍唔到）", enabled: true, order: 9 },
  { id: "q-impact", slot: "functionalImpact", text: "有冇影響到你？（食唔食到嘢 / 講嘢痛 / 瞓唔瞓到）", enabled: true, order: 10 },
  { id: "q-photo", slot: "photo", text: "方便嘅話俾張痛嗰邊嘅相，醫生可以預先睇（唔強制）。", enabled: true, order: 11 },
];

// ── AI 輸出（LLM 只抽槽唔判級 — 鐵律）──────────────────────────────────
export const PAIN_ACTIONS = ["CONTINUE", "HUMAN", "CANCEL"] as const;
export type PainAction = (typeof PAIN_ACTIONS)[number];

export interface PainAiOutput {
  slotUpdates: Partial<PainSlotsType>; // 只含今條訊息新講嘅嘢
  action: PainAction;
  reply: string; // 語氣句（≤2 句）— engine 唔用（問句由 params 出）；保留做 trace
}

export type PainEffect =
  | { kind: "NONE" }
  | { kind: "URGENT_ESCALATE"; categories: string[]; terms: string[] } // 紅旗中 → runner 行 URGENT 全套（鐵律零改動）
  | { kind: "CREATE_DRAFT"; draftText: string; impression: string | null } // 出口 E.5（L1 草稿俾 staff）
  | { kind: "NOTIFY_STAFF"; title: string };

export interface PainStepResult {
  patch: {
    state: PainSessionState;
    status: "ACTIVE" | "COMPLETED" | "HANDOFF";
    turns: number;
    noProgress: number;
    closeReason: string | null;
    impression: string | null;
  };
  replyText: string | null; // 完整出街文字；null = 唔覆（AI 收聲 — 紅旗 / 出口）
  effects: PainEffect[];
}

export interface PainStepCtx {
  params: PainTriageParamsType;
  /** 病人原文（**已 lexicon canonical 化**）— session 內最近幾條 IN text */
  rawTexts: string[];
  autoPostOp: boolean; // E.7 術後自動判（開波 hook fail-soft 算好）
}

// ── pure helpers ────────────────────────────────────────────────────────

/** 合併抽槽（LLM 更新 → 已收集）：null/undefined = 未講；array = union；bool = 覆蓋。 */
export function mergePainSlots(prev: PainSlotsType, upd: Partial<PainSlotsType>): PainSlotsType {
  const out: PainSlotsType = { ...prev, functionalImpact: [...prev.functionalImpact], redFlagSymptoms: [...prev.redFlagSymptoms] };
  if (upd.toothLocation !== null && upd.toothLocation !== undefined) out.toothLocation = upd.toothLocation;
  if (upd.durationDays !== null && upd.durationDays !== undefined) out.durationDays = upd.durationDays;
  if (upd.severity !== null && upd.severity !== undefined) out.severity = upd.severity;
  if (upd.stimulusLinger !== null && upd.stimulusLinger !== undefined) out.stimulusLinger = upd.stimulusLinger;
  if (upd.spontaneousPain !== null && upd.spontaneousPain !== undefined) out.spontaneousPain = upd.spontaneousPain;
  if (upd.nightPain !== null && upd.nightPain !== undefined) out.nightPain = upd.nightPain;
  if (upd.bitePain !== null && upd.bitePain !== undefined) out.bitePain = upd.bitePain;
  if (upd.swelling !== null && upd.swelling !== undefined) out.swelling = upd.swelling;
  if (upd.recentTreatment !== null && upd.recentTreatment !== undefined) out.recentTreatment = upd.recentTreatment;
  if (Array.isArray(upd.functionalImpact)) {
    for (const v of upd.functionalImpact) if (!out.functionalImpact.includes(v)) out.functionalImpact.push(v);
  }
  if (Array.isArray(upd.redFlagSymptoms)) {
    for (const v of upd.redFlagSymptoms) if (!out.redFlagSymptoms.includes(v)) out.redFlagSymptoms.push(v);
  }
  if (upd.photoOffered === true) out.photoOffered = true;
  return out;
}

export function didPainProgress(prev: PainSlotsType, merged: PainSlotsType): boolean {
  return JSON.stringify(prev) !== JSON.stringify(merged);
}

function isSlotFilled(state: PainSessionState, q: PainQuestionType): boolean {
  if (ASKED_BASED_SLOTS.has(q.slot)) {
    if (state.asked.includes(q.id)) return true;
    if (q.slot === "photo") return state.slots.photoOffered === true;
    if (q.slot === "functionalImpact") return state.slots.functionalImpact.length > 0;
    if (q.slot === "redFlagSymptoms") return state.slots.redFlagSymptoms.length > 0;
    return false;
  }
  switch (q.slot) {
    case "toothLocation": return state.slots.toothLocation !== null;
    case "durationDays": return state.slots.durationDays !== null;
    case "severity": return state.slots.severity !== null;
    case "stimulusLinger": return state.slots.stimulusLinger !== null;
    case "spontaneousPain": return state.slots.spontaneousPain !== null;
    case "nightPain": return state.slots.nightPain !== null;
    case "bitePain": return state.slots.bitePain !== null;
    case "swelling": return state.slots.swelling !== null;
    case "recentTreatment": return state.slots.recentTreatment !== null;
    default: return false;
  }
}

function enabledSorted(p: PainTriageParamsType): PainQuestionType[] {
  return [...p.questions].filter((q) => q.enabled).sort((a, b) => a.order - b.order);
}

/** 出口（E.5）：impression + L1 草稿 + 中性橋接句（草稿俾 staff 發 — 唔自動覆）。 */
function painExit(
  state: PainSessionState,
  turns: number,
  noProgress: number,
  closeReason: string,
  ctx: PainStepCtx
): PainStepResult {
  const impression = evaluateImpressions(state.slots, ctx.rawTexts);
  const built = buildExitDraft({
    impression: impression as ImpressionKey | null,
    impressionTemplates: ctx.params.impressionTemplates,
    exitDraftTemplate: ctx.params.exitDraftTemplate,
  });
  return {
    patch: {
      state,
      status: "COMPLETED",
      turns,
      noProgress,
      closeReason,
      impression: impression as string | null,
    },
    // 中性橋接（零事實、零醫療建議）— 3 句式草稿由 staff 人手發（P-4：L1 唔自動）
    replyText: "收到，多謝你嘅耐性。我已經整理咗你嘅情況，職員會盡快同你確認 🙏",
    effects: [{ kind: "CREATE_DRAFT", draftText: built.draft, impression: impression as string | null }],
  };
}

// ── step（主入口 — pure）────────────────────────────────────────────────
export function painStep(
  session: { state: PainSessionState; status: string; turns: number; noProgress: number },
  ai: PainAiOutput,
  ctx: PainStepCtx
): PainStepResult {
  const p = ctx.params;
  const turns = session.turns + 1;
  const merged = mergePainSlots(session.state.slots, ai.slotUpdates);

  // 0. 紅旗（最高優先 — 中即終止；replyText=null = AI 收聲）
  const rf = evaluateRedFlags(merged, ctx.rawTexts, p, ctx.autoPostOp);
  if (rf.hit) {
    return {
      patch: { state: { ...session.state, slots: merged }, status: "COMPLETED", turns, noProgress: session.noProgress, closeReason: "RED_FLAG", impression: null },
      replyText: null,
      effects: [{ kind: "URGENT_ESCALATE", categories: rf.categories, terms: rf.terms }],
    };
  }

  // 1. 逃生口
  if (ai.action === "HUMAN") {
    return {
      patch: { state: { ...session.state, slots: merged }, status: "HANDOFF", turns, noProgress: session.noProgress, closeReason: "HANDOFF", impression: null },
      replyText: "收到，我哋職員會直接同你跟進 🙏",
      effects: [{ kind: "NOTIFY_STAFF", title: "病人要求真人（痛症問診中）" }],
    };
  }
  if (ai.action === "CANCEL") {
    return {
      patch: { state: { ...session.state, slots: merged }, status: "COMPLETED", turns, noProgress: session.noProgress, closeReason: "CANCELLED", impression: null },
      replyText: "冇問題，有需要隨時搵我哋 🙂",
      effects: [],
    };
  }

  // 2. 輪數超限 → 出口（用现有槽）
  if (turns >= MAX_PAIN_TURNS) return painExit({ ...session.state, slots: merged }, turns, session.noProgress, "MAX_TURNS", ctx);

  // 3. 冇進展（抽唔到新槽）→ 上限 = 人手接手
  const progress = didPainProgress(session.state.slots, merged);
  const noProgress = progress ? 0 : session.noProgress + 1;
  if (noProgress >= MAX_PAIN_NO_PROGRESS) {
    return {
      patch: { state: { ...session.state, slots: merged }, status: "HANDOFF", turns, noProgress, closeReason: "HANDOFF", impression: null },
      replyText: "等我搵職員直接同你安排 🙏",
      effects: [{ kind: "NOTIFY_STAFF", title: "痛症問診無進展 — 請人手接手" }],
    };
  }

  const state: PainSessionState = { slots: merged, asked: [...session.state.asked] };
  const enabled = enabledSorted(p);

  // 4. 完成條件：紅旗類問完 + (severity ∨ functionalImpact) + toothLocation
  const redFlagDone = enabled.filter((q) => RED_FLAG_Q_SLOTS.has(q.slot)).every((q) => isSlotFilled(state, q));
  const severityOrImpact = merged.severity !== null || merged.functionalImpact.length > 0;
  if (redFlagDone && severityOrImpact && merged.toothLocation !== null) {
    return painExit(state, turns, noProgress, "COMPLETED", ctx);
  }

  // 5. 問下一條未填（一 turn 一條；兩條短嘅 ≤24 字併埋）
  const unfilled = enabled.filter((q) => !isSlotFilled(state, q));
  if (unfilled.length === 0) {
    // 全部問完但完成條件未齊（例：severity 同 impact 都冇）→ 出口用现有槽
    return painExit(state, turns, noProgress, "COMPLETED", ctx);
  }
  const ask: PainQuestionType[] = [unfilled[0]];
  if (unfilled.length >= 2 && ask[0].text.length <= 24 && unfilled[1].text.length <= 24) ask.push(unfilled[1]);
  for (const q of ask) {
    if (!state.asked.includes(q.id)) state.asked.push(q.id);
    if (q.slot === "photo") state.slots = { ...state.slots, photoOffered: true };
  }
  return {
    patch: { state, status: "ACTIVE", turns, noProgress, closeReason: null, impression: null },
    replyText: ask.map((q) => q.text).join("\n"),
    effects: [],
  };
}
