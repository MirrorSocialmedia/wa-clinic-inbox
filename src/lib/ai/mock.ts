/**
 * Deterministic AI mock（`AI_MOCK=1`）— 無 GPU 時行 E2E / 本地開發（Phase 2 現實約束）。
 *
 * 同真 client 同一 interface（classifyAndDraft → ClassifyAndDraftResult）。
 * 規則決定性：按最新消息內容匹配固定分類/草稿 — 重跑結果一樣（冪等測試友好）。
 *
 * 規則（★ Part E cwi-paintriage-20260903 重定義：先紅旗、後投訴、後要求人工、後預約、後離題、後痛症、兜底 QUESTION）：
 * - 含 **FLOOR 紅旗詞**（red-flags.ts 同一份詞表 — 即擊直升，fast path 唔問診）→ URGENT_PAIN + HIGH + needsHuman=true
 *   → **永不生成 draft**（鐵律 3）。「牙痛」「好痛」等一般痛**唔再**命中（新語義：進 PAIN 問診）。
 * - 含「人工 / 真人 / human」（非急症）→ QUESTION + LOW + needsHuman=true + draft
 *   （Phase 2b T21：AUTO 模式下 needsHuman 永遠唔自動發，staff 人手審批）
 * - 含「預約 / 想約 / book / appointment / 改期…」→ BOOKING_REQUEST + LOW
 * - 含明顯離題（股票 / 天氣 / 足球…）→ OUT_OF_SCOPE + LOW
 * - 含痛症詞（牙痛 / 好痛 / 痛 / 唔舒服 / pain / hurt / ache）→ **PAIN** + MED + draft=null（進 PAIN_TRIAGE 問診；
 *   summary = canonical 化主訴（applyLexicon + code defaults — mock 零 DB IO），T101 lexicon 可觀察渠道）
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
import type { PainAiOutput, PainSlotsType } from "@/lib/sessions/pain-triage";
import type { PainPromptInput } from "./pain-prompts";
import { RED_FLAG_FLOOR } from "@/lib/sessions/red-flags";
import { applyLexicon } from "@/lib/sessions/lexicon";
import { LEXICON_DEFAULTS } from "@/lib/workflow/definitions";

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


const RE_URGENT = /痛|流血|出血|腫|外傷|感染|止唔到血|severe pain|pain|bleed|swollen|infection/i; // ★ 已棄用（Part E：只留埋避免引用）— URGENT 判定改用 FLOOR 詞表
// ★ Part E（cwi-paintriage-20260903，E.2）：URGENT_PAIN 重定義 = 訊息本身含紅旗詞（E.4 同一份 FLOOR 詞表）。
//   mock 零 DB IO — 用 code FLOOR（唔含 params 附加詞 / lexicon；e2e fixture 直接寫 FLOOR 詞）。
const FLOOR_TERMS: string[] = Object.values(RED_FLAG_FLOOR).flat().filter((t) => t.length > 0);
function hitFloorTerm(body: string): string | null {
  for (const t of FLOOR_TERMS) if (body.includes(t)) return t;
  return null;
}
// ★ Phase C（cwi-sess-20260824-c1）：COMPLAINT 觸發詞（投訴/退款/賠償/服務態度）
const RE_COMPLAINT = /投訴|退款|賠償|態度好差|太黑心/i;
// Phase 2b：病人明確要求真人（T21 mock trigger）— 急症先判，所以「牙痛，想搵人工」會命中 URGENT
const RE_NEEDS_HUMAN = /人工|真人|human agent|talk to a human/i;
const RE_BOOKING = /預約|想約|book|appointment|reschedul|改期|改約|取消預約|有冇位|冇位/i;
// ★ Part E（E.2）：一般痛（無紅旗詞）→ PAIN → 開 PAIN_TRIAGE 問診（mock 決定性痛症詞）
const RE_PAIN = /牙痛|牙好痛|牙咁痛|牙唔舒服|隻牙|痛|hurt|ache|pain/i;
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

/** 兜底 QUESTION 草稿 — 唔斷症、唔作價（鐵律）。
 * ★ Part F（cwi-raggolden-20260904）：e2e price-guard 靶（keyword token — 決定性，唔使重啟 worker）：
 * - `E2E-PRICE-LEAK`    → 模擬 LLM 幻覺一個價（無引用 → price-guard ① 必擋）
 * - `E2E-PRICE-NODISC` → in-range 價但漏 disclaimer（price-guard ② 必 append）— 題目要命中 PRICE 條目 keyword
 * - `E2E-PRICE-OUTRANGE` → out-range 價（price-guard ③ 必擋）— 同上
 * 注意：token 題目唔准含價錢意圖詞（幾錢/收費/價錢/貴唔貴/幾多錢）— 否則報價鏈決定性 draft 先食咗。 */
function questionDraft(input: ClassifyAndDraftInput): string {
  const body = lastInboundBody(input);
  if (body.includes("E2E-PRICE-LEAK")) {
    return "多謝你嘅查詢！照經驗嚟講大概 $999 左右，具體以到店為準。"; // 幻覺價（零 PRICE 引用）
  }
  if (body.includes("E2E-PRICE-NODISC")) {
    return "多謝你嘅查詢！洗牙嘅費用大約係 $600–1200，視乎牙石多寡。"; // in-range、漏 disclaimer
  }
  if (body.includes("E2E-PRICE-OUTRANGE")) {
    return "多謝你嘅查詢！洗牙嘅費用大約係 $5000，包埋全部檢查。"; // out-of-range
  }
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

  const floorHit = hitFloorTerm(body);
  if (floorHit !== null) {
    // ★ Part E（E.2）：即擊紅旗 — 訊息本身含 FLOOR 詞 → URGENT_PAIN（fast path 唔問診）。
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
  } else if (RE_PAIN.test(body)) {
    // ★ Part E（E.2）：一般痛（無紅旗詞）→ PAIN intent → worker 開 PAIN_TRIAGE 問診。
    // draft=null（問診問題由 session 出）；summary = canonical 化主訴（T101 lexicon 可觀察渠道；scrub 照行）。
    const canonical = applyLexicon(body, LEXICON_DEFAULTS.entries);
    result = {
      intent: "PAIN",
      urgency: "MED",
      needsHuman: false,
      confidence: 0.9,
      summary: `病人主訴：${canonical.slice(0, 30)}（mock）`,
      draft: null,
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

// ── ★ Part E（cwi-paintriage-20260903）：PAIN_TRIAGE 抽槽 mock（決定性關鍵字 — 同真 client 同 interface）──
// 只抽「病人今段講咗」嘅槽；否定式先判（「冇腫」→ false，唔係後嚟俾「腫」蓋成 true）。
// e2e fixture 用語與呢度 key 對齊（T97–T103）。

const RE_PAIN_LOC = /智慧齒|智齒|最後面|最後一隻|右後牙|左後牙|右前牙|左前牙|前牙|後牙|右邊|左邊/;
const RE_PAIN_DUR_DAYS = /(\d+)\s*[日天]/;
const RE_PAIN_SEV = /(\d+)\s*分/;
const RE_PAIN_STIM_INSTANT = /即收|一停就冇|痛完即收|停咗就冇/;
const RE_PAIN_STIM_LINGER = /持續|幾分鐘|收唔埋|好耐先冇/;
const RE_PAIN_SPON_POS = /自己痛|自發痛|冇食都痛|唔使食都痛/;
const RE_PAIN_SPON_NEG = /唔會自己痛|冇自發痛|自發冇/;
const RE_PAIN_NIGHT_POS = /夜痛|痛醒|瞓覺痛|夜嘢痛|入夜痛/;
const RE_PAIN_NIGHT_NEG = /夜晚冇|夜間冇|夜間唔痛/;
const RE_PAIN_BITE_POS = /咬嘢痛|咬落痛|咬實痛|咬嘢就痛/;
const RE_PAIN_BITE_NEG = /咬唔痛|咬落唔痛|咬嘢唔痛/;
const RE_PAIN_SWEL_POS = /腫/;
const RE_PAIN_SWEL_NEG = /無腫|冇腫|唔腫|未腫/;
const RE_PAIN_IMP_EAT = /食唔到|食唔落|食嘢痛/;
const RE_PAIN_IMP_TALK = /講嘢痛|開口講嘢痛/;
const RE_PAIN_IMP_SLEEP = /瞓唔到|瞓唔實|瞓唔瞓到/;
const RE_PAIN_TREAT_POS = /做咗杜牙根|杜咗牙根|做咗補牙|補咗牙|拔咗牙|做咗治療/;
const RE_PAIN_TREAT_NEG = /冇做過|未做過|冇治療|近兩星期冇/;
const RE_PAIN_HUMAN = /人工|真人|human agent|talk to a human/i;
const RE_PAIN_CANCEL = /唔使再問|唔痛咗|冇事啦|算啦|取消/;

function lastInboundBodyPain(input: PainPromptInput): string {
  for (let i = input.recentIn.length - 1; i >= 0; i--) {
    if (input.recentIn[i].trim()) return input.recentIn[i];
  }
  return "";
}

/** ★ Part E（cwi-paintriage-20260903）：PAIN_TRIAGE 抽槽決定性 mock。 */
export async function mockPainTurn(input: PainPromptInput): Promise<PainAiOutput> {
  if (isAiMockFailEnabled()) {
    await sleep(MOCK_LATENCY_MS);
    throw new AiCallError("AI_MOCK_FAIL=1 — simulated AI outage");
  }
  await sleep(MOCK_LATENCY_MS);

  const body = lastInboundBodyPain(input);
  const upd: Partial<PainSlotsType> = {};

  const loc = body.match(RE_PAIN_LOC);
  if (loc) upd.toothLocation = loc[0];
  const dur = body.match(RE_PAIN_DUR_DAYS);
  if (dur) upd.durationDays = parseInt(dur[1], 10);
  else if (/一星期/.test(body)) upd.durationDays = 7;
  else if (/兩星期|兩個星期/.test(body)) upd.durationDays = 14;
  const sev = body.match(RE_PAIN_SEV);
  if (sev) {
    const n = parseInt(sev[1], 10);
    if (n >= 1 && n <= 10) upd.severity = n;
  }
  if (RE_PAIN_STIM_INSTANT.test(body)) upd.stimulusLinger = "instant";
  else if (RE_PAIN_STIM_LINGER.test(body)) upd.stimulusLinger = "lingering";
  if (RE_PAIN_SPON_NEG.test(body)) upd.spontaneousPain = false;
  else if (RE_PAIN_SPON_POS.test(body)) upd.spontaneousPain = true;
  if (RE_PAIN_NIGHT_NEG.test(body)) upd.nightPain = false;
  else if (RE_PAIN_NIGHT_POS.test(body)) upd.nightPain = true;
  if (RE_PAIN_BITE_NEG.test(body)) upd.bitePain = false;
  else if (RE_PAIN_BITE_POS.test(body)) upd.bitePain = true;
  if (RE_PAIN_SWEL_NEG.test(body)) upd.swelling = false;
  else if (RE_PAIN_SWEL_POS.test(body)) upd.swelling = true;
  const impacts: PainSlotsType["functionalImpact"] = [];
  if (RE_PAIN_IMP_EAT.test(body)) impacts.push("cant_eat");
  if (RE_PAIN_IMP_TALK.test(body)) impacts.push("pain_talking");
  if (RE_PAIN_IMP_SLEEP.test(body)) impacts.push("cant_sleep");
  if (impacts.length > 0) upd.functionalImpact = impacts;
  const rf: string[] = [];
  for (const t of ["止唔到血", "流血", "發燒", "發緊燒", "吞唔到", "呼吸唔順", "呼吸困難", "外傷", "撞"]) {
    if (body.includes(t) && !rf.includes(t)) rf.push(t);
  }
  if (rf.length > 0) upd.redFlagSymptoms = rf;
  if (RE_PAIN_TREAT_NEG.test(body)) upd.recentTreatment = false;
  else if (RE_PAIN_TREAT_POS.test(body)) upd.recentTreatment = true;

  let action: PainAiOutput["action"] = "CONTINUE";
  if (RE_PAIN_HUMAN.test(body)) action = "HUMAN";
  else if (RE_PAIN_CANCEL.test(body)) action = "CANCEL";

  const hasUpdate = Object.keys(upd).length > 0;
  return { slotUpdates: upd, action, reply: hasUpdate ? "收到！" : "明白～" };
}
