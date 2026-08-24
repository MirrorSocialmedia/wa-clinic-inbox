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

export const WORKFLOW_KEYS = ["triage", "booking-session", "reminder"] as const;
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
});
export const TRIAGE_DEFAULTS: z.infer<typeof TriageParams> = {
  humanCooldownMs: 30 * 60_000,
  confidenceFloor: 0.6,
  autoThanksReply: "唔緊要，祝你早日康復！",
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
};
export type TriageParamsType = z.infer<typeof TriageParams>;
export type SessionParamsType = z.infer<typeof SessionParams>;
export type ReminderParamsType = z.infer<typeof ReminderParams>;

// ★ per-key 型（唔好寫成 Record<WorkflowKey, 三選一 union> — 會令 PARAMS_DEFAULTS.triage.x 型檢不過）
export type ParamsDefaults = {
  [K in WorkflowKey]: K extends "triage"
    ? TriageParamsType
    : K extends "booking-session"
      ? SessionParamsType
      : ReminderParamsType;
};

export const PARAMS_DEFAULTS: ParamsDefaults = {
  triage: TRIAGE_DEFAULTS,
  "booking-session": SESSION_DEFAULTS,
  reminder: REMINDER_DEFAULTS,
};

/** key → params 型別映射（store.getParams 泛型用）。 */
export type ParamsOf<K extends WorkflowKey> = K extends "triage"
  ? TriageParamsType
  : K extends "booking-session"
    ? SessionParamsType
    : K extends "reminder"
      ? ReminderParamsType
      : never;

// ── schemaHints（admin 表單驅動 + API 回傳）— 同 zod schema 一一对应 ────────
export interface FieldHint {
  name: string;
  label: string;
  type: "int" | "number" | "string";
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
  }
}
