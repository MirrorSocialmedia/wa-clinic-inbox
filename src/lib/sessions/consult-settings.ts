/**
 * ★ consult v2.1 C5（MD §8.1 Tab 2/3）：AI 傾偈設定 — 持久層 + resolve helper。
 *
 * 存喺 `ConsultSetting`（clinicId nullable + key + value Json）：
 *   - clinicId null = 全局預設；店行 row 覆蓋全局（per-key 整值取代，唔係 field merge —
 *     UI 每次寫入都係完整 key value，口徑簡單可預期）。
 *   - keys：`rules`（Tab 2 白話規則開關）/ `discovery`（Tab 2 發現問題）/ `advanced`（Tab 3 進階）。
 *
 * **engine 接線口徑（C5 生死格：default no-op）**：
 *   - 無任何 row → 全部 default（rules 全開 / 出廠兩條問題 / 8-6-48）→ engine 行為同 C3/C4 逐 byte 一致。
 *   - fail-soft：load 失敗 / value 爛 → 該 key 用 default（log warn，唔阻 pipeline）。
 *
 * Tab 2 開關 → engine rule 映射（MD §8.1 表）：
 *   ortho_appearance  ORTHO-001/002（病人重視外觀 → 介紹隱形方案）
 *   ortho_compare     ORTHO-003（問「有咩分別」→ 比較）
 *   ortho_price       ORTHO-004/009（問價 → 講範圍）
 *   ortho_booking     ORTHO-010（高意向 → 直接幫約）
 *   鎖定（UI 灰鎖，無開關、engine 唔接 disable）：ORTHO-005 / ORTHO-007 / ORTHO-008 / 安全閘。
 *
 * discovery 問題 → slot 映射（MD §4.6 出廠兩條，跟 ORTHO_SLOT_VALUE 優先順序）：
 *   q1（快啲完成 定 唔想俾人睇到）→ appearancePriority（0.90，第一問）
 *   q2（療程快唔快）            → speedPriority（0.85，第二問）
 *   關咗某條 → skipSlots 對應 slot（engine chooseNextQuestion 唔問該 slot）。
 *   「問預算」= MD §4.6 鐵律（唔問）— UI 顯示預設關 + 標「診所選擇唔問」（鎖定，engine 永不問 budget）。
 *
 * 零 PII（純參數值）。
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import log from "@/lib/log";

export const CONSULT_SETTING_KEYS = ["rules", "discovery", "advanced"] as const;
export type ConsultSettingKey = (typeof CONSULT_SETTING_KEYS)[number];

// ── Tab 2：白話規則行（MD §8.1 表逐字 label；lock 嘅 UI 灰鎖 + hover 解釋） ──

export interface ConsultRuleRow {
  /** 開關 key（lock 行 = null — UI 無開關）。 */
  key: string | null;
  /** 白話（醫生見到嘅文字 — 零技術詞）。 */
  label: string;
  /** 對應 rule（hover 標題顯示；UI 唔印 code — 只入 aria/tooltip title 供 trace 對照）。 */
  ruleIds: string[];
  locked: boolean;
}

export const CONSULT_RULE_ROWS: ConsultRuleRow[] = [
  { key: "ortho_appearance", label: "病人重視外觀 → 介紹隱形方案（唔會指定邊款）", ruleIds: ["ORTHO-001", "ORTHO-002"], locked: false },
  { key: "ortho_compare", label: "病人問「有咩分別」→ 比較兩款隱形方案", ruleIds: ["ORTHO-003"], locked: false },
  { key: null, label: "病人問「邊款最適合我」→ 建議做評估，唔會答邊款", ruleIds: ["ORTHO-005"], locked: true },
  { key: "ortho_price", label: "病人問價 → 講價格範圍 + 實際睇評估", ruleIds: ["ORTHO-004", "ORTHO-009"], locked: false },
  { key: null, label: "病人問脫牙／骨釘 → 交返醫生，建議評估", ruleIds: ["ORTHO-008"], locked: true },
  { key: null, label: "病人講面腫／流血／好痛 → 即刻轉真人", ruleIds: [], locked: true },
  { key: null, label: "病人問療程幾耐 → 只用上面填嘅講法", ruleIds: ["ORTHO-007"], locked: true },
  { key: "ortho_booking", label: "病人講想約 → 直接幫佢約", ruleIds: ["ORTHO-010"], locked: false },
];

/** 開關 key → engine rule id（disabled 時 matchRule/transition row skip）。 */
export const RULE_GROUP_TO_RULES: Record<string, string[]> = {
  ortho_appearance: ["ORTHO-001", "ORTHO-002"],
  ortho_compare: ["ORTHO-003"],
  ortho_price: ["ORTHO-004", "ORTHO-009"],
  ortho_booking: ["ORTHO-010"],
};

// ── value shapes（zod — API 寫入 + load 時雙重驗證） ──────────────────

const rulesValueSchema = z.object({
  ortho_appearance: z.boolean(),
  ortho_compare: z.boolean(),
  ortho_price: z.boolean(),
  ortho_booking: z.boolean(),
});
export type RulesValue = z.infer<typeof rulesValueSchema>;

/** MD §4.6 出廠兩條（逐字）。 */
export const DEFAULT_DISCOVERY_QUESTIONS = [
  { id: "q1", text: "你自己比較著重 快啲完成，定係 唔想俾人睇到？", enabled: true },
  { id: "q2", text: "你會唔會都比較在意療程快唔快？", enabled: true },
] as const;

const discoveryValueSchema = z.object({
  /** 固定 q1/q2 兩條；陣列順序 = UI 拖序（顯示用）。 */
  questions: z
    .array(z.object({ id: z.enum(["q1", "q2"]), text: z.string().min(1).max(200), enabled: z.boolean() }))
    .min(2)
    .max(2),
  /** MD §8.1 Tab 2：「問預算」預設關 + 標「診所選擇唔問」（鎖定 — engine 永不問）。 */
  askBudget: z.boolean(),
});
export type DiscoveryValue = z.infer<typeof discoveryValueSchema>;

const advancedValueSchema = z.object({
  maxTurns: z.number().int().min(1).max(20).default(8),
  ctaAfterTurns: z.number().int().min(1).max(20).default(6),
  sessionIdleHours: z.number().int().min(1).max(168).default(48),
  /** 附加觸發詞（FLOOR 詞灰鎖唔可改 — 附加詞只係多幾個入口，唔會移除 FLOOR）。 */
  extraTriggerWords: z.array(z.string().min(1).max(20)).max(20).default([]),
});
export type AdvancedValue = z.infer<typeof advancedValueSchema>;

export const CONSULT_SETTING_DEFAULTS = {
  rules: { ortho_appearance: true, ortho_compare: true, ortho_price: true, ortho_booking: true },
  discovery: { questions: [...DEFAULT_DISCOVERY_QUESTIONS], askBudget: false },
  advanced: { maxTurns: 8, ctaAfterTurns: 6, sessionIdleHours: 48, extraTriggerWords: [] },
} as const;

export const rulesValueInput = (raw: unknown) => rulesValueSchema.safeParse(raw);
export const discoveryValueInput = (raw: unknown) => discoveryValueSchema.safeParse(raw);
export const advancedValueInput = (raw: unknown) => advancedValueSchema.safeParse(raw);

// ── discovery 問題 → slot（MD §4.6 兩條，跟 ORTHO_SLOT_VALUE 優先順序） ──

export const DISCOVERY_SLOT_BY_QUESTION: Record<string, string> = {
  q1: "appearancePriority",
  q2: "speedPriority",
};

// ── resolved（engine / UI 共用口徑） ──────────────────────────────────

export interface ResolvedConsultSettings {
  rules: RulesValue;
  discovery: DiscoveryValue;
  advanced: AdvancedValue;
  /** Tab 2 關咗嘅 rule id 集合（engine skip 用；空 = 全部規則開 = C3/C4 原行為）。 */
  disabledRules: Set<string>;
  /** Tab 2 關咗嘅 discovery slot（chooseNextQuestion skip 用）。 */
  discoverySkipSlots: string[];
  /** 醫生改過嘅發現問題文案（slot → text；engine 未改 = 用出廠表）。 */
  discoveryQuestionOverrides: Record<string, string>;
}

function defaults(): ResolvedConsultSettings {
  return {
    rules: { ...CONSULT_SETTING_DEFAULTS.rules },
    discovery: {
      questions: CONSULT_SETTING_DEFAULTS.discovery.questions.map((q) => ({ ...q })),
      askBudget: false,
    },
    advanced: { ...CONSULT_SETTING_DEFAULTS.advanced, extraTriggerWords: [] },
    disabledRules: new Set<string>(),
    discoverySkipSlots: [],
    discoveryQuestionOverrides: {},
  };
}

export function resolveFromValues(rules: RulesValue, discovery: DiscoveryValue, advanced: AdvancedValue): ResolvedConsultSettings {
  const base = defaults();
  base.rules = rules;
  base.discovery = { questions: discovery.questions.map((q) => ({ ...q })), askBudget: discovery.askBudget };
  base.advanced = { ...advanced, extraTriggerWords: [...advanced.extraTriggerWords] };
  for (const [group, on] of Object.entries(rules)) {
    if (!on) for (const rid of RULE_GROUP_TO_RULES[group] ?? []) base.disabledRules.add(rid);
  }
  for (const q of discovery.questions) {
    if (!q.enabled) base.discoverySkipSlots.push(DISCOVERY_SLOT_BY_QUESTION[q.id]);
  }
  // 文案 override：只喺問題開緊時生效（關咗 = skip 該 slot，無文案問題）
  for (const q of discovery.questions) {
    if (q.enabled && q.text.trim() && q.text !== DEFAULT_DISCOVERY_QUESTIONS.find((d) => d.id === q.id)?.text) {
      base.discoveryQuestionOverrides[DISCOVERY_SLOT_BY_QUESTION[q.id]] = q.text;
    }
  }
  return base;
}

/**
 * Load + merge（global → clinic 覆蓋）+ 解析成 engine-ready shape。
 * **fail-soft**：任何失敗 → 純 default（engine 行為同 C3/C4 一致 — 唔阻 pipeline）。
 */
export async function loadConsultSettings(prisma: PrismaClient, clinicId: string | null): Promise<ResolvedConsultSettings> {
  try {
    const rows = await prisma.consultSetting.findMany({
      where: clinicId === null ? { clinicId: null } : { OR: [{ clinicId: null }, { clinicId }] },
    });
    const byKey: Partial<Record<ConsultSettingKey, { global?: unknown; clinic?: unknown }>> = {};
    for (const r of rows) {
      if (!CONSULT_SETTING_KEYS.includes(r.key as ConsultSettingKey)) continue;
      const k = r.key as ConsultSettingKey;
      (byKey[k] ??= {})[r.clinicId === null ? "global" : "clinic"] = r.value;
    }
    const pick = (k: ConsultSettingKey) => byKey[k]?.clinic ?? byKey[k]?.global;

    const rulesParsed = rulesValueSchema.safeParse(pick("rules"));
    const rules = rulesParsed.success ? rulesParsed.data : (CONSULT_SETTING_DEFAULTS.rules as RulesValue);
    const discParsed = discoveryValueSchema.safeParse(pick("discovery"));
    const discovery = discParsed.success ? discParsed.data : { questions: CONSULT_SETTING_DEFAULTS.discovery.questions.map((q) => ({ ...q })), askBudget: false };
    const advParsed = advancedValueSchema.safeParse(pick("advanced"));
    const advanced = advParsed.success ? advParsed.data : { ...CONSULT_SETTING_DEFAULTS.advanced, extraTriggerWords: [] };

    if (!rulesParsed.success || !discParsed.success || !advParsed.success) {
      log.warn(
        { clinicId, bad: { rules: !rulesParsed.success, discovery: !discParsed.success, advanced: !advParsed.success } },
        "consult-settings: value 爛 → 用 default（fail-soft）"
      );
    }
    return resolveFromValues(rules, discovery, advanced);
  } catch (err) {
    log.warn({ clinicId, err: String(err) }, "consult-settings: load failed → default（fail-soft）");
    return defaults();
  }
}
