/**
 * Embedded Signup postMessage 解析 — 含對抗式輸入。
 * 運行：npx tsx --test src/lib/wa/embedded-signup.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignupMessage } from "./embedded-signup";

const T = "WA_EMBEDDED_SIGNUP";

test("ES1 v3 FINISH：ids 喺 data 入面", () => {
  assert.deepEqual(parseSignupMessage({ type: T, event: "FINISH", version: 3, data: { phone_number_id: "111", waba_id: "222", business_id: "333" } }), {
    kind: "finish",
    mode: "cloud",
    phoneNumberId: "111",
    wabaId: "222",
  });
});

test("ES2 舊版 v2：current_step + 頂層 ids 照收", () => {
  assert.deepEqual(parseSignupMessage({ type: T, current_step: "FINISH_ONLY_WABA", waba_id: "222" }), {
    kind: "finish",
    mode: "cloud",
    phoneNumberId: undefined,
    wabaId: "222",
  });
});

test("ES3 共存 FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING → mode=coexistence（phone id 可缺）", () => {
  assert.deepEqual(parseSignupMessage({ type: T, event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", version: 3, data: { waba_id: "999" } }), {
    kind: "finish",
    mode: "coexistence",
    phoneNumberId: undefined,
    wabaId: "999",
  });
});

test("ES4 JSON 字串 payload 照解", () => {
  const r = parseSignupMessage(JSON.stringify({ type: T, event: "FINISH", data: { phone_number_id: "1", waba_id: "2" } }));
  assert.equal(r.kind, "finish");
});

test("ES5 CANCEL：無 error_message = 取消；有 = 錯誤；ERROR 冇訊息 = unknown", () => {
  assert.deepEqual(parseSignupMessage({ type: T, event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } }), { kind: "cancel", step: "PHONE_NUMBER_SETUP" });
  assert.deepEqual(parseSignupMessage({ type: T, event: "CANCEL", data: { error_message: "boom" } }), { kind: "error", message: "boom" });
  assert.deepEqual(parseSignupMessage({ type: T, current_step: "ERROR" }), { kind: "error", message: "unknown" });
});

test("ES6 對抗：type 唔啱／垃圾 → ignore；非數字 id 唔信", () => {
  assert.equal(parseSignupMessage(null).kind, "ignore");
  assert.equal(parseSignupMessage("not json{").kind, "ignore");
  assert.equal(parseSignupMessage({ type: "OTHER", event: "FINISH" }).kind, "ignore");
  assert.equal(parseSignupMessage({ type: T, event: "SOMETHING_NEW" }).kind, "ignore");
  const r = parseSignupMessage({ type: T, event: "FINISH", data: { phone_number_id: "1; DROP", waba_id: { x: 1 } } });
  assert.deepEqual(r, { kind: "finish", mode: "cloud", phoneNumberId: undefined, wabaId: undefined });
  const long = parseSignupMessage({ type: T, event: "FINISH", data: { phone_number_id: "9".repeat(40) } });
  assert.equal(long.kind === "finish" ? long.phoneNumberId : "x", undefined);
});
