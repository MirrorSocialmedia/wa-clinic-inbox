/**
 * Phase D — Workflow 參數化（cwi-ai-20260825-t4，總綱 §6.4 D-11）。
 *
 * 三個 workflow key 嘅內建模板：
 *   - `paramsSchema`：zod（admin PUT 入口驗證）
 *   - `DEFAULTS`：code defaults（= 現有 code 硬編碼原句搬入 — 唔發明）
 *   - `buildGraph(params)`：唯讀顯示用 nodes/edges JSON（結構硬編碼，params 值 inline 落 subtitle）
 *
 * 鐵律：params 全部係現有 code 真用緊嘅嘢；文案類 params 只經 fillVars() 做 deterministic
 * 佔位符替換 — **LLM 永不掂**（事實鐵律唔受 params 化影響）。
 * v1 執行器唔係 graph interpreter：執行仍係現有 code path，每決策點讀 ACTIVE params（store.ts）。
 */
import { z } from "zod";

export const WORKFLOW_KEYS = ["triage", "booking-session", "reminder", "pain-triage", "lexicon"] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

// ── triage ────────────────────────────────────────────────────────────
/** AI triage 路徑（ai.worker 普通消息分支）嘅可調參數。 */
export const TriageParams = z.object({
  // Phase A 第八閘（原 env AI_HUMAN_COOLDOWN_MS 硬編碼 30 分鐘底）
  humanCooldownMs: z.number().int().min(0).max(24 * 3_600_000),
  // 低過呢個 → AUTO block "low-confidence"（Phase D 新第九閘）
  confidenceFloor: z.number().min(0).max(1),
  // 多謝/道別嘅 AUTO 覆語（原 prompt 硬編碼例句）
  autoThanksReply: z.string().max(120),
  // ★ cwi-h6-20260830（h5 §3，MD §3 缺口 2）：auto-release 超時 N 分鐘 —
  //   三條件（有未覆訊息 ∧ 病人等夠 N ∧ 負責人齋夠 N）全真 → cron 放手回隊列（default 15）
  autoReleaseMinutes: z.number().int().min(1).max(24 * 60).default(15), // default 15 — 舊 draft（冇呢個欄）照過驗證（W1 迴歸）
});
export const TRIAGE_DEFAULTS: z.infer<typeof TriageParams> = {
  humanCooldownMs: 30 * 60_000,
  confidenceFloor: 0.6,
  autoThanksReply: "唔緊要，祝你早日康復！",
  autoReleaseMinutes: 15,
};

// ── booking-session ───────────────────────────────────────────────────
/** slot-filling 對話 engine（session-engine.ts）嘅可調參數。defaults = Phase C engine 硬編碼原句。 */
export const SessionParams = z.object({
  maxTurns: z.number().int().min(4).max(30), // engine MAX_TURNS
  maxNoProgress: z.number().int().min(1).max(10), // engine MAX_NO_PROGRESS
  candidateCount: z.number().int().min(1).max(8), // engine CANDIDATE_COUNT
  askProviderText: z.string().max(160), // 「想約邊位醫生？我哋有：{providers}」
  candidateHeader: z.string().max(160), // 「而家有以下時段：」
  candidateFooter: z.string().max(160), // 「直接覆編號或者講你想要嘅時間就得🙂」
  confirmText: z.string().max(160), // 「同你確認一次：{date} {time} {provider}，啱唔啱？」
  slotTakenText: z.string().max(160), // 「唔好意思，呢個時段啱啱滿咗。」
  handoffText: z.string().max(160), // 「等我搵職員直接同你安排 🙏」
  staleDisclaimer: z.string().max(80), // 「（時段以最終確認為準）」
});
export const SESSION_DEFAULTS: z.infer<typeof SessionParams> = {
  maxTurns: 12,
  maxNoProgress: 3,
  candidateCount: 5,
  askProviderText: "想約邊位醫生？我哋有：{providers}",
  candidateHeader: "而家有以下時段：",
  candidateFooter: "直接覆編號或者講你想要嘅時間就得🙂",
  confirmText: "同你確認一次：{date} {time} {provider}，啱唔啱？",
  slotTakenText: "唔好意思，呢個時段啱啱滿咗。",
  handoffText: "等我搵職員直接同你安排 🙏",
  staleDisclaimer: "（時段以最終確認為準）",
};

// ── pain-triage（★ Part E cwi-paintriage-20260903，MD §Part E E.6）──────────────────
import { DEFAULT_PAIN_QUESTIONS, PainQuestion } from "@/lib/sessions/pain-triage";
import { floorTermSet } from "@/lib/sessions/red-flags";
import { EXIT_FORBIDDEN_PHRASES } from "@/lib/sessions/impressions";

/**
 * 痛症問診 params（playbook 級自訂 — P-6：問題清單/紅旗詞/閾值/文案全開放，流程骨架鎖死）。
 * 鐵律 enforce（zod refine，API 400）：
 *   - redFlagTerms 只準收**附加詞** — FLOOR 詞（code 常數）唔准寫入（「刪 FLOOR」物理上無路徑）
 *   - impressionTemplates / exitDraftTemplate 措辭鐵律 — forbidden 短語零容忍
 *   - exitDraftTemplate 結構 — ①{impression} ②「先確定」 ③{examination}{window}「想約邊日」必在（文案可改、結構鎖死）
 */
export const PainTriageParams = z
  .object({
    questions: z.array(PainQuestion).min(3),
    redFlagTerms: z.record(z.string(), z.array(z.string().min(1).max(40))),
    severityThreshold: z.number().int().min(5).max(10).default(8),
    postOpWindowDays: z.number().int().min(1).max(60).default(14),
    sleepComboRule: z.boolean().default(true),
    impressionTemplates: z.record(z.string(), z.string().min(1).max(120)).default({}), // 空 = 內建措辭；partial PUT（e2e T102）允許缺省
    exitDraftTemplate: z.string().min(10).max(240),
    urgentInternalNote: z.string().min(1).max(160).default("紅旗：{categories} — 請即跟進"),
    autoReleaseMinutes: z.number().int().min(3).max(240).default(15), // Part A.5 共用
  })
  .refine((p) => {
    const floor = floorTermSet();
    for (const terms of Object.values(p.redFlagTerms)) {
      for (const t of terms) if (floor.has(t)) return false; // FLOOR 詞唔准寫入 params
    }
    return true;  }, { message: "redFlagTerms 唔准包含內建下限詞（FLOOR）— 佢哋係 code 常數，唔可刪", path: ["redFlagTerms"] })
  .refine((p) => {
    for (const v of Object.values(p.impressionTemplates)) {
      if (EXIT_FORBIDDEN_PHRASES.some((x) => v.includes(x))) return false;
    }
    if (EXIT_FORBIDDEN_PHRASES.some((x) => p.exitDraftTemplate.includes(x))) return false;
    return true;
  }, { message: "措辭鐵律：模板永唔出現「確診／你係／一定要」", path: ["exitDraftTemplate"] })
  .refine((p) => {
    const t = p.exitDraftTemplate;
    return t.includes("{impression}") && t.includes("{examination}") && t.includes("{window}") && t.includes("先確定") && t.includes("想約邊日");
  }, { message: "出口模板結構：{impression}、{examination}、{window}、「先確定」、「想約邊日」必在（文案可改、結構鎖死）", path: ["exitDraftTemplate"] });
export const PAIN_TRIAGE_DEFAULTS: z.infer<typeof PainTriageParams> = {
  questions: DEFAULT_PAIN_QUESTIONS,
  redFlagTerms: {}, // 附加詞 only — FLOOR 係 code 常數（red-flags.ts RED_FLAG_FLOOR）
  severityThreshold: 8,
  postOpWindowDays: 14,
  sleepComboRule: true,
  impressionTemplates: {}, // 空 = 用 impressions.ts 內建措辭
  exitDraftTemplate: "{impression}實際情況要{examination}睇過先確定。呢類情況建議{window}返嚟檢查，想約邊日？",
  urgentInternalNote: "紅旗：{categories} — 請即跟進",
  autoReleaseMinutes: 15,
};

// ── lexicon（★ Part E E.8 — 新 workflow key）────────────────────────────
/** 術語 → canonical。全局 ∪ per-clinic（同 term per-clinic 優先）；運行時上限 60 條（超出 log warn 截斷）。 */
export const LexiconParams = z.object({
  entries: z.array(
    z.object({
      term: z.string().min(1).max(40),
      canonical: z.string().min(1).max(40),
      note: z.string().max(80).optional(),
    })
  ),
});
/** 種子詞表 13 組（MD E.8 完整列表 — 多 term 同 canonical 拆開逐條）。 */
const L = (term: string, canonical: string, note?: string) => ({ term, canonical, ...(note ? { note } : {}) });
export const LEXICON_DEFAULTS: z.infer<typeof LexiconParams> = {
  entries: [
    L("cool牙", "矯齒"), L("箍牙", "矯齒"), L("戴牙箍", "矯齒"),
    L("剝牙", "拔牙"), L("脫牙", "拔牙"),
    L("杜牙根", "根管治療"),
    L("洗牙", "潔齒"),
    L("鑲牙", "牙冠"), L("牙套", "牙冠"),
    L("牙橋", "牙橋"),
    L("智慧齒", "智慧齒"), L("唪牙", "智慧齒"),
    L("漂牙", "美白"), L("整白", "美白"),
    L("崩牙", "崩裂"),
    L("牙托", "義齒"), L("假牙", "義齒"),
    L("蛀牙", "齲齒"), L("牙洞", "齲齒"),
    L("牙肉腫", "牙周問題"), L("牙肉出血", "牙周問題"),
    L("牙搖", "牙齒鬆動"),
  ],
};

// ── reminder ──────────────────────────────────────────────────────────
/** T-24h 預約提醒掃描（reminder.ts）嘅可調參數。defaults = 原 env 底（REMINDER_MIN/MAX_HOURS、TEMPLATE_REMINDER_NAME/LANG）。 */
export const ReminderParams = z
  .object({
    minHours: z.number().min(1).max(72), // 原 env REMINDER_MIN_HOURS（底 23）
    maxHours: z.number().min(1).max(72), // 原 env REMINDER_MAX_HOURS（底 25）
    templateName: z.string().max(64), // 原 env TEMPLATE_REMINDER_NAME（底 appt_reminder_zh）
    templateLang: z.string().max(16), // 原 env TEMPLATE_REMINDER_LANG（底 zh_HK）
  })
  .refine((p) => p.maxHours > p.minHours, { message: "maxHours 要大過 minHours" });
export const REMINDER_DEFAULTS: z.infer<typeof ReminderParams> = {
  minHours: 23,
  maxHours: 25,
  templateName: "appt_reminder_zh",
  templateLang: "zh_HK",
};

// ── key → schema/defaults 索引 ─────────────────────────────────────────
export const PARAMS_SCHEMAS: Record<WorkflowKey, z.ZodType> = {
  triage: TriageParams,
  "booking-session": SessionParams,
  reminder: ReminderParams,
  "pain-triage": PainTriageParams,
  lexicon: LexiconParams,
};
export type TriageParamsType = z.infer<typeof TriageParams>;
export type SessionParamsType = z.infer<typeof SessionParams>;
export type ReminderParamsType = z.infer<typeof ReminderParams>;
export type PainTriageParamsType = z.infer<typeof PainTriageParams>;
export type LexiconParamsType = z.infer<typeof LexiconParams>;

// ★ per-key 型（唔好寫成 Record<WorkflowKey, 三選一 union> — 會令 PARAMS_DEFAULTS.triage.x 型檢不過）
export type ParamsDefaults = {
  [K in WorkflowKey]: K extends "triage"
    ? TriageParamsType
    : K extends "booking-session"
      ? SessionParamsType
      : K extends "reminder"
        ? ReminderParamsType
        : K extends "pain-triage"
          ? PainTriageParamsType
          : LexiconParamsType;
};

export const PARAMS_DEFAULTS: ParamsDefaults = {
  triage: TRIAGE_DEFAULTS,
  "booking-session": SESSION_DEFAULTS,
  reminder: REMINDER_DEFAULTS,
  "pain-triage": PAIN_TRIAGE_DEFAULTS,
  lexicon: LEXICON_DEFAULTS,
};

/** key → params 型別映射（store.getParams 泛型用）。 */
export type ParamsOf<K extends WorkflowKey> = K extends "triage"
  ? TriageParamsType
  : K extends "booking-session"
    ? SessionParamsType
    : K extends "reminder"
      ? ReminderParamsType
      : K extends "pain-triage"
        ? PainTriageParamsType
        : LexiconParamsType
        ;

// ── schemaHints（admin 表單驅動 + API 回傳）— 同 zod schema 一一对应 ────────
export interface FieldHint {
  name: string;
  label: string;
  type: "int" | "number" | "string" | "bool";
  min?: number;
  max?: number;
  maxLength?: number;
  textarea?: boolean; // 長文案 → textarea
}
export const SCHEMA_HINTS: Record<WorkflowKey, FieldHint[]> = {
  triage: [
    { name: "humanCooldownMs", label: "真人冷靜期（ms）— 第八閘", type: "int", min: 0, max: 24 * 3_600_000 },
    { name: "confidenceFloor", label: "置信度下閾 — 第九閘 low-confidence", type: "number", min: 0, max: 1 },
    { name: "autoThanksReply", label: "多謝/道別 AUTO 覆語", type: "string", maxLength: 120 },
  ],
  "booking-session": [
    { name: "maxTurns", label: "最大輪數", type: "int", min: 4, max: 30 },
    { name: "maxNoProgress", label: "冇進展上限", type: "int", min: 1, max: 10 },
    { name: "candidateCount", label: "候選時段數", type: "int", min: 1, max: 8 },
    { name: "askProviderText", label: "問醫生（{providers}）", type: "string", maxLength: 160 },
    { name: "candidateHeader", label: "候選頭句", type: "string", maxLength: 160 },
    { name: "candidateFooter", label: "候選尾句", type: "string", maxLength: 160 },
    { name: "confirmText", label: "確認句（{date} {time} {provider}）", type: "string", maxLength: 160 },
    { name: "slotTakenText", label: "時段滿咗句", type: "string", maxLength: 160 },
    { name: "handoffText", label: "人手接手句", type: "string", maxLength: 160 },
    { name: "staleDisclaimer", label: "STALE 免責尾句", type: "string", maxLength: 80 },
  ],
  reminder: [
    { name: "minHours", label: "窗口起（小時）", type: "number", min: 1, max: 72 },
    { name: "maxHours", label: "窗口止（小時）", type: "number", min: 1, max: 72 },
    { name: "templateName", label: "Template 名", type: "string", maxLength: 64 },
    { name: "templateLang", label: "Template 語言", type: "string", maxLength: 16 },
  ],
  // ★ Part E（cwi-paintriage-20260903）：scalar 欄先入 hints；questions / redFlagTerms / impressionTemplates
  //   係結構化欄 → UI 自訂編輯器（form JSON 欄）。
  "pain-triage": [
    { name: "severityThreshold", label: "痛級紅旗閾值（1–10）", type: "int", min: 5, max: 10 },
    { name: "postOpWindowDays", label: "術後自動判窗口（日）", type: "int", min: 1, max: 60 },
    { name: "sleepComboRule", label: "瞓唔到+痛級≥6 組合規則", type: "bool" },
    { name: "autoReleaseMinutes", label: "auto-release 超時（分鐘）— Part A.5 共用", type: "int", min: 3, max: 240 },
    { name: "urgentInternalNote", label: "紅旗內部備註模板（{categories}）", type: "string", maxLength: 160 },
    { name: "exitDraftTemplate", label: "出口草稿模板（{impression}{examination}{window}）", type: "string", maxLength: 240 },
  ],
  // lexicon 全部欄 = entries（自訂編輯器）— hints 空。
  lexicon: [],
};

/**
 * deterministic 佔位符替換（事實鐵律：LLM 永不掂文案）。
 * `{name}` → vars[name]；未知佔位符 **原樣保留**（唔吞、唔爆）。
 */
export function fillVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m
  );
}

// ── buildGraph（唯讀顯示用 — 純顯示，執行器 v1 唔讀 graph）──────────────
export interface GraphNode {
  id: string;
  label: string;
  subtitle?: string;
  kind: "trigger" | "condition" | "action";
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}
export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** triage：inbound → 鐵律閘 → confidence 閘 → AUTO 發送 / DRAFT fallback。 */
function buildTriageGraph(p: TriageParamsType): WorkflowGraph {
  const ms = p.humanCooldownMs;
  const human = ms === 0 ? "關（0ms）" : `${Math.round(ms / 60_000)} 分鐘`;
  return {
    nodes: [
      { id: "in", label: "Inbound 訊息", kind: "trigger" },
      { id: "iron", label: "鐵律閘 ×7", subtitle: "URGENT_PAIN / COMPLAINT / HIGH / needsHuman / no-draft / window / assigned / resolved / media", kind: "condition" },
      { id: "cooldown", label: "真人冷靜期", subtitle: `${human}（第八閘）`, kind: "condition" },
      { id: "confidence", label: "置信度閘", subtitle: `confidence ≥ ${p.confidenceFloor}（第九閘）`, kind: "condition" },
      { id: "auto", label: "AUTO 發送", kind: "action" },
      { id: "draft", label: "退回 DRAFT", subtitle: "pending draft 俾 staff 審批", kind: "action" },
    ],
    edges: [
      { from: "in", to: "iron" },
      { from: "iron", to: "draft", label: "任何一閘中" },
      { from: "iron", to: "cooldown", label: "全過" },
      { from: "cooldown", to: "draft", label: "human-recent" },
      { from: "cooldown", to: "confidence", label: "過" },
      { from: "confidence", to: "draft", label: "low-confidence" },
      { from: "confidence", to: "auto", label: "過" },
    ],
  };
}

/** booking-session：預約 intent → 收 slots → 候選 → 確認 → 落單/卡；超限/冇進展 → 人手接手。 */
function buildSessionGraph(p: SessionParamsType): WorkflowGraph {
  return {
    nodes: [
      { id: "in", label: "BOOKING_REQUEST", kind: "trigger" },
      { id: "collect", label: "收集 slots", subtitle: `≤${p.maxTurns} 輪`, kind: "condition" },
      { id: "stall", label: "冇進展？", subtitle: `≥${p.maxNoProgress} 輪`, kind: "condition" },
      { id: "candidates", label: "列候選時段", subtitle: `≤${p.candidateCount} 個`, kind: "action" },
      { id: "confirm", label: "確認", subtitle: p.confirmText, kind: "condition" },
      { id: "book", label: "落單", subtitle: "L3 出卡 / L4+pinned 自動落單", kind: "action" },
      { id: "handoff", label: "人手接手", subtitle: p.handoffText, kind: "action" },
    ],
    edges: [
      { from: "in", to: "collect" },
      { from: "collect", to: "stall", label: "每輪" },
      { from: "stall", to: "handoff", label: "中" },
      { from: "stall", to: "candidates", label: "未中" },
      { from: "candidates", to: "confirm", label: "齊料" },
      { from: "confirm", to: "book", label: "確認" },
      { from: "confirm", to: "candidates", label: "改主意" },
    ],
  };
}

/** reminder：cron 掃描 → 窗口判斷 → 發 template。 */
function buildReminderGraph(p: ReminderParamsType): WorkflowGraph {
  return {
    nodes: [
      { id: "cron", label: "Cron 掃描（每 5 分鐘）", kind: "trigger" },
      { id: "window", label: "開診時刻窗口", subtitle: `now + ${p.minHours}h ~ ${p.maxHours}h`, kind: "condition" },
      { id: "send", label: "發 template", subtitle: `${p.templateName}（${p.templateLang}）`, kind: "action" },
      { id: "skip", label: "跳過（待下次掃描）", kind: "action" },
    ],
    edges: [
      { from: "cron", to: "window" },
      { from: "window", to: "send", label: "喺窗口內" },
      { from: "window", to: "skip", label: "窗口外" },
    ],
  };
}

/** ★ Part E：pain-triage 唯讀流程圖（E.2 fast path + 問診 loop + 紅旗引擎 + 出口）。 */
function buildPainTriageGraph(p: PainTriageParamsType): WorkflowGraph {
  const qCount = p.questions.filter((q) => q.enabled).length;
  return {
    nodes: [
      { id: "in", label: "PAIN intent（一般痛，無紅旗詞）", kind: "trigger" },
      { id: "postop", label: "術後自動判（E.7）", subtitle: `近 ${p.postOpWindowDays} 日治療記錄 → autoPostOp（fail-soft）`, kind: "condition" },
      { id: "loop", label: "問診 loop", subtitle: `${qCount} 條問句（一 turn 一條）`, kind: "action" },
      { id: "rf", label: "確定性紅旗 engine（E.4）", subtitle: `FLOOR ∪ 附加詞 / severity≥${p.severityThreshold} / 術後 / 瞓唔到組合${p.sleepComboRule ? "" : "（已關）"}`, kind: "condition" },
      { id: "urgent", label: "URGENT 全套（P-8）", subtitle: "紅標+StaffNotice+urgent:escalation+AI 收聲 — 鐵律零改動", kind: "action" },
      { id: "exit", label: "出口 E.5", subtitle: "impression 白名單 + 三句式 L1 草稿俾 staff 發", kind: "action" },
      { id: "booking", label: "病人覆日期 → BOOKING_REQUEST", subtitle: "現有 booking 流程自然接手（唔使寫橋）", kind: "action" },
    ],
    edges: [
      { from: "in", to: "postop" },
      { from: "postop", to: "urgent", label: "autoPostOp（即紅旗）" },
      { from: "postop", to: "loop", label: "未中" },
      { from: "loop", to: "rf", label: "每輪抽槽後" },
      { from: "rf", to: "urgent", label: "中即終止" },
      { from: "rf", to: "loop", label: "未中 → 問下一條" },
      { from: "loop", to: "exit", label: "齊料 / maxTurns" },
      { from: "exit", to: "booking", label: "staff 發後" },
    ],
  };
}

/** ★ Part E：lexicon 唯讀圖（纯提示層 — 唔改流程）。 */
function buildLexiconGraph(p: LexiconParamsType): WorkflowGraph {
  return {
    nodes: [
      { id: "src", label: "全局 ∪ per-店（同 term per-店優先）", subtitle: `${p.entries.length} 條（上限 60，超出截斷+warn）`, kind: "trigger" },
      { id: "apply", label: "applyLexicon 正規化", subtitle: "紅旗 match 前 + impression 主訴保留原文", kind: "action" },
      { id: "inject1", label: "注入 classify system prompt 尾", kind: "action" },
      { id: "inject2", label: "注入 PAIN_TRIAGE 抽槽 prompt", kind: "action" },
    ],
    edges: [
      { from: "src", to: "apply" },
      { from: "apply", to: "inject1", label: "LLM 理解" },
      { from: "apply", to: "inject2", label: "LLM 理解" },
    ],
  };
}

/** key + params → 顯示用 graph（store.saveDraft 時生成落庫；admin 前端亦可 live 重算）。
 * 入參鬆型（Record）— admin client 直接餵 DB row 而唔使每 key 具體型別。 */
export function buildGraph<K extends WorkflowKey>(key: K, params: Record<string, unknown>): WorkflowGraph {
  switch (key) {
    case "triage":
      return buildTriageGraph(params as TriageParamsType);
    case "booking-session":
      return buildSessionGraph(params as SessionParamsType);
    case "reminder":
      return buildReminderGraph(params as ReminderParamsType);
    case "pain-triage":
      return buildPainTriageGraph(params as PainTriageParamsType);
    case "lexicon":
      return buildLexiconGraph(params as LexiconParamsType);
  }
}
