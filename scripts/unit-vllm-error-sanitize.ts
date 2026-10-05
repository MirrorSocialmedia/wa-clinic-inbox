/**
 * unit-vllm-error-sanitize — cwi-labdoc-followup m-2（hermetic — 零 DB / 零網絡 / 唔起 server）。
 *
 * 施工單規格（labdoc-w-followup m-2）：`src/lib/ai/vllm.ts` 非 ok 上游回應 → **唔好將上游
 * `error.message` 內容帶入 AiCallError**（鐵律推廣到 AI client 層 — 唔賭上游行為：vLLM/sglang
 * 嘅 error body 有冇 PII / prompt 殘片，W 側控制唔到）。只留 status/model/latency 做診斷。
 *
 * 斷言（mock globalThis.fetch — 零真網絡）：
 *   1. SENTINEL：404 + error.message = "SENTINEL-PROMPT-LEAK" → 最終 AiCallError.message
 *      **唔含** "SENTINEL-PROMPT-LEAK"（直接捉「上游內容洩入 W 側 error/log」呢條洩漏路徑）
 *   2. 新 message shape = `ai <status> (model=<m>, <n>ms)`（無 " : " 拼接）
 *   3. 500 + 非 JSON body（res.json() → null 路徑）→ 同樣 shape、唔 crash
 *   4. 非 timeout（isTimeout 唔設）+ retry 語義不變（2 attempts）
 *
 * 共用路徑提醒：vllm.ts 係 llm-extract + labdoc-extract 同一條路徑 — 呢個改動令兩個 internal
 * route 嘅錯誤訊息少咗上游描述（預期待；上游原文喺 30000 server 自己 log）。
 *
 * 跑法（repo root）：pnpm tsx scripts/unit-vllm-error-sanitize.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { chatWithFallback } from "@/lib/ai/vllm";
import type { AiChatOptions, AiConfig } from "@/lib/ai/vllm";
import { AiCallError } from "@/lib/ai/types";

const SENTINEL = "SENTINEL-PROMPT-LEAK";

// fetch 已 mock — baseUrl 永遠唔會真连
const CFG: AiConfig = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: null,
  primaryModel: "test-model",
  fallbackModel: "", // 單 model（唔行 fallback 路徑 — 斷言聚焦非 ok 回應處理）
  timeoutMs: 2_000,
  disableThinking: false,
};
const OPTS: AiChatOptions = {
  messages: [{ role: "user", content: "hello" }],
  skipBreaker: true, // 唔記 shared breaker（unit 零狀態污染）
};

/** 抓 AiCallError（唔係 = throw — 測試紅） */
async function expectAiCallError(fn: () => Promise<unknown>): Promise<AiCallError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AiCallError) return e;
    throw e;
  }
  throw new Error("expected AiCallError — 未 throw");
}

/** mock 一個固定非 ok 上游回應；返實際 fetch 被 call 次數 */
function mockUpstream(status: number, body: string): { restore: () => void; calls: () => number } {
  const prev = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = prev), calls: () => n };
}

test("m-2 SENTINEL：非 ok 404 上游 error.message 唔入 AiCallError", async () => {
  const m = mockUpstream(404, JSON.stringify({ error: { message: SENTINEL } }));
  try {
    const err = await expectAiCallError(() => chatWithFallback(CFG, OPTS));
    assert.ok(!err.message.includes(SENTINEL), `上游 error.message 洩入 W 側 error — message=${err.message}`);
    // 新 shape：`ai <status> (model=<m>, <n>ms)` — 無 " : " 拼接
    assert.match(err.message, /^ai 404 \(model=test-model, \d+ms\)$/);
    assert.ok(!err.message.includes(" : "), `唔應該再有 " : " 拼接 — message=${err.message}`);
  } finally {
    m.restore();
  }
});

test("m-2 SENTINEL：retry 語義不變（1 重試 = 共 2 attempts）+ 非 timeout", async () => {
  const m = mockUpstream(404, JSON.stringify({ error: { message: SENTINEL } }));
  try {
    const err = await expectAiCallError(() => chatWithFallback(CFG, OPTS));
    assert.equal(m.calls(), 2, "primary 重試 1 次（共 2 attempts）");
    assert.equal(err.isTimeout, undefined, "非 timeout 路徑 — isTimeout 唔設");
  } finally {
    m.restore();
  }
});

test("m-2：500 + 非 JSON body（res.json() → null 路徑）→ 同樣 shape、唔 crash", async () => {
  const m = mockUpstream(500, "<html><body>Internal Server Error</body></html>");
  try {
    const err = await expectAiCallError(() => chatWithFallback(CFG, OPTS));
    assert.match(err.message, /^ai 500 \(model=test-model, \d+ms\)$/);
    assert.ok(!err.message.includes("Internal Server Error"), "上游 HTML body 唔應入 message");
  } finally {
    m.restore();
  }
});

test("m-2：error.message 長於 160 字（舊版 .slice(0,160) 截斷位）→ 依然零洩漏", async () => {
  const longMsg = "SENTINEL-" + "x".repeat(400);
  const m = mockUpstream(429, JSON.stringify({ error: { message: longMsg } }));
  try {
    const err = await expectAiCallError(() => chatWithFallback(CFG, OPTS));
    assert.ok(!err.message.includes("SENTINEL"), `長 error.message 洩漏 — message=${err.message}`);
    assert.match(err.message, /^ai 429 \(model=test-model, \d+ms\)$/);
  } finally {
    m.restore();
  }
});
