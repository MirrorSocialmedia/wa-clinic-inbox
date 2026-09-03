/**
 * ★ Part E（cwi-paintriage-20260903，MD §Part E E.4）：確定性紅旗 engine（pure — 零 IO）。
 *
 * 核心原則（P-1）：「牙痛」唔再直接 URGENT — 升級由呢份 engine 決定，LLM 只抽槽唔判級。
 * 判定四規則（MD E.4）：
 *   ① rawTexts（session 內病人原文，**已 lexicon canonical 化**）對 `FLOOR ∪ p.redFlagTerms`
 *   ② severity >= p.severityThreshold
 *   ③ recentTreatment === true ∨ autoPostOp（E.7 術後自動判）
 *   ④ functionalImpact 含 cant_sleep 且 severity >= 6（疑似急性牙髓炎組合；sleepComboRule 可關）
 * 附加（記錄偏離，超集只增唔減）：
 *   ⑤ slots.swelling === true → swelling 類 — 臨床理據（E.3：腫＝紅旗探測）；
 *      真 LLM 模式下病人換講「塊面有点腫」等 paraphrase 時 raw text 冇字面 FLOOR 詞，
 *      抽槽 swelling=true 係唯一可靠信號；e2e T98 喺 mock 模式下 ① 已經中（字面 FLOOR 詞）。
 *
 * RED_FLAG_FLOOR（code 常數，UI 顯示但唔可刪 — 附加詞 params 層面永遠唔包攞 FLOOR 詞）：
 * 七類 = bleeding / swelling / airway / fever / trauma / severe_pain / post_op。
 * post_op 唔係詞觸發（由 recentTreatment / autoPostOp 成立）— FLOOR 詞表空。
 *
 * PII：本檔只有詞表常數 + 純函數；rawTexts 只喺 memory 內匹配，唔入 log / DB。
 */
import type { PainSlotsType } from "./pain-triage";

export type RedFlagCategory =
  | "bleeding"
  | "swelling"
  | "airway"
  | "fever"
  | "trauma"
  | "severe_pain"
  | "post_op";

export const RED_FLAG_CATEGORIES: RedFlagCategory[] = [
  "bleeding",
  "swelling",
  "airway",
  "fever",
  "trauma",
  "severe_pain",
  "post_op",
];

/** 內建下限詞（MD E.4 表 + agent 補齊粵語變體）。post_op = 空（非詞觸發）。 */
export const RED_FLAG_FLOOR: Record<RedFlagCategory, string[]> = {
  bleeding: ["流血不止", "血止唔到", "不停流血", "血流唔停", "噴血"],
  swelling: ["面腫", "塊面腫咗", "面腫咗", "面頰腫", "頸腫", "眼腫", "眼瞼腫"],
  airway: ["吞唔到嘢", "呼吸困難", "呼吸唔順", "開唔到口", "牙關緊"],
  fever: ["發燒", "發緊燒", "高燒"],
  trauma: ["撞崩", "跌崩", "甩咗成隻", "成隻飛出嚟", "牙甩咗", "撞斷"],
  severe_pain: ["痛到瞓唔著", "止痛藥都唔得", "痛到想死", "痛到忍唔到", "痛入天靈蓋"],
  post_op: [], // 非詞觸發 — 由 recentTreatment / autoPostOp 成立
};

/** FLOOR 全詞扁平集（UI 鎖定 chip / zod 防寫入 / prompt 注入共用）。 */
export function floorTermSet(): Set<string> {
  const s = new Set<string>();
  for (const c of RED_FLAG_CATEGORIES) for (const t of RED_FLAG_FLOOR[c]) s.add(t);
  return s;
}

/**
 * engine 用嘅紅旗詞表 = FLOOR ∪ params 附加詞（per-category）。
 * params.redFlagTerms 理論上唔會含 FLOOR 詞（zod refine 拒）— union 係 defense in depth。
 */
export function effectiveRedFlagTerms(
  p: { redFlagTerms: Record<string, string[]> }
): Record<RedFlagCategory, string[]> {
  const out = {} as Record<RedFlagCategory, string[]>;
  for (const c of RED_FLAG_CATEGORIES) {
    const extra = p.redFlagTerms?.[c];
    out[c] = [...RED_FLAG_FLOOR[c], ...(Array.isArray(extra) ? extra : [])];
  }
  return out;
}

export interface RedFlagResult {
  hit: boolean;
  categories: RedFlagCategory[];
  /** 命中的詞（metadata 用 — 只係 FLOOR/params 詞表值，零病人原文；入 log / StaffNotice meta 安全） */
  terms: string[];
}

/**
 * 規則 ①：rawTexts（**入參必須已 lexicon canonical 化**）對 FLOOR ∪ params 詞表逐類匹配。
 * substring 匹配（粵語口語夾雜；長詞自帶邊界語意 — 「面腫」唔會誤中「面腫脹」以外嘅嘢）。
 */
export function matchRedFlagTerms(
  rawTexts: string[],
  p: { redFlagTerms: Record<string, string[]> }
): RedFlagResult {
  const cats: RedFlagCategory[] = [];
  const terms: string[] = [];
  const table = effectiveRedFlagTerms(p);
  for (const c of RED_FLAG_CATEGORIES) {
    if (c === "post_op") continue; // 非詞觸發
    for (const t of table[c]) {
      if (rawTexts.some((txt) => txt.includes(t))) {
        cats.push(c);
        terms.push(t);
        break; // 每類一個詞就夠
      }
    }
  }
  return { hit: cats.length > 0, categories: cats, terms };
}

/**
 * MD E.4 主入口：evaluateRedFlags(slots, rawTexts, p, autoPostOp)。
 * rawTexts 必須已 canonical 化（applyLexicon）。slots 可缺欄（問診中途）— 只判有值嘅規則。
 */
export function evaluateRedFlags(
  slots: Partial<PainSlotsType>,
  rawTexts: string[],
  p: {
    redFlagTerms: Record<string, string[]>;
    severityThreshold: number;
    sleepComboRule: boolean;
  },
  autoPostOp: boolean
): RedFlagResult {
  const cats = new Set<RedFlagCategory>();
  const terms: string[] = [];

  // ① raw text 對 FLOOR ∪ params
  const m = matchRedFlagTerms(rawTexts, p);
  for (const c of m.categories) cats.add(c);
  terms.push(...m.terms);

  // ② severity >= threshold
  if (typeof slots.severity === "number" && slots.severity >= p.severityThreshold) cats.add("severe_pain");

  // ③ 術後（最近治療自述 ∨ E.7 自動判）
  if (slots.recentTreatment === true || autoPostOp) cats.add("post_op");

  // ④ 疑似急性牙髓炎組合：cant_sleep ∧ severity>=6（sleepComboRule 可關）
  if (
    p.sleepComboRule &&
    Array.isArray(slots.functionalImpact) &&
    slots.functionalImpact.includes("cant_sleep") &&
    (slots.severity ?? 0) >= 6
  ) {
    cats.add("severe_pain");
  }

  // ⑤（超集）抽槽 swelling=true = 腫探測命中
  if (slots.swelling === true) cats.add("swelling");

  const categories = RED_FLAG_CATEGORIES.filter((c) => cats.has(c));
  return { hit: categories.length > 0, categories, terms };
}
