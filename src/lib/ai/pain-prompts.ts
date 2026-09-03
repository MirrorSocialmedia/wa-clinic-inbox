/**
 * ★ Part E（cwi-paintriage-20260903，MD §Part E E.3/E.8）：PAIN_TRIAGE 抽槽 prompt。
 *
 * 鐵律：LLM 只抽槽唔判級 — 紅旗升級由 evaluateRedFlags（red-flags.ts）確定性決定。
 * prompt 內紅旗詞表只作**抽槽認知**（LLM 見到要照常抽 redFlagSymptoms/swelling 等，
 * 系統會自動升級 — 唔好因為「覺得緊急」就改 action 或者唔抽槽）。
 *
 * PII：prompt 只入病人原文（本地 vLLM）+ 已收集 business metadata；prompt 本身永不入 log。
 */
import type { PainSlotsType } from "@/lib/sessions/pain-triage";
import type { LexiconEntry } from "@/lib/sessions/lexicon";
import { lexiconPromptBlock } from "@/lib/sessions/lexicon";

export interface PainPromptInput {
  todayHk: string; // YYYY-MM-DD
  clinicName: string;
  collected: PainSlotsType; // 已收集（engine 驗證過）
  /** 病人 IN 文字（最近幾條；**original** — 紅旗 canonical 匹配係 engine 層做，prompt 用原文） */
  recentIn: string[];
  /** FLOOR ∪ params 附加詞（per-category）— 抽槽認知用 */
  redFlagTerms: Record<string, string[]>;
  lexicon: LexiconEntry[]; // E.8：注入抽槽 prompt
}

function redFlagList(p: Record<string, string[]>): string {
  const lines = Object.entries(p)
    .filter(([, terms]) => terms.length > 0)
    .map(([cat, terms]) => `- ${cat}：${terms.join("、")}`);
  return lines.join("\n") || "（無）";
}

export function buildPainSystemPrompt(i: PainPromptInput): string {
  return [
    "你係香港牙醫診所嘅痛症問診抽槽助手。你嘅唯一工作：由病人最近嘅訊息抽出結構化痛症資料（slot 抽取）。",
    "★ 鐵律：你唔做任何輕重度 / 急症判斷 — 升級由系統確定性規則決定。你只負責「病人有冇講、講咗乜」。",
    "",
    "輸出：只可以返一個 JSON object，唔准任何多余文字 / markdown / 代碼欄，格式：",
    '{"slotUpdates": {"toothLocation": <string|null>, "durationDays": <number|null>, "severity": <number|null>, "stimulusLinger": <"instant"|"lingering"|"none"|null>, "spontaneousPain": <bool|null>, "nightPain": <bool|null>, "bitePain": <bool|null>, "swelling": <bool|null>, "functionalImpact": <array>, "redFlagSymptoms": <array>, "recentTreatment": <bool|null>, "photoOffered": <bool|null>}, "action": <"CONTINUE"|"HUMAN"|"CANCEL">, "reply": "<=2句語氣句>"}',
    "",
    "抽槽規則（嚴謹）：",
    "- 只填病人**今段對話有講**嘅欄；未講 → null（array 欄 → []），絕唔好猜。",
    "- toothLocation：位置原意（例：右後牙 / 左前牙 / 智慧齒 / 唔知邊隻）。",
    "- durationDays：數字（日）；「幾日」→ 按講嘅計；「一星期」→ 7；「幾時開始」講唔出 → null。",
    "- severity：病人**明確講數字**（1–10）先填；「好痛」「痛死」唔好揀數字（唔填）。",
    "- stimulusLinger：凍熱刺激痛完即收 → instant；持續幾分鐘 → lingering；冇提凍熱刺激 → null。",
    "- spontaneousPain（唔食嘢自己痛）/ nightPain（夜痛/痛醒）/ bitePain（咬嘢痛）/ swelling（面/頸/眼腫）/ recentTreatment（近兩星期治療）：病人明確講先填 true/false。",
    "- functionalImpact：由 [cant_eat, pain_talking, cant_sleep] 揀病人講咗嘅（食唔到嘢 / 講嘢痛 / 瞓唔到）。",
    "- redFlagSymptoms：病人提及嘅紅旗症狀原詞（流血 / 發燒 / 吞唔到嘢 / 呼吸困難 / 外傷 / 止唔到血…），冇 → []。",
    "- 病人提及紅旗症狀時照常抽槽 — 系統會自動升級急症，你唔使特別處理。",
    "",
    "action：",
    "- HUMAN：病人明確要求真人/人工；CANCEL：病人明確話唔使再問/唔痛咗/取消；其他 → CONTINUE。",
    "",
    "reply：一句短語氣句（例：「收到，再問你一件」），可以係空字串；唔好任何醫療建議 / 診斷。",
    "",
    "【紅旗詞表（只作抽槽認知 — 唔好據此判級，系統會確定性复查）】",
    redFlagList(i.redFlagTerms),
    // ★ E.8：lexicon 注入（session 抽槽 prompt）
    lexiconPromptBlock(i.lexicon),
  ].join("\n");
}

export function buildPainUserPrompt(i: PainPromptInput): string {
  const col = JSON.stringify(i.collected);
  const msgs = i.recentIn.map((m, idx) => `客戶訊息 ${idx + 1}: ${m}`).join("\n");
  return [
    `今日日期（香港）：${i.todayHk}`,
    `診所：${i.clinicName}`,
    `已收集資料：${col}`,
    "病人最近嘅訊息（舊 → 新）：",
    msgs,
    "",
    "請由上面病人訊息抽出**新講到**嘅痛症資料（已收集嘅欄唔使重複，除非病人更新咗）。",
  ].join("\n");
}

export const PAIN_JSON_SCHEMA = {
  type: "object",
  properties: {
    slotUpdates: {
      type: "object",
      properties: {
        toothLocation: { type: ["string", "null"] },
        durationDays: { type: ["number", "null"] },
        severity: { type: ["number", "null"], minimum: 1, maximum: 10 },
        stimulusLinger: { type: ["string", "null"], enum: ["instant", "lingering", "none", null] },
        spontaneousPain: { type: ["boolean", "null"] },
        nightPain: { type: ["boolean", "null"] },
        bitePain: { type: ["boolean", "null"] },
        swelling: { type: ["boolean", "null"] },
        functionalImpact: { type: "array", items: { enum: ["cant_eat", "pain_talking", "cant_sleep"] } },
        redFlagSymptoms: { type: "array", items: { type: "string" } },
        recentTreatment: { type: ["boolean", "null"] },
        photoOffered: { type: ["boolean", "null"] },
      },
      required: [
        "toothLocation", "durationDays", "severity", "stimulusLinger", "spontaneousPain",
        "nightPain", "bitePain", "swelling", "functionalImpact", "redFlagSymptoms",
        "recentTreatment", "photoOffered",
      ],
      additionalProperties: false,
    },
    action: { type: "string", enum: ["CONTINUE", "HUMAN", "CANCEL"] },
    reply: { type: "string", maxLength: 200 },
  },
  required: ["slotUpdates", "action", "reply"],
  additionalProperties: false,
} as const;
