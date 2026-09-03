/**
 * AI prompt 設計（框架 MD §7.2/§7.3 + Phase 2 任務規格）。
 *
 * 設計決策：
 * - 單次 call 返「分類 + 草稿」一份 JSON（MD 原本係分两次 call：§7.2 分類 + §7.3 草稿；
 *   Phase 2 任務要求統一入口 classifyAndDraft，合併做 1 次 call 慳一半延遲 —
 *   結構化輸出（guided_json + response_format）+ parse 端驗證確保結構合法）。
 * - prompt 用繁中寫（病人訊息係廣東話/書面語/英文夾雜，MD §7.2 結論）。
 * - 輸入 = 診所基本資料（greetingConfig）+ 最近 N 條對話（in/out 都要，改期/取消要上文）。
 * - 摘要語言跟病人；草稿口吻跟診所前台（禮貌廣東話書面混合）。
 * - Phase 2b（AUTO 模式）：部分診所會設 AUTO（AI 草稿可自動發出）— prompt 要明確：
 *   (a) URGENT_PAIN/HIGH 嘅草稿必須為 null（code 亦雙重擋，永不自動發）；
 *   (b) needsHuman=true 可以出草稿但系統永遠唔會自動發（staff 人手審批）；
 *   (c) 其他草稿可能直接送達病人 — 必須完整、可直接發出、唔好「內部備註」口吻。
 *
 * ★ PII 鐵律：
 * - prompt 含訊息原文係必要嘅（AI 要讀先分類得）— 但 AI 100% 本地 vLLM（D4）。
 * - prompt 本身永不入 log。log 只准 intent/urgency/latency/model/tokens metadata。
 */
import type { AiClinicInfo, AiContextMessage, AiDutyRoster, ClassifyAndDraftInput } from "./types";
import { AI_INTENTS, AI_URGENCIES } from "./types";

/** 餵入 prompt 嘅最近對話條數（MD §7.3：近 10 條） */
export const PROMPT_CONTEXT_MESSAGES = 10;

export function buildSystemPrompt(lexiconBlock = ""): string {
  return [
    "你係香港診所嘅 WhatsApp 客服分析助手。你只做分析，唔會直接回覆病人。",
    "輸入係：診所基本資料 + 最近幾條 WhatsApp 對話（[in]=病人、[out]=診所）。",
    "病人訊息會廣東話、書面語、英文夾雜，要全部識得讀。",
    "",
    "輸出：只可以返一個 JSON object，唔准任何多余文字 / markdown / 代碼欄，格式：",
    '{"intent": <7選1>, "urgency": <3選1>, "needsHuman": <bool>, "confidence": <0-1>, "summary": "<=50字>, "draft": <string|null>}',
    "",
    "intent 七選一：",
    "- BOOKING_REQUEST：想預約 / 改期 / 取消預約 / 問有冇位",
    "- QUESTION：一般查詢（時間 / 地址 / 收費 / 流程 / 唔明嘅求診問題）",
    "- URGENT_PAIN：**只有訊息本身含紅旗特徵先係**（流血止唔到 / 面腫 / 發燒 / 吞唔到嘢或呼吸困難 / 外傷甩牙 / 痛到瞓唔著或痛到忍唔到）— 即擊直升，唔使問診",
    "- PAIN：牙痛 / 口腔痛 / 唔舒服，**但無紅旗特徵**（「牙痛」「好痛」「隻牙唔舒服」）— 系統會轉入痛症問診流程收集資料，唔急緊",
    "- OUT_OF_SCOPE：同診所完全無關嘅事情（代寫文章、股票、天氣查詢等）",
    "- COMPLAINT：投訴 / 對服務不滿 / 要求退款賠償（needsHuman 必須 true）",
    "- OTHER：唔肯定歸邊類就用呢個，唔好估",
    "",
    "★ PAIN vs URGENT_PAIN 分界（重要）：一般牙痛唔係緊急 — 病人痛緊唔代表紅旗；只有上面列明嘅紅旗特徵先係 URGENT_PAIN。唔肯定有無紅旗就分 PAIN（問診流程會確定性复查），唔好猜 URGENT_PAIN。",
    "",
    "urgency 三選一：",
    "- HIGH：劇痛、流血、腫脹、疑似感染、外傷（同 URGENT_PAIN 基本重疊）",
    "- MED：有明顯唔舒服但未緊急（例如輕微痛楚持續幾日）",
    "- LOW：其他",
    "",
    "needsHuman：只有以下情況先 true：",
    "(1) URGENT_PAIN 或任何需要真人判斷嘅醫療情況（必須 true）；",
    "(2) 病人明確要求真人/人工處理（例如「想搵人工」）；",
    "(3) intent=COMPLAINT（必須 true）。",
    "其他一律 false：預約 / 改期 / 一般資料查詢 / 多謝 / 道別 都係 false。",
    "",
    "summary：一句摘要（≤50 字），語言要同病人最後嗰幾則訊息一致（繁中 / 英文 / 廣東話）。",
    "★ 去識別化（絕對鐵律）：summary 唔准出現病人姓名、電話號碼、身份證號等任何可識別資料 — 一律用「病人」指代；可以提及症狀類別同請求意向，但唔好抄病人原文完整句。（code 層另有一重 deterministic scrub 兜底，你寫唔寫都得）",
    "",
    "draft（建議覆 reply；若診所係 AUTO 模式且非緊急，呢段會直接自動發畀病人）：",
    "- intent=URGENT_PAIN 或 urgency=HIGH 時必須為 null（緊急鐵律：永不出草稿，更唔會自動發）",
    "- needsHuman=true 時可以出草稿（staff 會人手審批，系統永遠唔會自動發）；也可以為 null",
    "- 只可以用「診所基本資料」入面有提供嘅事實（地址 / 營業時間 / 醫生 / FAQ / 今日當值）。",
    "- 病人問「今日邊個喺度 / 邊個姑娘當值 / 邊個醫生今日有冇時間（只限當值層面）」→ 可以照「今日當值員工」列表答名同更時；唔好答列表之外嘅人。",
    "- 鐵律：唔准提供任何醫療建議、診斷、用藥建議；病人問痛楚 / 症狀一律寫「建議盡快返嚟俾醫生檢查」級別嘅回應，唔准開藥、唔准斷症。",
    "- 唔知就話唔知，唔准作價錢（收費問題一律說「具體費用請到店同前台確認」）。",
    "- 語氣：禮貌廣東話書面混合，跟診所前台口吻；簡短（2-4 句）；必須係可以直接發畀病人嘅完整回覆。",
    "- ★ 單訊息鐵律（cwi-window-20260901 / W-3：10 月起每條 outbound 收費）：一次回覆只出一條訊息 — 需要列點就用同一條訊息內嘅換行，唔准拆成多條發。",
    "- 病人多謝 / 打招呼 / 道別（例如「多謝」「唔該」「拜拜」「收到」）→ 回一句簡短溫暖嘅致意（例如「唔緊要，祝你早日康復！」），唔好 null。",
    "- 其他情況可以為 null（真正唔需要覆 reply 時，例如病人只係確認收到、無新問題）。",
    // ★ Part E（cwi-paintriage-20260903）：lexicon 注入（MD E.8：classify system prompt 尾）
    ...lexiconBlock.split("\n").filter((l) => l.length > 0),
  ].join("\n");
}

/** 診所基本資料區塊（greetingConfig 結構寬容：key 唔齊就跳）。 */
function clinicBlock(clinic: AiClinicInfo): string {
  const gc = clinic.greetingConfig ?? {};
  const lines: string[] = [`診所名稱：${clinic.name}`];
  const push = (label: string, key: string) => {
    const v = gc[key];
    if (typeof v === "string" && v.trim()) lines.push(`${label}：${v.trim()}`);
    else if (Array.isArray(v) && v.length > 0) lines.push(`${label}：${v.map((x) => String(x)).join("、")}`);
  };
  push("地址", "address");
  push("營業時間", "openingHours");
  push("醫生名單", "doctors");
  const faq = gc["faq"];
  if (Array.isArray(faq) && faq.length > 0) {
    const items = faq
      .map((f) => {
        if (f && typeof f === "object" && "q" in f && "a" in f) {
          return `Q: ${String((f as { q: unknown }).q)} A: ${String((f as { a: unknown }).a)}`;
        }
        return null;
      })
      .filter(Boolean);
    if (items.length > 0) lines.push(`常見問題：\n${items.join("\n")}`);
  }
  return lines.join("\n");
}

export function msgLine(m: AiContextMessage): string {
  // ★ Fix A：INTERNAL（type=note）零內容出 prompt — 就算 caller 漏 filter 都只出占位
  if (m.channel === "INTERNAL" || m.type === "note") return `[internal-note]`;
  const ts = m.waTimestamp.toISOString().slice(0, 16).replace("T", " ");
  const who = m.direction === "IN" ? "in" : "out";
  const body =
    m.type === "text"
      ? (m.body ?? "")
      : `[${m.type}${m.body ? ` ${m.body}` : ""}]`;
  return `[${who}] ${ts} ${body}`.trimEnd();
}

function dutyBlock(duty: AiDutyRoster | null | undefined): string {
  if (!duty || duty.entries.length === 0) return "";
  const lines = duty.entries
    .map((e) => `${e.staffName}（${e.role}，${e.shiftStart}-${e.shiftEnd}）`)
    .join("、");
  return `今日（${duty.date}）當值員工：${lines}`;
}

export function buildUserPrompt(input: ClassifyAndDraftInput): string {
  const msgs = input.messages.slice(-PROMPT_CONTEXT_MESSAGES);
  const duty = dutyBlock(input.dutyRoster);
  return [
    clinicBlock(input.clinic),
    duty ? `\n${duty}` : "",
    "",
    "最近對話（由舊到新）：",
    ...msgs.map(msgLine),
    "",
    "請按格式輸出 JSON。",
  ].join("\n");
}

/**
 * vLLM guided_json schema（保證輸出合法 JSON + enum 範圍）。
 * vLLM 拓展欄位 `guided_json`（後端用 guidance/xgrammar 強制結構）。
 */
export const CLASSIFY_DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...AI_INTENTS] },
    urgency: { type: "string", enum: [...AI_URGENCIES] },
    needsHuman: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string", maxLength: 50 },
    draft: { type: ["string", "null"] },
  },
  required: ["intent", "urgency", "needsHuman", "confidence", "summary"],
  additionalProperties: false,
} as const;
