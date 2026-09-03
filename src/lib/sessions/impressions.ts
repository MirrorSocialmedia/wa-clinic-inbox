/**
 * ★ Part E（cwi-paintriage-20260903，MD §Part E E.5）：問診出口 impression + 三句式草稿（pure — 零 IO）。
 *
 * 白名單七條（MD 表）：sensitivity / pulpitis / apical / perio / pericoronitis / fracture / post_op。
 * **post_op 唔出**（術後情境直接紅旗升級 — 行唔到出口草稿）。
 *
 * 三句式草稿（①可能性 ②未確診 ③下一步；冇 impression ①略去）：
 *   ①「常見原因係／有機會涉及／聽落似」— 措辭鐵律：永不出現「你係…」「確診」「一定要杜牙根」。
 *   ②「實際情況要{檢查}先確定」
 *   ③「建議{時間窗}返嚟睇。想約邊日？」
 *
 * 結構驗（zod 風格，buildExitDraft 內 enforce）：三段都在（impression 在時）＋ ②③ 必選 +
 * forbidden 短語零容忍 → 違反 = fallback 回內建模板 + warn（staff 改爛模板唔可以出街破措辭鐵律）。
 *
 * 多 impression 同時中：按 MD 表順序第一條（sensitivity > pulpitis > apical > perio > pericoronitis > fracture）。
 */
import type { PainSlotsType } from "./pain-triage";

export const IMPRESSION_KEYS = ["sensitivity", "pulpitis", "apical", "perio", "pericoronitis", "fracture"] as const;
export type ImpressionKey = (typeof IMPRESSION_KEYS)[number];

export interface ImpressionMeta {
  key: ImpressionKey;
  window: string; // ③ 時間窗
  exam: string; // ② 檢查
  defaultText: string; // ① 默認措辭（params impressionTemplates 可覆寫）
}

/** MD E.5 表（window/exam/措辭 全部照 MD 白名單）。 */
export const IMPRESSION_META: Record<ImpressionKey, ImpressionMeta> = {
  sensitivity: { key: "sensitivity", window: "兩星期內", exam: "睇牙", defaultText: "常見原因係牙齒敏感或者初期蛀牙" },
  pulpitis: { key: "pulpitis", window: "3 日內", exam: "照 X 光同牙髓活力測試", defaultText: "呢類痛有機會涉及牙髓（牙神經）" },
  apical: { key: "apical", window: "3 日內", exam: "照 X 光", defaultText: "咬落痛通常同根尖或者牙周組織有關" },
  perio: { key: "perio", window: "兩星期內", exam: "牙周探測", defaultText: "牙肉出血常見原因係牙齦或者牙周問題" },
  pericoronitis: { key: "pericoronitis", window: "3 日內", exam: "照 X 光", defaultText: "智慧齒位置痛常見原因係周圍牙肉發炎" },
  fracture: { key: "fracture", window: "一星期內", exam: "睇牙同照 X 光", defaultText: "聽落似牙齒結構有損傷" },
};

export const NO_IMPRESSION_WINDOW = "一星期內";
export const NO_IMPRESSION_EXAM = "睇牙";

/** 措辭鐵律 forbidden 短語（zod refine + 建草稿時雙重檢查）。 */
export const EXIT_FORBIDDEN_PHRASES = ["確診", "你係", "一定要"];

/** 默認出口模板（①②③ 三句式；{impression} 段冇 impression 時略去）。 */
export const DEFAULT_EXIT_TEMPLATE =
  "{impression}實際情況要{examination}先確定。建議{window}返嚟睇。想約邊日？";

const PERIO_CHIEF_TERMS = ["牙肉出血", "牙肉出晒血", "牙肉流血", "口好臭", "口臭"];
const FRACTURE_CHIEF_TERMS = ["崩咗", "裂咗", "崩裂", "補牙位甩咗", "填充物甩"];

/**
 * 白名單觸發（MD 表全行必須成立；chiefComplaints = 病人原文 canonical 化後）。
 * post_op 唔喺度（術後情境 = 紅旗，行唔到出口）。
 */
export function evaluateImpressions(slots: PainSlotsType, chiefComplaints: string[]): ImpressionKey | null {
  const cc = chiefComplaints.join(" ");
  // 1. sensitivity：刺激痛完即收 + 無自發痛 + 無腫
  if (slots.stimulusLinger === "instant" && slots.spontaneousPain === false && slots.swelling === false) {
    return "sensitivity";
  }
  // 2. pulpitis：刺激痛持續 / 夜痛 / 自發痛
  if (slots.stimulusLinger === "lingering" || slots.nightPain === true || slots.spontaneousPain === true) {
    return "pulpitis";
  }
  // 3. apical：咬合痛 + 無腫
  if (slots.bitePain === true && slots.swelling !== true) return "apical";
  // 4. perio：主訴牙肉出血 / 口臭 + 未講刺激痛
  if (PERIO_CHIEF_TERMS.some((t) => cc.includes(t)) && slots.stimulusLinger === null) return "perio";
  // 5. pericoronitis：智慧齒位置 + (咬合痛 ∨ 腫)
  const loc = slots.toothLocation ?? "";
  if ((loc.includes("智慧齒") || loc.includes("智齒") || loc.includes("最後面")) && (slots.bitePain === true || slots.swelling === true)) {
    return "pericoronitis";
  }
  // 6. fracture：主訴崩 / 裂 / 補牙位甩
  if (FRACTURE_CHIEF_TERMS.some((t) => cc.includes(t))) return "fracture";
  return null;
}

export interface ExitDraftOptions {
  impression: ImpressionKey | null;
  impressionTemplates: Record<string, string>; // params 可覆寫 ① 句
  exitDraftTemplate: string; // params 模板（staff 可調，結構 enforce）
}

export interface ExitDraftResult {
  draft: string;
  fellBack: boolean; // staff 模板結構驗失敗 → 用內建模板重建
}

function fillVars(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/** 草稿結構驗（MD E.5：zod 驗三段都在；冇 impression ①略去）。 */
function validateDraft(draft: string, impression: ImpressionKey | null, impressionText: string): boolean {
  if (draft.includes("確診") || draft.includes("你係") || draft.includes("一定要")) return false;
  if (!draft.includes("先確定")) return false; // ② 未確診
  if (!draft.includes("想約邊日")) return false; // ③ 下一步
  if (impression && !draft.includes(impressionText)) return false; // ① 可能性
  return true;
}

/** 建出口草稿（L1 — staff 審核後發）。結構壞 → fallback 內建模板（fallback 模板必過驗）。 */
export function buildExitDraft(opts: ExitDraftOptions): ExitDraftResult {
  const meta = opts.impression ? IMPRESSION_META[opts.impression] : null;
  const impressionText = opts.impression
    ? (opts.impressionTemplates[opts.impression] ?? meta!.defaultText)
    : "";
  const exam = meta ? meta.exam : NO_IMPRESSION_EXAM;
  const window = meta ? meta.window : NO_IMPRESSION_WINDOW;

  // ① 略去邏輯：模板開頭 "{impression}。" → 冇 impression 時整段拿走
  const tpl = opts.exitDraftTemplate.trim();
  const withImp = opts.impression !== null;
  const cleaned = withImp ? tpl.replace("{impression}", `${impressionText}。`) : tpl.replace("{impression}", "");

  const draft = fillVars(cleaned, { examination: exam, window }).replace(/\s+/g, " ").trim();
  if (validateDraft(draft, opts.impression, impressionText)) return { draft, fellBack: false };

  // fallback：內建模板重建（零 staff 文本 — 必然符合措辭鐵律）
  const def = withImp ? DEFAULT_EXIT_TEMPLATE.replace("{impression}", `${impressionText}。`) : DEFAULT_EXIT_TEMPLATE;
  return { draft: fillVars(def, { examination: exam, window }).trim(), fellBack: true };
}
