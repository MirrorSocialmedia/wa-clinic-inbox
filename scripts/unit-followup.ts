/**
 * unit-followup.ts — P3 Follow-up 引擎純函數 unit test（零 DB / 零 network）
 *
 * 跑法：pnpm test:unit-followup
 * 覆蓋：renderFollowupText（變數替換 / 缺變數 / 注入安全）+ detectOptOutIntent（命中 / 誤傷防護）
 */
import assert from "node:assert";
import { renderFollowupText } from "../src/lib/followup/engine";
import { detectOptOutIntent } from "../src/lib/followup/opt-out";

let pass = 0;
function t(name: string, fn: () => void): void {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log("[unit-followup] renderFollowupText");
t("替換 {{var}}", () => {
  assert.strictEqual(renderFollowupText("Hi {{a}}, {{b}}", { a: "X", b: "Y" }), "Hi X, Y");
});
t("缺變數 → 空字串（唔留 {{ 殘留）", () => {
  const out = renderFollowupText("{{a}} and {{missing}} end", { a: "1" });
  assert.strictEqual(out, "1 and  end");
  assert.ok(!out.includes("{{"));
});
t("null/undefined 值 → 空字串", () => {
  assert.strictEqual(renderFollowupText("[{{x}}]", { x: null }), "[]");
});
t("數字值 → 字串化", () => {
  assert.strictEqual(renderFollowupText("$ {{amt}}", { amt: 600 }), "$ 600");
});
t("text 含 {{ 但唔係變數形式（單括號）唔動", () => {
  assert.strictEqual(renderFollowupText("price {{100", {}), "price {{100");
});
t("空 text", () => {
  assert.strictEqual(renderFollowupText("", { a: "1" }), "");
});

console.log("[unit-followup] detectOptOutIntent");
t("英文：stop / unsubscribe", () => {
  assert.strictEqual(detectOptOutIntent("stop"), true);
  assert.strictEqual(detectOptOutIntent("please unsubscribe"), true);
});
t("粵語：唔好再搵我 / 唔想收 / 退訂", () => {
  assert.strictEqual(detectOptOutIntent("唔好再搵我"), true);
  assert.strictEqual(detectOptOutIntent("唔想收跟進訊息喇"), true);
  assert.strictEqual(detectOptOutIntent("退訂"), true);
});
t("普通話：不要再聯絡我", () => {
  assert.strictEqual(detectOptOutIntent("不要再聯絡我"), true);
});
t("誤傷防護：長句（>40 字）唔判定", () => {
  assert.strictEqual(detectOptOutIntent("doctor said stop smoking ok thanks, will come next tuesday 10am to continue the treatment plan"), false);
});
t("誤傷防護：stop 唔係獨立詞（stopped/stopwatch）", () => {
  assert.strictEqual(detectOptOutIntent("the stopwatch stopped"), false);
});
t("空字串 → false", () => {
  assert.strictEqual(detectOptOutIntent(""), false);
});

console.log(`\nUNIT-FOLLOWUP: ${pass} passed ✔`);
process.exit(0);
