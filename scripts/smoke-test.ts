/* Phase 0-C smoke test — log redact + webhook HMAC 驗簽（純邏輯，唔使 DB/Redis） */
import assert from "node:assert";
import { createHmac, timingSafeEqual } from "node:crypto";
import { redactDeep, createLogger } from "../src/lib/log";

// --- 1. redactDeep ---
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
                text: { body: "我想預約下週三陳醫生" },
              },
            ],
          },
        },
      ],
    },
  ],
  draftText: "你好，歡迎光臨",
  message: "hello secret",
  text: "plain text",
};

const redacted = JSON.parse(JSON.stringify(redactDeep(sample)));
const redactedStr = JSON.stringify(redacted);

assert(!redactedStr.includes("預約"), "body 原文漏咗");
assert(!redactedStr.includes("陳醫生"), "body 原文漏咗");
assert(!redactedStr.includes("歡迎光臨"), "draftText 漏咗");
assert(!redactedStr.includes("hello secret"), "message 漏咗");
assert(!redactedStr.includes("plain text"), "text 漏咗");
assert(redactedStr.includes("wamid.HBgL"), "metadata 應該保留");
assert(redactedStr.includes("85212345678"), "waId 應該保留（唔係內容欄）");
assert(redactedStr.includes("[REDACTED len="), "應該有 REDACTED 標記");
console.log("redactDeep OK:", redactedStr);

// --- 2. pino redact paths (top-level body) ---
const lines: string[] = [];
const testLog = createLogger({
  write: (line: string) => lines.push(line),
} as never);
testLog.info({ body: "top-level secret 訊息", n: 1 }, "test");
const pinoLine = lines.join("");
assert(pinoLine.length > 0, "pino output 應該有輸出");
assert(!pinoLine.includes("top-level secret"), "pino top-level body 漏咗");
assert(pinoLine.includes("REDACTED"), "pino 應該 redact");
console.log("pino top-level redact OK");

// --- 3. HMAC 驗簽邏輯（同 webhook route 相同邏輯）---
function verifySignature(rawBody: string, header: string, appSecret: string): boolean {
  if (!appSecret || !header) return false;
  const sha256Part = header
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("sha256="));
  if (!sha256Part) return false;
  const expected =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(sha256Part);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const secret = "test-app-secret-0123456789abcdef";
const raw = '{"entry":[]}';
const goodSig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
assert(verifySignature(raw, goodSig, secret) === true, "正確簽名應該過");
assert(verifySignature(raw, "sha256=" + "a".repeat(64), secret) === false, "錯簽名應該 fail");
assert(verifySignature(raw, "", secret) === false, "無 signature 應該 fail");
assert(verifySignature(raw, "sha256=abc", secret) === false, "短簽名應該 fail（唔 throw）");
assert(
  verifySignature(raw, goodSig, "wrong-secret-0123456789abcdef0") === false,
  "錯 secret 應該 fail"
);
assert(verifySignature(raw, `sha1=xxx,${goodSig}`, secret) === true, "multi-algo header 應該攞到 sha256");
console.log("HMAC verify OK");

console.log("\nALL SMOKE TESTS PASSED");
