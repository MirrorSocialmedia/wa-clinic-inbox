/**
 * unit-meta-compliance — Meta App Review 合規（wa-meta-compliance-20261016）pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯）：
 *   1. detectOptOutIntent — 工單 B.4 點名停止語句（中/英）+ 既有詞 + 誤傷防護
 *   2. detectOptInIntent  — 恢復聯絡短語（只供已 opt-out contact 用）+ 誤傷防護
 *   3. 人工要求詞表（C.1）— detectConsultSignals.humanRequested 覆蓋工單實測語句
 *
 * 用法（repo root）：npx tsx scripts/unit-meta-compliance.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { detectOptOutIntent, detectOptInIntent, optOutWordCount } from "../src/lib/followup/opt-out";
import { detectConsultSignals, HUMAN_REQUEST_TERMS } from "../src/lib/sessions/consult-engine";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function eq(actual: unknown, expected: unknown, label = "") {
  if (actual !== expected) throw new Error(`${label} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

// ── 1. opt-out 停止語句 ─────────────────────────────────────────────────
console.log("\n[1] detectOptOutIntent — 工單點名 + 既有 + 誤傷防護");

const OPT_OUT_TRUE = [
  // 工單 B.4 點名（2026-10 新增）
  "停止聯絡",
  "請停止聯絡我",
  "停止發送",
  "不要再發",
  "唔好再發",
  "别再發",
  "不要再發訊息",
  "stop sending",
  "STOP Sending",
  "stop messages",
  "no more messages",
  "Stop contacting me",
  // 既有出廠詞（回歸）
  "唔好再搵我",
  "唔好再send",
  "唔想收",
  "不要再聯絡我",
  "退訂",
  "unsubscribe",
  "stop",
  "stop following up",
  "do not contact me",
];
for (const t of OPT_OUT_TRUE) {
  check(`opt-out 命中：「${t}」`, () => eq(detectOptOutIntent(t), true));
}

const OPT_OUT_FALSE = [
  null,
  "",
  "   ",
  "我嘅牙好痛",
  "想預約星期四",
  "thanks, that helps",
  "唔好意思", // 「唔好」唔係「唔好再X」
  "再見",
];
for (const t of OPT_OUT_FALSE) {
  check(`opt-out 唔命中：${t === null ? "null" : `「${t}」`}`, () => eq(detectOptOutIntent(t as string), false));
}
// 「stop the pain」= 已知 bare-stop 誤傷 — 文檔化為 residual risk（staff notice + 易復原 係 mitigation）；
// 呢度只 assert 佢「係」true（同代碼行為一致），防止有人誤改回 bare word 以外嘅口徑時悄悄改變。
check("已知口徑：「stop the pain」命中 bare \\bstop\\b（residual risk 文檔化）", () =>
  eq(detectOptOutIntent("stop the pain please"), true)
);
// 長句誤傷防護（>40 字）
const longMsg =
  "医生你好，我想问关于上次洗牙之后牙齿敏感嘅事，麻烦你帮我睇下 stop smoking 對牙龈有冇影響，我唔係想退訂跟進";
check("誤傷防護：>40 字長句唔判定", () => eq(detectOptOutIntent(longMsg), false));

check("optOutWordCount > 0（詞表非空）", () => {
  if (!(optOutWordCount() > 10)) throw new Error(`count=${optOutWordCount()}`);
});

// ── 2. opt-in 恢復語句 ─────────────────────────────────────────────────
console.log("\n[2] detectOptInIntent — 恢復主動聯絡");

const OPT_IN_TRUE = [
  "可以繼續發",
  "可以继续发",
  "恢復聯絡",
  "恢复联络",
  "重新聯絡我",
  "想再收跟進",
  "願意再收訊息",
  "resume messages",
  "Resume Message",
  "start messaging me",
  "please contact me again",
  "yes, contact me",
];
for (const t of OPT_IN_TRUE) {
  check(`opt-in 命中：「${t}」`, () => eq(detectOptInIntent(t), true));
}
const OPT_IN_FALSE = [
  null,
  "",
  "唔好再搵我",
  "我想預約",
  "可以嘅", // 「可以」唔係「可以繼續發」
  "resume", // 單詞唔夠 — 要 "resume messages/contact"
  "stop",
];
for (const t of OPT_IN_FALSE) {
  check(`opt-in 唔命中：${t === null ? "null" : `「${t}」`}`, () => eq(detectOptInIntent(t as string), false));
}
// opt-out 同 opt-in 唔會同一句雙命中（worker 用 else-if — opt-out 優先）
check("互斥口徑：「唔好再發」唔係 opt-in", () => eq(detectOptInIntent("唔好再發"), false));
check("互斥口徑：「可以繼續發」唔係 opt-out", () => eq(detectOptOutIntent("可以繼續發"), false));

// ── 3. 人工要求詞表（C.1）──────────────────────────────────────────────
console.log("\n[3] 人工要求（C.1）— detectConsultSignals.humanRequested");

function humanReq(rawText: string): boolean {
  return detectConsultSignals({
    canonicalText: rawText,
    rawText,
    workflow: "ORTHODONTIC_CONSULT",
    external: { redFlagHit: false, complaint: false, windowExpired: false, namedProduct: null },
  }).humanRequested;
}

const HUMAN_TRUE = [
  "人工",
  "搵人工",
  "我要人工服務",
  "真人",
  "真人服務",
  "我要同職員傾",
  "human agent",
  "talk to a human",
  "speak to a human",
  "talk to someone",
  "real person",
  "I want a human staff",
  "please connect me to human staff",
];
for (const t of HUMAN_TRUE) {
  check(`human 命中：「${t}」`, () => eq(humanReq(t), true));
}
const HUMAN_FALSE = [
  "我想預約矯齒",
  "植牙幾錢？",
  "我隻牙好痛",
  "算啦",
];
for (const t of HUMAN_FALSE) {
  check(`human 唔命中：「${t}」`, () => eq(humanReq(t), false));
}
check("HUMAN_REQUEST_TERMS 包含工單三實測語句關鍵詞", () => {
  for (const t of ["人工", "真人", "職員"]) {
    if (!HUMAN_REQUEST_TERMS.includes(t)) throw new Error(`missing ${t}`);
  }
});

// ── summary ────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${total} checks: ${pass} pass / ${fail} fail`);
if (fail > 0) {
  console.log("FAILED:");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
