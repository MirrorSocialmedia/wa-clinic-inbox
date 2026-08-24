/**
 * Deterministic AI mock（`AI_MOCK=1`）— 無 GPU 時行 E2E / 本地開發（Phase 2 現實約束）。
 *
 * 同真 client 同一 interface（classifyAndDraft → ClassifyAndDraftResult）。
 * 規則決定性：按最新消息內容匹配固定分類/草稿 — 重跑結果一樣（冪等測試友好）。
 *
 * 規則（先急症、後要求人工、後預約、後離題、兜底 QUESTION）：
 * - 含「痛 / 流血 / 腫 / pain / bleed / swollen…」→ URGENT_PAIN + HIGH + needsHuman=true
 *   → **永不生成 draft**（鐵律 3）
 * - 含「人工 / 真人 / human」（非急症）→ QUESTION + LOW + needsHuman=true + draft
 *   （Phase 2b T21：AUTO 模式下 needsHuman 永遠唔自動發，staff 人手審批）
 * - 含「預約 / 想約 / book / appointment / 改期…」→ BOOKING_REQUEST + LOW
 * - 含明顯離題（股票 / 天氣 / 足球…）→ OUT_OF_SCOPE + LOW
 * - 其餘 → QUESTION + LOW（= 任務規格嘅「其餘 GENERAL」歸入 QUESTION）
 *
 * `AI_MOCK_FAIL=1` → 模擬 AI 斷線（call throw）— 測降級路徑（E2E T16）。
 *
 * ★ mock summary/draft 係固定模板（可含診所名）— 定死、無病人原文。
 */
import type {
  AiClinicInfo,
  ClassifyAndDraftInput,
  ClassifyAndDraftResult,
} from "./types";
import { AiCallError } from "./types";
import type { SessionAiOutput, SessionSlots } from "./session-types";
import type { SessionPromptInput } from "./session-prompts";

export function isAiMockEnabled(): boolean {
  return process.env.AI_MOCK === "1";
}

export function isAiMockFailEnabled(): boolean {
  return process.env.AI_MOCK_FAIL === "1";
}

export const MOCK_MODEL_NAME = "mock-qwen-v1";

/**
 * ★ E2E bait（H-3 scrub 驗證）：mock summary 固定含呢個 token — e2e 會建一個
 *   profileName 同 token 相同嘅 contact，驗證 deterministic scrub 一定將佢撳走
 *   （DB aiSummary 0 hit）。token 係獨特 ASCII，唔會撞其他病人。
 */
export const E2E_BAIT_SUM_TOKEN = "E2E-BAIT-SUM-7f3a";


const RE_URGENT = /痛|流血|出血|腫|外傷|感染|止唔到血|severe pain|pain|bleed|swollen|infection/i;
// ★ Phase C（cwi-sess-20260824-c1）：COMPLAINT 觸發詞（投訴/退款/賠償/服務態度）
const RE_COMPLAINT = /投訴|退款|賠償|態度好差|太黑心/i;
// Phase 2b：病人明確要求真人（T21 mock trigger）— 急症先判，所以「牙痛，想搵人工」會命中 URGENT
const RE_NEEDS_HUMAN = /人工|真人|human agent|talk to a human/i;
const RE_BOOKING = /預約|想約|book|appointment|reschedul|改期|改約|取消預約|有冇位|冇位/i;
const RE_OUT_OF_SCOPE = /股票|期貨|基金|crypto|加密貨幣|足球|天氣|weather|代寫|寫文/i;

/** 模擬網絡 + 推理延遲（短，E2E 唔使等） */
const MOCK_LATENCY_MS = 15;

function lastInboundBody(input: ClassifyAndDraftInput): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i].direction === "IN") {
      return input.messages[i].body ?? "";
    }
  }
  return "";
}

function clinicName(input: ClassifyAndDraftInput): string {
  return input.clinic.name || "診所";
}

/** BOOKING_REQUEST 草稿 — 只係建議，staff 一鍵採用先入 composer。 */
function bookingDraft(input: ClassifyAndDraftInput): string {
  const gc = input.clinic.greetingConfig ?? {};
  const hours = typeof gc.openingHours === "string" ? gc.openingHours : "";
  const hoursLine = hours ? `我哋嘅營業時間係：${hours}。` : "";
  return (
    `多謝你嘅查詢！${clinicName(input)}收到你嘅預約請求。` +
    `${hoursLine}` +
    `我哋會盡快安排醫生跟你確認適合嘅時間，有專人即刻回覆你。`
  );
}

/** OUT_OF_SCOPE 草稿。 */
function outOfScopeDraft(input: ClassifyAndDraftInput): string {
  return `多謝你嘅訊息！呢個問題超出了 ${clinicName(input)} 嘅服務範圍，如有牙科相關查詢歡迎隨時問我哋。`;
}

/** 兜底 QUESTION 草稿 — 唔斷症、唔作價（鐵律）。 */
function questionDraft(input: ClassifyAndDraftInput): string {
  return (
    `多謝你嘅查詢！${clinicName(input)}收到你嘅訊息，會盡快回覆你。` +
    `如有急事（例如劇痛、流血），請即刻致電診所或盡快到訪俾醫生檢查。`
  );
}

/** needsHuman 草稿（Phase 2b）— 可以出 draft，但系統永遠唔會自動發。 */
function needsHumanDraft(input: ClassifyAndDraftInput): string {
  return `收到！${clinicName(input)}會安排專人盡快同你聯絡，請稍候。如有急事請即刻致電診所。`;
}

export async function mockClassifyAndDraft(
  input: ClassifyAndDraftInput
): Promise<ClassifyAndDraftResult> {
  const t0 = Date.now();
  if (isAiMockFailEnabled()) {
    // 模擬 AI 斷線（GPU 機離線 / vLLM crash）— 唔含任何訊息內容
    await sleep(MOCK_LATENCY_MS);
    throw new AiCallError("AI_MOCK_FAIL=1 — simulated AI outage");
  }
  await sleep(MOCK_LATENCY_MS);

  const body = lastInboundBody(input);
  let result: Omit<ClassifyAndDraftResult, "model" | "latencyMs" | "tokens">;

  if (RE_URGENT.test(body)) {
    // 鐵律 3：URGENT_PAIN 永不生成 draft
    result = {
      intent: "URGENT_PAIN",
      urgency: "HIGH",
      needsHuman: true,
      confidence: 0.99,
      summary: "病人主訴劇痛/出血等急性不適（mock）",
      draft: null,
    };
  } else if (RE_COMPLAINT.test(body)) {
    // ★ Phase C（cwi-sess-20260824-c1）：COMPLAINT — 優先喺 NEEDS_HUMAN 之前（更具體）；
    //   draft=null（投訴唔出 AI 草稿；worker canDraft 對 COMPLAINT 一律唔建 draft）。
    result = {
      intent: "COMPLAINT",
      urgency: "LOW",
      needsHuman: true,
      confidence: 0.95,
      summary: "病人投訴 / 對服務不滿（mock）",
      draft: null,
    };
  } else if (RE_NEEDS_HUMAN.test(body)) {
    // Phase 2b：明确要求人工 — 出 pending draft（staff 審批），AUTO 模式亦唔會自動發
    result = {
      intent: "QUESTION",
      urgency: "LOW",
      needsHuman: true,
      confidence: 0.9,
      summary: "病人要求真人處理（mock）",
      draft: needsHumanDraft(input),
    };
  } else if (RE_BOOKING.test(body)) {
    result = {
      intent: "BOOKING_REQUEST",
      urgency: "LOW",
      needsHuman: false,
      confidence: 0.95,
      summary: "病人想預約/改期（mock）",
      draft: bookingDraft(input),
    };
  } else if (RE_OUT_OF_SCOPE.test(body)) {
    result = {
      intent: "OUT_OF_SCOPE",
      urgency: "LOW",
      needsHuman: false,
      confidence: 0.9,
      summary: "查詢超出診所服務範圍（mock）",
      draft: outOfScopeDraft(input),
    };
  } else {
    result = {
      intent: "QUESTION",
      urgency: "LOW",
      needsHuman: false,
      confidence: 0.6,
      summary: "一般查詢（mock）",
      draft: questionDraft(input),
    };
  }

  return {
    ...result,
    // summary 鐵律 ≤50 字（mock 模板已短，defense in depth）
    // ★ E2E bait：附固定 token — H-3 scrub 測試靶（同 E2E_BAIT_SUM_TOKEN 同名嘅 contact 會俾撳走）
    summary: `${result.summary.slice(0, 30)} ${E2E_BAIT_SUM_TOKEN}`.slice(0, 50),
    model: MOCK_MODEL_NAME,
    latencyMs: Date.now() - t0,
    tokens: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Phase C（cwi-sess-20260824-c1）：slot-filling session mock（C3.4 決定性關鍵字）──────
// 優先序：URGENT > HUMAN > CANCEL > slot 更新（CONTINUE）> CONFIRM > CONTINUE。
// 只返 roster 全名（engine mergeSlots 會 deterministic 對返 apricotId）。

const RE_SESS_URGENT = /好痛|劇痛|忍唔到|流血|出血|腫|外傷|severe pain|pain|bleed/i;
const RE_SESS_HUMAN = /人工|真人|human agent|talk to a human/i;
const RE_SESS_CANCEL = /唔約|唔使約|算啦|遲啲先|取消預約/;
const RE_SESS_CONFIRM = /^(好呀|好啊|得呀|冇問題|冇問題呀|ok|okay|就咁|好|可以)/i;
const RE_TIME_1500 = /三點|\b3點|15:00|3pm|下午三點/i; // MD C3.4：三點/3點/15:00（\b 防 23點 誤中）

function lastInboundBodySession(input: SessionPromptInput): string {
  for (let i = input.recentMessages.length - 1; i >= 0; i--) {
    if (input.recentMessages[i].direction === "IN") return input.recentMessages[i].body;
  }
  return "";
}

/** 病人講嘅醫生名 → roster 全名（決定性：全名包含 / 姓+醫生；多過一個候選 = 唔確定 → null） */
function mockMatchProvider(body: string, providers: { apricotId: string; name: string }[]): string | null {
  const stripParen = (s: string) => s.replace(/[（(][^）)]*[）)]/g, "");
  const cands: string[] = [];
  for (const p of providers) {
    const base = stripParen(p.name).replace(/\s+/g, "");
    if (!base) continue;
    const surname = base.slice(0, 1);
    if (body.includes(base) || body.includes(`${surname}醫生`)) cands.push(p.name);
  }
  return cands.length === 1 ? cands[0] : null;
}

export async function mockSessionTurn(input: SessionPromptInput): Promise<SessionAiOutput> {
  if (isAiMockFailEnabled()) {
    await sleep(MOCK_LATENCY_MS);
    throw new AiCallError("AI_MOCK_FAIL=1 — simulated AI outage");
  }
  await sleep(MOCK_LATENCY_MS);

  const body = lastInboundBodySession(input);
  const none: SessionSlots = { providerName: null, date: null, time: null, timeOfDay: null };

  if (RE_SESS_URGENT.test(body))
    return { slotUpdates: none, action: "URGENT", reply: "聽到你講緊嘅事，我即刻叫職員跟進 🙏" };
  if (RE_SESS_HUMAN.test(body)) return { slotUpdates: none, action: "HUMAN", reply: "收到，我哋職員好快覆你" };
  if (RE_SESS_CANCEL.test(body)) return { slotUpdates: none, action: "CANCEL", reply: "明白～" };

  const upd: SessionSlots = { ...none };
  // 相對日期（用 input.todayHk 換算 — 同 engine 嘅 todayHk 同源）
  const addDays = (base: string, n: number): string => {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  if (/大後日/.test(body)) upd.date = addDays(input.todayHk, 3);
  else if (/後日/.test(body)) upd.date = addDays(input.todayHk, 2);
  else if (/聽日/.test(body)) upd.date = addDays(input.todayHk, 1);
  if (RE_TIME_1500.test(body)) upd.time = "15:00";
  else if (/朝早/.test(body)) upd.timeOfDay = "MORNING";
  else if (/下晝/.test(body)) upd.timeOfDay = "AFTERNOON";
  else if (/晚/.test(body)) upd.timeOfDay = "EVENING";
  const prov = mockMatchProvider(body, input.providers);
  if (prov) upd.providerName = prov;

  const hasUpdate = upd.providerName !== null || upd.date !== null || upd.time !== null || upd.timeOfDay !== null;
  if (hasUpdate) return { slotUpdates: upd, action: "CONTINUE", reply: "收到！" };
  if (RE_SESS_CONFIRM.test(body)) return { slotUpdates: none, action: "CONFIRM", reply: "好呀" };
  return { slotUpdates: none, action: "CONTINUE", reply: "明白～" };
}
