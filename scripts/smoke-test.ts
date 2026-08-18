/* Phase 0-C smoke test — log redact + webhook HMAC 驗簽 + AI mock（純邏輯，唔使 DB/Redis）
 *
 * 覆蓋（2026-08-18 自審後擴充）：
 * 1. redactDeep — 任意深度（3 層嵌套 + 陣列）+ 邊界案例（空串 / undefined / 非字串值 / circular）
 *    + 全部 sensitive keys（body/text/draftText/message/caption/content/title/response_json/summary/draft）
 * 2. pino redact paths — top-level / 1-2 層 nested / WA payload shape（頂層 + wrapper key）
 * 3. HMAC 驗簽 — 正確 / 錯簽 / 空 / 短簽（唔 throw）/ 錯 secret / multi-algo header / 無 secret
 * 4. AI mock determinism + 鐵律（Phase 2）— 急症無 draft / 預約有 draft / deterministic / AI_MOCK_FAIL throw
 */
import assert from "node:assert";
import { redactDeep, createLogger } from "../src/lib/log";
import { verifyWaSignature } from "../src/lib/wa-signature";
import { mockClassifyAndDraft, isAiMockFailEnabled } from "../src/lib/ai/mock";
import type { ClassifyAndDraftInput } from "../src/lib/ai/types";
import { AiCallError } from "../src/lib/ai/types";
import { createHmac } from "node:crypto";

// ===================== 1. redactDeep =====================

const SECRET = {
  body: "我想預約下週三陳醫生",
  caption: "CAPTION-SECRET-A",
  content: "CONTENT-SECRET-B",
  title: "TITLE-SECRET-C",
  nfm: "NFM-RESPONSE-SECRET-D",
  nested: "NESTED-INSIDE-SENSITIVE-E",
};

/** 3 層嵌套 + 陣列 + 邊界案例 */
const circularObj: Record<string, unknown> = {};
circularObj.self = circularObj; // 邊界：circular reference（唔好死）
const sample = {
  wamid: "wamid.HBgL",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "12345" },
            messages: [
              {
                id: "wamid.ABC",
                from: "85212345678",
                text: { body: SECRET.body },
                image: { id: "img1", caption: SECRET.caption },
                interactive: {
                  type: "nfm_reply",
                  nfm_reply: { message_id: "wamid.X", response_json: SECRET.nfm },
                },
              },
              // 邊界：空串
              { id: "wamid.B2", text: { body: "" } },
            ],
          },
        },
      ],
    },
  ],
  draftText: "你好，歡迎光臨",
  message: "hello secret",
  text: "plain text",
  // 頂層新 keys
  content: SECRET.content,
  title: SECRET.title,
  response_json: "TOP-LEVEL-NFM-SECRET-F",
  responseJson: "TOP-LEVEL-NFM-CAMEL-SECRET-G",
  // 邊界：undefined（非 sensitive key，原樣保留）+ sensitive key 配非字串值 → [REDACTED]
  undefinedField: undefined,
  body: 12345, // number
  caption: true, // boolean
  boundary: {
    title: null, // null
    message: { nested: SECRET.nested }, // object（內層文字要一齊 mask）
    text: ["LINE-1-SECRET-H", "LINE-2-SECRET-I"], // array
  },
  // 邊界：sensitive key 直接係空串 → [REDACTED len=0]
  emptyBoundary: { text: "" },
  // 非敏感 metadata 要保留
  waId: "85222222222",
  status: "delivered",
  count: 3,
  deep: circularObj,
};

const redacted = redactDeep(sample);
const redactedStr = JSON.stringify(redacted, (k, v) =>
  v === undefined ? "[undef]" : v
);

// 所有 secret 必須消失
assert(!redactedStr.includes("預約"), "body 原文漏咗");
assert(!redactedStr.includes("陳醫生"), "body 原文漏咗");
assert(!redactedStr.includes("歡迎光臨"), "draftText 漏咗");
assert(!redactedStr.includes("hello secret"), "message 漏咗");
assert(!redactedStr.includes("plain text"), "text 漏咗");
assert(!redactedStr.includes(SECRET.caption), "caption 漏咗");
assert(!redactedStr.includes(SECRET.content), "content 漏咗");
assert(!redactedStr.includes(SECRET.title), "title 漏咗");
assert(!redactedStr.includes(SECRET.nfm), "nfm response_json 漏咗");
assert(!redactedStr.includes(SECRET.nested), "sensitive key 嘅 object value 內層漏咗");
assert(!redactedStr.includes("TOP-LEVEL-NFM-SECRET-F"), "top-level response_json 漏咗");
assert(!redactedStr.includes("TOP-LEVEL-NFM-CAMEL-SECRET-G"), "top-level responseJson 漏咗");
assert(!redactedStr.includes("LINE-1-SECRET-H"), "sensitive key 嘅 array value 漏咗");
// metadata 要保留
assert(redactedStr.includes("wamid.HBgL"), "metadata 應該保留");
assert(redactedStr.includes("85212345678"), "waId 應該保留（唔係內容欄）");
assert(redactedStr.includes("delivered"), "status 應該保留");
assert(redactedStr.includes("[REDACTED len="), "應該有 REDACTED 標記");
assert(redactedStr.includes("[undef]"), "undefined 應該安全序列化");
// 空串邊界：redact 成 [REDACTED len=0]
assert(redactedStr.includes("[REDACTED len=0]"), "空串應該 redact 做 len=0");
// circular：depth 保護生效（marker 出現，冇死）
assert(redactedStr.includes("[REDACTED depth]"), "circular 應該被 depth 保護截斷");
console.log("1. redactDeep OK");

// ===================== 2. pino redact paths =====================

const lines: string[] = [];
const testLog = createLogger({
  write: (line: string) => lines.push(line),
} as never);

// (a) top-level
testLog.info({ body: "TOP-BODY-1", caption: "TOP-CAP-2", response_json: "TOP-NFM-3" }, "a");
// (b) 1 層 nested
testLog.info({ payload: { body: "NEST1-BODY-4" } }, "b");
// (c) 2 層 nested
testLog.info({ a: { b: { body: "NEST2-BODY-5" } } }, "c");
// (d) WA payload shape — entry 頂層
testLog.info(
  {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { id: "w1", text: { body: "DEEP-WA-BODY-6" } },
                { id: "w2", image: { caption: "DEEP-WA-CAP-7" } },
                {
                  id: "w3",
                  interactive: {
                    type: "nfm_reply",
                    nfm_reply: { response_json: "DEEP-WA-NFM-8" },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  },
  "d"
);
// (e) WA payload shape — entry 喺 wrapper key 之下（最常見嘅 log 寫法）
testLog.info({ payload: { entry: [{ changes: [{ value: { messages: [{ id: "w4", text: { body: "WRAP-WA-BODY-9" } }] } }] }] } }, "e");

const pinoOut = lines.join("\n");
for (const s of [
  "TOP-BODY-1",
  "TOP-CAP-2",
  "TOP-NFM-3",
  "NEST1-BODY-4",
  "NEST2-BODY-5",
  "DEEP-WA-BODY-6",
  "DEEP-WA-CAP-7",
  "DEEP-WA-NFM-8",
  "WRAP-WA-BODY-9",
]) {
  assert(!pinoOut.includes(s), `pino 漏咗: ${s}`);
}
assert(pinoOut.includes("REDACTED"), "pino 應該有 REDACTED 標記");
console.log("2. pino redact paths OK (top-level / 1-2層 nested / WA shape 頂層+wrapper)");

// ===================== 3. HMAC 驗簽（同 webhook route 共用同一個 lib） =====================

const secret = "test-app-secret-0123456789abcdef";
const raw = '{"entry":[]}';
const goodSig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

assert(verifyWaSignature(raw, goodSig, secret) === true, "正確簽名應該過");
assert(verifyWaSignature(raw, "sha256=" + "a".repeat(64), secret) === false, "錯簽名應該 fail");
assert(verifyWaSignature(raw, "", secret) === false, "無 signature 應該 fail");
assert(verifyWaSignature(raw, null, secret) === false, "null header 應該 fail");
assert(verifyWaSignature(raw, "sha256=abc", secret) === false, "短簽名應該 fail（唔 throw）");
assert(
  verifyWaSignature(raw, "sha256=" + "A".repeat(64), secret) === false,
  "大寫 hex 簽名應該 fail"
);
assert(
  verifyWaSignature(raw, goodSig, "wrong-secret-0123456789abcdef0") === false,
  "錯 secret 應該 fail"
);
assert(verifyWaSignature(raw, goodSig, undefined) === false, "無 secret 應該 fail");
assert(verifyWaSignature(raw, `sha1=xxx,${goodSig}`, secret) === true, "multi-algo header 應該攞到 sha256");
assert(verifyWaSignature(raw, `  ${goodSig}  `, secret) === true, "header 有 whitespace 應該 trim 後過");
console.log("3. HMAC verify OK");

// ===================== 4. AI mock determinism + 鐵律（Phase 2） =====================

// 呢節有 await → 包入 async IIFE（script 係 CJS context，唔得 top-level await）
void (async () => {
  process.env.AI_MOCK = "1";
  delete process.env.AI_MOCK_FAIL;

  function mockInput(body: string): ClassifyAndDraftInput {
    return {
      messages: [
        { direction: "IN", channel: "API", type: "text", body, waTimestamp: new Date() },
      ],
      clinic: {
        name: "TKW 診所（試點店）",
        greetingConfig: { openingHours: "一至五 10:00-19:00" },
      },
    };
  }

  // (a) 急症：URGENT_PAIN + HIGH + needsHuman + **無 draft**（鐵律 3）
  const urgent = await mockClassifyAndDraft(mockInput("医生我牙好痛，唔知係點"));
  assert.strictEqual(urgent.intent, "URGENT_PAIN", "痛 → URGENT_PAIN");
  assert.strictEqual(urgent.urgency, "HIGH", "急症 urgency HIGH");
  assert.strictEqual(urgent.needsHuman, true, "急症 needsHuman=true");
  assert.strictEqual(urgent.draft, null, "URGENT_PAIN 永不生成 draft（鐵律）");

  // (b) 預約：BOOKING_REQUEST + 有 draft
  const booking = await mockClassifyAndDraft(mockInput("我想預約下週三"));
  assert.strictEqual(booking.intent, "BOOKING_REQUEST", "想約 → BOOKING_REQUEST");
  assert(booking.draft !== null && booking.draft.includes("TKW"), "booking draft 應該含診所名");

  // (c) 兜底：QUESTION + 有 draft
  const q1 = await mockClassifyAndDraft(mockInput("請問幾時開門"));
  const q2 = await mockClassifyAndDraft(mockInput("請問幾時開門"));
  assert.strictEqual(q1.intent, "QUESTION", "一般查詢 → QUESTION");
  assert.strictEqual(q1.summary, q2.summary, "mock 應該 deterministic（同 input 同 output）");
  assert(q1.draft !== null, "QUESTION 應該有 draft");
  assert(q1.summary.length <= 50, "summary ≤50 字");

  // (d) 離題：OUT_OF_SCOPE
  const oos = await mockClassifyAndDraft(mockInput("你哋係咪有股票賣"));
  assert.strictEqual(oos.intent, "OUT_OF_SCOPE", "股票 → OUT_OF_SCOPE");

  // (e) AI_MOCK_FAIL=1 → throw AiCallError（測降級路徑）
  process.env.AI_MOCK_FAIL = "1";
  assert(isAiMockFailEnabled(), "AI_MOCK_FAIL flag 應該生效");
  let threw = false;
  try {
    await mockClassifyAndDraft(mockInput("任何訊息"));
  } catch (e) {
    threw = e instanceof AiCallError;
    assert(!String(e).includes("任何訊息"), "fail 訊息唔可以含訊息原文");
  }
  assert(threw, "AI_MOCK_FAIL 應該 throw AiCallError");
  delete process.env.AI_MOCK_FAIL;
  delete process.env.AI_MOCK;
  console.log("4. AI mock determinism + 鐵律 OK");

  console.log("\nALL SMOKE TESTS PASSED");
})();
