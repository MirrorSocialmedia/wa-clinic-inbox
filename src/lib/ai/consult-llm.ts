/**
 * ★ consult v2.1 C4（MD §6）：LLM 兩次 call — Call #1 抽槽 + Call #2 生成。
 *
 * - Call #1 抽槽：`temperature: 0`，單次 timeout 3s（CONSULT_EXTRACT_TIMEOUT_MS）。
 *   輸出 = slot JSON + objection + 五個 asks flag。
 *   **失敗（timeout 3s / JSON 爛）→ throw → caller 降級普通 QUESTION 回覆（state 不變）+ log `consult: extract failed`**。
 *   鐵律：`clinicalSuitability` 永唔可以喺 slotUpdates 出現（parse 層 throw — AI 唔寫臨床判斷）。
 * - Call #2 生成：`temperature: 0.4`。user = 結構化 payload（MD §6.2 逐字）：
 *   `action / stage / workflow / candidateCategory / products[{displayName, positioning, approvedWording, timeWording}] /
 *    priceRange{min,max,shortDisclaimer} / avoidPhrases[] / discoveryQuestion / recentMessages(6)`。
 *   products 由 caller 經 isProductUsable 鐵律過濾（unapproved/disabled 永遠唔入呢度）。
 * - 總 call 數 ≤3/turn（主 classify + #1 + #2 — worker audit CONSULT_LLM_TURN.meta.calls 可驗）。
 *
 * mock（AI_MOCK=1）= 決定性關鍵字（抽槽）+ 固定模板（生成）— e2e 驅動；bait token：
 * - `E2E-CONSULT-EXTRACT-FAIL` → 模擬 extract 爛 JSON（降級路徑）
 * - `E2E-CG-001`..`E2E-CG-009` → 模擬 LLM 故意輸出違規句（claim-guard 必擋）
 * AI_MOCK_FAIL=1 → 兩個 call 都 throw（同其他 mock 一致）。
 */
import log from "@/lib/log";
import { chatWithFallback, getAiConfig } from "@/lib/ai/vllm";
import { isAiMockEnabled, isAiMockFailEnabled, MOCK_MODEL_NAME } from "@/lib/ai/mock";
import { AiCallError } from "@/lib/ai/types";
import { CONSULT_CTA_BASELINE } from "@/lib/sessions/consult-content";

/** 同 ObjectionState.type 同構（consult-types 冇 export 獨立 union）— MD §6.1 objection 枚舉。 */
export type ObjectionCode = "PRICE" | "TIME" | "PAIN" | "APPEARANCE" | "TRUST" | "FEAR" | "COMPARISON" | "UNCERTAINTY";

export const CONSULT_EXTRACT_TIMEOUT_MS = 3000; // MD §6.1：timeout 3s

/** MD §6.2 八個 content action（LLM 生成範圍；START_BOOKING/HANDOFF/HANDOFF_HUMAN/PAIN_TRIAGE/END_SESSION/NO_DRAFT/WINDOW_EXPIRED_HANDOFF 唔入）— worker gate 同源。 */
export const CONSULT_LLM_ACTIONS: ReadonlySet<string> = new Set([
  "ASK_DISCOVERY",
  "EDUCATE_COMPARE",
  "EDUCATE_DETAIL",
  "PRESENT_OPTIONS",
  "ANSWER_PRICE",
  "HANDLE_OBJECTION",
  "BUILD_TRUST",
  "ASK_FOR_CONSULTATION",
]);

// ── Prompt（MD §6.1 / §6.2 逐字） ─────────────────────────────────────

export const CONSULT_EXTRACT_PROMPT = `你係牙科診所嘅對話理解模組。你只負責理解病人講緊乜，唔負責決定系統做咩。
輸出必須係單一 JSON object，唔准有解釋文字或 markdown 圍欄。

可填 slot：
  treatmentGoal: CROOKED | BITE | APPEARANCE | OTHER
  appearancePriority: HIGH | LOW
  speedPriority: HIGH | LOW
  budgetSensitivity: HIGH | LOW      // 病人主動表達價錢考慮先填
  statedBudget: 數字                  // 病人明講金額先填
  customerProductInterest: TRAD | IGO | IFULL   // 病人自己指名先填
  previousOrtho: YES | NO
  timeline: ASAP | WITHIN_3M | WITHIN_6M | NO_RUSH

規則：
1. 只填病人明確表達過嘅 slot，冇講就唔好填，唔准估。
2. 否定句要正確處理：「唔係好在意人哋見唔見到」→ appearancePriority = LOW。
3. 唔准填 clinicalSuitability（屬臨床判斷，唔喺你職責範圍）。
4. objection 只喺病人表達抗拒或疑慮時填。
5. 標示病人今輪有冇：要求比較、問價、問療程時間、問臨床細節（脫牙/骨釘/IPR/骨量）、
   問「邊款最適合我」、要求真人。

輸出：
{"slotUpdates":{...},
 "objection":"PRICE|TIME|PAIN|APPEARANCE|TRUST|FEAR|COMPARISON|UNCERTAINTY|null",
 "askedComparison":bool,"askedPrice":bool,"asksDuration":bool,
 "asksClinicalDetail":bool,"asksWhichSuitsMe":bool,"asksHuman":bool}`;

export const CONSULT_GENERATE_PROMPT = `你係香港牙科診所嘅前台助理，用廣東話同病人傾偈。

格式：
- 第一覆先有招呼（Hello☺️），之後唔好重複
- 總共 ≤4 行；emoji 每覆 1–2 個，只用 ☺️ 🫶🏻 🦷 🥺
- 口語化，唔用英文醫學縮寫（品牌名可保留）
- 每覆結尾一條推進問題（END_SESSION / HANDOFF 除外），每覆只問一條

內容鐵律（違反會被系統攔截）：
- 只可以用下面提供嘅 approved wording、知識片段、價格範圍
- 唔准講邊款方案最適合呢位病人 —— 適合邊款一律要醫生評估
- 唔准講療程時間，除非用返提供嘅 timeWording 原句
- 唔准診斷、唔准保證結果、唔准講成功率、唔准講邊個品牌好過邊個
- 唔准提及醫生當值／營業時間／可約時段
- 病人提到痛/腫/流血 → 唔好推銷，表達關心並講會安排跟進
- 提供嘅 avoidPhrases 一句都唔准出現

按 action 執行：
  ASK_DISCOVERY        : 簡短回應 + 問指定嗰條問題
  EDUCATE_COMPARE      : 只比較指定產品，只講同病人已表達需求相關嘅客觀差異
  EDUCATE_DETAIL       : 用 approved wording 作有限說明 + 建議由醫生評估
  ANSWER_PRICE         : 答價格範圍 + 講明最終費用視乎評估 + 一句輕量推進
  PRESENT_OPTIONS      : 講方案類別同當中選擇嘅客觀分別，明確講「實際邊款適合你要睇返牙齒情況」，再邀約評估
  HANDLE_OBJECTION     : 先認同 → 用批准資料回應 → 一條推進問題（唔准自創折扣/分期）
  BUILD_TRUST          : 講評估流程（拍片、書面計劃）→ 邀約
  ASK_FOR_CONSULTATION : 講清楚要評估先確認得到 + 問幾時方便`;

// ── Types ─────────────────────────────────────────────────────────────

export interface ConsultExtractOutput {
  slotUpdates: Record<string, string | number>;
  objection: ObjectionCode | null;
  askedComparison: boolean;
  askedPrice: boolean;
  asksDuration: boolean;
  asksClinicalDetail: boolean;
  asksWhichSuitsMe: boolean;
  asksHuman: boolean;
}

export interface ConsultGenerateProduct {
  displayName: string;
  positioning: string;
  approvedWording: string;
  timeWording: string | null;
}

/** MD §6.2 user 結構化 payload（逐字欄位）。 */
export interface ConsultGeneratePayload {
  action: string;
  stage: string;
  workflow: string;
  candidateCategory: string | null;
  products: ConsultGenerateProduct[];
  priceRange: { min: number | null; max: number | null; shortDisclaimer: string | null } | null;
  avoidPhrases: string[];
  discoveryQuestion: string | null;
  recentMessages: { direction: "IN" | "OUT"; body: string }[];
}

// ── Call #1 抽槽 ──────────────────────────────────────────────────────

const SLOT_ENUMS: Record<string, readonly string[]> = {
  treatmentGoal: ["CROOKED", "BITE", "APPEARANCE", "OTHER"],
  appearancePriority: ["HIGH", "LOW"],
  speedPriority: ["HIGH", "LOW"],
  budgetSensitivity: ["HIGH", "LOW"],
  customerProductInterest: ["TRAD", "IGO", "IFULL"],
  previousOrtho: ["YES", "NO"],
  timeline: ["ASAP", "WITHIN_3M", "WITHIN_6M", "NO_RUSH"],
};
const OBJECTION_ENUM: readonly string[] = ["PRICE", "TIME", "PAIN", "APPEARANCE", "TRUST", "FEAR", "COMPARISON", "UNCERTAINTY"];

/**
 * 解析 Call #1 輸出（纯函數 — 可單測）。
 * throw = JSON 爛 / shape 錯 / clinicalSuitability 闖入（→ caller 降級，state 不變）。
 * 未知 slot key / 壞 enum 值 → 該 key 忽略（fail-soft，唔 throw — JSON 本身合法）。
 */
export function parseConsultExtract(raw: string): ConsultExtractOutput {
  let t = (raw ?? "").trim();
  if (!t) throw new Error("consult extract: empty output");
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) throw new Error("consult extract: no JSON object");
  let obj: unknown;
  try {
    obj = JSON.parse(t.slice(s, e + 1));
  } catch {
    throw new Error("consult extract: JSON parse failed");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("consult extract: not an object");
  const o = obj as Record<string, unknown>;
  const su = o.slotUpdates;
  if (su !== undefined && su !== null && (typeof su !== "object" || Array.isArray(su))) {
    throw new Error("consult extract: slotUpdates not an object");
  }
  const slotUpdates: Record<string, string | number> = {};
  if (su && typeof su === "object") {
    for (const [k, v] of Object.entries(su as Record<string, unknown>)) {
      // 鐵律：AI 永唔可以寫臨床判斷欄
      if (k === "clinicalSuitability") throw new Error("consult extract: clinicalSuitability forbidden（AI 唔寫臨床判斷）");
      if (k === "meta" || v === undefined || v === null) continue;
      if (k === "statedBudget") {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        if (Number.isFinite(n) && n > 0) slotUpdates[k] = n;
        continue;
      }
      const enumVals = SLOT_ENUMS[k];
      if (!enumVals) continue; // 未知 key → 忽略
      if (typeof v === "string" && enumVals.includes(v)) slotUpdates[k] = v;
      // 壞 enum 值 → 忽略（唔 throw）
    }
  }
  const objectionRaw = o.objection;
  return {
    slotUpdates,
    objection: typeof objectionRaw === "string" && (OBJECTION_ENUM as readonly string[]).includes(objectionRaw)
      ? (objectionRaw as ObjectionCode)
      : null,
    askedComparison: o.askedComparison === true,
    askedPrice: o.askedPrice === true,
    asksDuration: o.asksDuration === true,
    asksClinicalDetail: o.asksClinicalDetail === true,
    asksWhichSuitsMe: o.asksWhichSuitsMe === true,
    asksHuman: o.asksHuman === true,
  };
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    slotUpdates: { type: "object" },
    objection: { type: ["string", "null"], enum: [...OBJECTION_ENUM, null] },
    askedComparison: { type: "boolean" },
    askedPrice: { type: "boolean" },
    asksDuration: { type: "boolean" },
    asksClinicalDetail: { type: "boolean" },
    asksWhichSuitsMe: { type: "boolean" },
    asksHuman: { type: "boolean" },
  },
};

function recentTextMessages(recent: { direction: string; body: string | null }[], n: number): { direction: "IN" | "OUT"; body: string }[] {
  return recent
    .filter((m) => typeof m.body === "string" && m.body.trim().length > 0)
    .slice(-n)
    .map((m) => ({ direction: (m.direction === "IN" ? "IN" : "OUT") as "IN" | "OUT", body: m.body as string }));
}

export interface ConsultExtractInput {
  /** 本輪病人訊息（raw）。 */
  text: string;
  workflow: string;
  /** 最近對話（worker ctxMessages）— mock 只用本輪；real 入 prompt context。 */
  recent: { direction: string; body: string | null }[];
}

/**
 * Call #1 抽槽（MD §6.1）。失敗 throw（timeout 3s / JSON 爛）→ caller 降級。
 */
export async function consultExtractSlots(input: ConsultExtractInput): Promise<ConsultExtractOutput> {
  if (isAiMockEnabled()) return mockConsultExtract(input);
  const cfg = getAiConfig();
  const lines = recentTextMessages(input.recent, 6).map((m) => `[${m.direction}] ${m.body}`);
  const userPayload = [
    "最近對話（最舊→最新）：",
    ...(lines.length > 0 ? lines : ["（無）"]),
    `本輪病人訊息：「${input.text}」`,
  ].join("\n");
  const res = await chatWithFallback(cfg, {
    messages: [
      { role: "system", content: CONSULT_EXTRACT_PROMPT },
      { role: "user", content: userPayload },
    ],
    temperature: 0,
    timeoutMs: CONSULT_EXTRACT_TIMEOUT_MS,
    maxTokens: 300,
    guidedJson: EXTRACT_SCHEMA,
  });
  return parseConsultExtract(res.content);
}

// ── Call #2 生成 ──────────────────────────────────────────────────────

export interface ConsultGenerateResult {
  text: string;
  model: string;
}

/**
 * Call #2 生成（MD §6.2）。失敗 throw → caller fail-soft（保留原 draft）。
 */
export async function consultGenerateDraft(payload: ConsultGeneratePayload): Promise<ConsultGenerateResult> {
  if (isAiMockEnabled()) return mockConsultGenerate(payload);
  const cfg = getAiConfig();
  const res = await chatWithFallback(cfg, {
    messages: [
      { role: "system", content: CONSULT_GENERATE_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    temperature: 0.4,
    maxTokens: 600,
  });
  // 輕度 sanitize（模型可能圍 markdown）— 內容守衛由 claim-guard 做
  const text = res.content.replace(/^```(?:\w*)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!text) throw new Error("consult generate: empty output");
  return { text, model: res.model };
}

// ── Discovery question（MD §4.6 口徑 — ASK_DISCOVERY 問指定嗰條） ──────

const ORTHO_DISCOVERY_QUESTIONS: Record<string, string> = {
  appearancePriority: "想多了解下，你比唔比重視戴咗之後人哋見到？",
  speedPriority: "想多了解下，你比唔比重視快啲做完？",
  timeline: "想多了解下，你大概邊時想做？",
  previousOrtho: "想多了解下，你之前有冇箍過牙？",
};
const IMPLANT_DISCOVERY_QUESTIONS: Record<string, string> = {
  missingCount: "想多了解下，你係一隻定幾多隻牙缺咗？",
  missingDuration: "想多了解下，缺咗大概幾耐？",
  hasSeenDentist: "想多了解下，你有冇去睇過醫生？",
};

/** ASK_DISCOVERY 問題文本（slotKey → 白話問題；null = 冇得問）。 */
export function consultDiscoveryQuestion(workflow: string, slotKey: string | null): string | null {
  if (!slotKey) return null;
  const table = workflow === "IMPLANT_CONSULT" ? IMPLANT_DISCOVERY_QUESTIONS : ORTHO_DISCOVERY_QUESTIONS;
  return table[slotKey] ?? null;
}

// ── Mock（AI_MOCK=1 — e2e 決定性驅動） ────────────────────────────────

function mockConsultExtract(input: ConsultExtractInput): ConsultExtractOutput {
  if (isAiMockFailEnabled()) throw new AiCallError("AI_MOCK_FAIL=1 — simulated AI outage");
  const body = input.text ?? "";
  // e2e bait：模擬 JSON 爛（parse 層 / real 路徑同一降級口徑）
  if (body.includes("E2E-CONSULT-EXTRACT-FAIL")) throw new Error("E2E-CONSULT-EXTRACT-FAIL — simulated corrupt JSON");
  const upd: Record<string, string | number> = {};
  const has = (terms: string[]) => terms.some((t) => body.includes(t));

  // appearancePriority（否定先判 — MD 規則 2；C3 fixture「箍牙幾時開始？」等句必須唔命中）
  if (has(["唔係好在意人哋見唔見到", "唔在意人哋見唔見到", "冇所謂人哋見唔見到", "唔使理人哋見到"])) {
    upd.appearancePriority = "LOW";
  } else if (has(["唔想俾人見到", "唔想人哋見到", "唔想俾人睇到", "唔想俾人知", "唔想顯眼", "想靚啲", "最緊要靚", "重視外貌"])) {
    upd.appearancePriority = "HIGH";
  }
  // speedPriority
  if (has(["想快啲", "要快啲", "越快越好", "想盡快", "想早啲做完", "急住做"])) upd.speedPriority = "HIGH";
  else if (has(["唔急", "唔使急", "慢慢嚟", "唔使咁快"])) upd.speedPriority = "LOW";
  // budgetSensitivity（病人主動表達價錢考慮先填 — 問價唔計）
  if (has(["最緊要平", "想平啲", "平啲", "太貴", "好貴", "貴到", "唔想太貴", "預算有限"])) upd.budgetSensitivity = "HIGH";
  // statedBudget（病人明講金額先填；中文數字 萬/千 + 阿拉伯數字）
  const mBudgetNum = body.match(/預算\s*(?:大概|大約|左右)?\s*(\d[\d,]*)/);
  const mWan = body.match(/([一二兩三四五六七八九])\s*[萬万]/);
  const mQian = body.match(/([一二兩三四五六七八九])\s*千/);
  const mMun = body.match(/(\d[\d,]{2,})\s*[蚊塊]/);
  const CN: Record<string, number> = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (mBudgetNum) upd.statedBudget = Number(mBudgetNum[1].replace(/,/g, ""));
  else if (mWan) upd.statedBudget = CN[mWan[1]] * 10000;
  else if (mQian) upd.statedBudget = CN[mQian[1]] * 1000;
  else if (mMun) upd.statedBudget = Number(mMun[1].replace(/,/g, ""));
  // customerProductInterest（病人自己指名先填）
  if (/\bi\s*full/i.test(body)) upd.customerProductInterest = "IFULL";
  else if (/\bi\s*go\b/i.test(body) || body.includes("I GO") || body.includes("隱適美")) upd.customerProductInterest = "IGO";
  else if (has(["傳統牙箍", "傳統箍牙", "金屬牙箍", "傳統固定"])) upd.customerProductInterest = "TRAD";
  // previousOrtho（必須係「我」— C3 fixture「你有冇幫人做过？」唔准命中）
  if (has(["我之前箍過", "我箍過牙", "我做过矯齒", "我戴過牙箍", "之前箍過牙", "我做咗隱適美", "我戴過隱形"])) upd.previousOrtho = "YES";
  else if (has(["我從未箍過", "我冇箍過", "我之前冇箍過"])) upd.previousOrtho = "NO";
  // timeline
  if (has(["盡快", "越快越好", "急住做"])) upd.timeline = "ASAP";
  else if (has(["三個月內"])) upd.timeline = "WITHIN_3M";
  else if (has(["半年內", "六個月內"])) upd.timeline = "WITHIN_6M";
  else if (has(["唔急", "唔使急", "慢慢嚟"])) upd.timeline = "NO_RUSH";

  // objection + asks flags（trace 用 — 只入 audit，engine 文本訊號係 authoritative）
  const lb = body.toLowerCase();
  let objection: ObjectionCode | null = null;
  if (has(["太貴", "好貴", "貴到", "好大條"])) objection = "PRICE";
  else if (has(["好耐", "太耐", "太長期"])) objection = "TIME";
  else if (has(["會唔會痛", "痛唔痛", "好疼"])) objection = "PAIN";
  else if (has(["唔夠靚", "唔自然", "太明顯", "好明顯"])) objection = "APPEARANCE";
  else if (has(["靠唔住", "唔信", "冇聽過", "hear of"])) objection = "TRUST";
  else if (has(["驚", "怕", "唔敢"])) objection = "FEAR";
  else if (has(["比較", "差咩", "咩分別", "分別係咩"])) objection = "COMPARISON";
  else if (has(["唔確定", "再諗下", "唔好肯定"])) objection = "UNCERTAINTY";

  return {
    slotUpdates: upd,
    objection,
    askedComparison: has(["比較", "差咩", "咩分別", "分別係咩", "邊個好", "邊樣好"]),
    askedPrice: has(["幾錢", "收費", "價錢", "幾多錢", "貴唔貴"]),
    asksDuration: has(["幾耐", "療程幾耐", "幾時做完", "幾時完成", "做唔做得完", "幾年先", "幾久"]),
    asksClinicalDetail: ["脫牙", "拔牙", "抽牙", "骨釘", "調磨", "磨牙", "骨量", "補骨", "影像", "x光", "x-ray"].some((t) => lb.includes(t)) || lb.includes("ipr"),
    asksWhichSuitsMe: has(["邊款最適合", "邊樣最適合", "咩最適合", "哪款適合", "邊個最適合", "邊款適合"]),
    asksHuman: has(["人工", "真人", "human"]),
  };
}

/** e2e CG bait → 模擬 LLM 故意輸出違規句（claim-guard 必擋 — 每條對應一個 code）。 */
function cgBaitDraft(code: string, payload: ConsultGeneratePayload, hi: string): string {
  switch (code) {
    case "CG-001":
      return `${hi}我睇咗你嘅相，你呢個係牙周病，要箍牙先。`;
    case "CG-002":
      return `${hi}跟住做療程，保證可以排齊。`;
    case "CG-003":
      return `${hi}我幫你睇過，你最適合做 I GO。`;
    case "CG-004":
      return `${hi}療程大概只需要兩個月。`;
    case "CG-005":
      return `${hi}我哋嘅成功率有 99%。`;
    case "CG-006":
      return `${hi}呢個品牌一定好過其他品牌。`;
    case "CG-007":
      // $500 = 任何箍牙/植牙 PRICE doc 範圍之下；無 doc 時 price-guard ① 先擋（pipeline）— unit 獨立驗 CG-007
      return `${hi}我哋可以俾 $500 做到。`;
    case "CG-008":
      return `${hi}你可以星期一三點嚟睇下。`;
    case "CG-009": {
      const p = payload.products[0];
      const phrase = payload.avoidPhrases[0] ?? "e2ec4 禁止講法";
      return `${p ? `${p.displayName}，` : ""}${phrase}。`;
    }
    default:
      return `${hi}收到！`;
  }
}

function shortPositioning(pos: string): string {
  const first = pos.split("、")[0]?.trim();
  return first && first.length > 0 ? first : pos;
}

function mockConsultGenerate(payload: ConsultGeneratePayload): ConsultGenerateResult {
  if (isAiMockFailEnabled()) throw new AiCallError("AI_MOCK_FAIL=1 — simulated AI outage");
  const lastIn = [...payload.recentMessages].reverse().find((m) => m.direction === "IN")?.body ?? "";
  // e2e CG bait（mock LLM 故意違規 — claim-guard 必擋）
  const cgBait = ["CG-001", "CG-002", "CG-003", "CG-004", "CG-005", "CG-006", "CG-007", "CG-008", "CG-009"].find(
    (c) => lastIn.includes(`E2E-${c}`)
  );
  const greeted = payload.recentMessages.some((m) => m.direction === "OUT" && m.body.trimStart().startsWith("Hello"));
  const hi = greeted ? "" : "Hello☺️ ";
  if (cgBait) return { text: cgBaitDraft(cgBait, payload, hi), model: MOCK_MODEL_NAME };

  const p = payload.products[0];
  let text: string;
  switch (payload.action) {
    case "ASK_DISCOVERY": {
      const q = payload.discoveryQuestion ?? "想多了解下，你主要想改善咩問題？";
      text = `${hi}多謝你查詢！${q}`;
      break;
    }
    case "EDUCATE_COMPARE": {
      const ps = payload.products;
      if (ps.length >= 2) {
        text = `${hi}${ps[0].displayName} 同 ${ps[1].displayName} 各有取向：${ps[0].displayName} 比較${shortPositioning(ps[0].positioning)}，${ps[1].displayName} 比較${shortPositioning(ps[1].positioning)}。實際邊款適合你要睇返牙齒情況，要唔要約評估傾下？🦷`;
      } else if (ps.length === 1) {
        text = `${hi}${ps[0].displayName} 呢款嘅資料我哋仲未確認咗，客觀分別要睇返你嘅牙齒情況先。要唔要約評估傾下？🦷`;
      } else {
        text = `${hi}呢幾款方案嘅客觀分別，要睇返你嘅牙齒情況先至講得準。要唔要約醫生評估傾下？🦷`;
      }
      break;
    }
    case "EDUCATE_DETAIL": {
      if (p) {
        text = `${hi}${p.approvedWording}${p.timeWording ? ` ${p.timeWording}` : ""}實際邊款適合你要睇返牙齒情況，建議由醫生評估先。你希望幾時傾下？🦷`;
      } else {
        text = `${hi}呢個要睇返你嘅實際情況先至講得準，建議由醫生評估。你希望幾時傾下？🦷`;
      }
      break;
    }
    case "ANSWER_PRICE": {
      const r = payload.priceRange;
      if (r && r.min !== null && r.max !== null) {
        const disc = r.shortDisclaimer ? `${r.shortDisclaimer} ` : "";
        text = `${hi}收費大約 ${r.min}–${r.max} 蚊。${disc}最終費用要睇返評估先至準確。要唔要我幫你安排評估？☺️`;
      } else {
        text = `${hi}收費要睇返你嘅實際情況先至講得準確，等我哋確認後即刻覆你。要唔要我幫你問下？☺️`;
      }
      break;
    }
    case "PRESENT_OPTIONS": {
      const catW =
        payload.candidateCategory === "CLEAR_ALIGNER" ? "透明方向" : payload.candidateCategory === "FIXED" ? "固定方向" : "幾種方向";
      const ps = payload.products;
      const prodLine = ps.length > 0 ? ` ${ps.map((x) => `${x.displayName}（${shortPositioning(x.positioning)}）`).join("、")}。` : "";
      text = `${hi}矯牙有幾種方向：${catW}。${prodLine}實際邊款適合你要睇返牙齒情況，要唔要約醫生評估一下？🦷`;
      break;
    }
    case "HANDLE_OBJECTION": {
      const approved = p ? ` ${p.approvedWording}` : "";
      text = `${hi}收到，明白你嘅顧慮🥺${approved}每個方案都要睇返實際情況先至決定，建議由醫生評估。你希望幾時傾下？`;
      break;
    }
    case "BUILD_TRUST": {
      text = `${hi}我哋嘅流程係先做評估（拍片＋書面計劃），你會清楚知道方案先至決定。要唔要約個評估？☺️`;
      break;
    }
    case "ASK_FOR_CONSULTATION": {
      const cta = CONSULT_CTA_BASELINE[payload.workflow as "ORTHODONTIC_CONSULT" | "IMPLANT_CONSULT"] ?? CONSULT_CTA_BASELINE.ORTHODONTIC_CONSULT;
      text = `${hi}要準確知道邊款適合你，要由醫生評估先確認得到。${cta}`;
      break;
    }
    default:
      // 唔應該到呢度（caller 只對 8 個 content action 呼叫）— 安全兜底
      text = `${hi}收到！你有咩想再了解下？`;
      log.warn({ action: payload.action }, "consult-mock: unexpected action（安全兜底）");
  }
  return { text, model: MOCK_MODEL_NAME };
}
