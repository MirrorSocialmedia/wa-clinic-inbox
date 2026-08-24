/**
 * ★ AI Workflow Phase C（cwi-sess-20260824-c1）：slot-filling session 用 prompt。
 *
 * 事實鐵律：時段/日期/醫生名事實句永遠 engine 砌；LLM 只出語氣句（≤2 句）。
 * PII：user prompt 只送最近對話 + 已收集 business metadata，唔送病人姓名/電話。
 */
import type { SessionSlots } from "./session-types";
import { SESSION_ACTIONS } from "./session-types";

export function buildSessionSystemPrompt(): string {
  return [
    "你係香港牙科診所 WhatsApp 預約助手嘅分析引擎。病人喺同你哋傾緊預約。",
    "你嘅唯一工作：由病人最新訊息抽出預約資料更新 + 判斷佢想點 + 寫一句自然語氣句。",
    "你唔負責講事實（邊個時段有位、確認內容）— 系統會另外加上，你唔好講。",
    "",
    "輸出：只可以返一個 JSON object，格式：",
    '{"slotUpdates":{"providerName":<string|null>,"date":<"YYYY-MM-DD"|null>,"time":<"HH:mm"|null>,"timeOfDay":<"MORNING"|"AFTERNOON"|"EVENING"|null>},"action":<6選1>,"reply":<string>}',
    "",
    "slotUpdates 規則：",
    "- 只填今條訊息**新講**嘅嘢；冇提到嘅一律 null（唔好重覆已收集資料）。",
    "- 相對日期（聽日/下星期三/大後日）→ 用「今日日期」換算成 YYYY-MM-DD。",
    "- 「下晝三點」→ time=15:00；「朝早」冇具體鐘數 → timeOfDay=MORNING，time=null。",
    "- 醫生名要對「本店醫生名單」— 病人講嘅名近似邊個就填邊個嘅全名；對唔到 → null。",
    "",
    "action 六選一：",
    "- CONTINUE：仲喺預約流程入面（提供緊資料 / 揀緊時間 / 問緊選項）",
    "- CONFIRM：病人對「待確認嘅預約內容」明確話啱（好呀 / 冇問題 / ok / 就咁）",
    "- CANCEL：病人唔想預約住（唔約住 / 遲啲先 / 算啦）",
    "- OFF_TOPIC：講咗預約以外嘅嘢（問價錢 / 問地址 / 閒聊）— reply 照答唔到嘅就話會有職員跟進",
    "- HUMAN：病人要求真人，或者投訴、不滿",
    "- URGENT：劇痛 / 流血不止 / 面腫 / 外傷等緊急情況（最高優先，見到就用）",
    "",
    "reply 規則：",
    "- 禮貌廣東話書面混合，最多 2 句，只做語氣承接（例：「收到！」「明白～」）。",
    "- 鐵律：唔准講任何時段有冇位、唔准覆述預約內容、唔准俾醫療建議、唔准作價錢。",
    "- 呢句會直接發俾病人，要完整可發出。",
  ].join("\n");
}

export interface SessionPromptInput {
  todayHk: string; // YYYY-MM-DD
  clinicName: string;
  providers: { apricotId: string; name: string }[]; // ProviderClinic 本店名單
  collected: SessionSlots; // 已收集（engine 驗證過嘅）
  pendingConfirm: string | null; // CONFIRMING 態先有：engine 砌嘅確認句
  candidateText: string | null; // engine 砌嘅候選時段文字（上輪出咗嘅）
  recentMessages: { direction: "IN" | "OUT"; body: string }[]; // 最近 6 條
}

export function buildSessionUserPrompt(i: SessionPromptInput): string {
  const prov = i.providers.map((p) => p.name).join("、");
  const col = JSON.stringify(i.collected);
  return [
    `今日日期（香港）：${i.todayHk}`,
    `診所：${i.clinicName}`,
    `本店醫生名單：${prov || "（未設定）"}`,
    `已收集資料：${col}`,
    i.pendingConfirm ? `待確認嘅預約內容：${i.pendingConfirm}` : "",
    i.candidateText ? `頭先俾過病人嘅時段選項：\n${i.candidateText}` : "",
    "",
    "最近對話（舊→新，[in]=病人）：",
    ...i.recentMessages.map((m) => `[${m.direction === "IN" ? "in" : "out"}] ${m.body}`),
    "",
    "請按格式輸出 JSON。",
  ].filter(Boolean).join("\n");
}

export const SESSION_JSON_SCHEMA = {
  type: "object",
  properties: {
    slotUpdates: {
      type: "object",
      properties: {
        providerName: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
        time: { type: ["string", "null"] },
        timeOfDay: { type: ["string", "null"], enum: ["MORNING", "AFTERNOON", "EVENING", null] },
      },
      required: ["providerName", "date", "time", "timeOfDay"],
      additionalProperties: false,
    },
    action: { type: "string", enum: [...SESSION_ACTIONS] },
    reply: { type: "string", maxLength: 200 },
  },
  required: ["slotUpdates", "action", "reply"],
  additionalProperties: false,
} as const;
