/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * cwi-final S2-9（D-2）：報價抽取 LLM 層（wa-inbox proxy 側）。
 *
 * prompt／parse 由 workforce `apps/web/src/lib/clinical/quote-extract.ts:45-80`
 * （buildLlmPrompt / parseLlmQuoteResponse）**逐字搬過嚟，邏輯唔改** — 改名 buildQuotePrompt /
 * parseQuoteItems，type 收窄做 TermLite（CWM TermEntry 嘅 active 欄位 prompt/parse 完全冇用到）。
 *
 * 獨立 breaker（R-29）：proxy 連續失敗只開呢度自己個 breaker，
 * 唔影響 web process 其他 LLM 功能（chatWithFallback 嘅 shared breaker）。
 */
import { chatWithFallback, getAiConfig } from "../ai/vllm";

export interface TermLite { shorthand: string; nameCn: string; nameEn: string | null }
export interface QuoteItem { text: string | null; code: string | null; amount: number | null; perUnit: boolean }
export type ExtractOutcome = { items: QuoteItem[] | null; reason: null | "breaker_open" | "llm_error" | "parse_error" | "mock" };

const ITEMS_SCHEMA = {
  type: "object", required: ["items"],
  properties: { items: { type: "array", maxItems: 20, items: { type: "object", required: ["text", "code", "amount", "perUnit"],
    properties: { text: { type: ["string", "null"] }, code: { type: ["string", "null"] }, amount: { type: ["number", "null"] }, perUnit: { type: "boolean" } } } } },
};

// 獨立 breaker（R-29）：proxy 連續失敗唔影響 web process 其他 LLM 功能
let fails = 0; let openUntil = 0;

export function buildQuotePrompt(terms: TermLite[]): string {
  const dict = terms.map((t) => `${t.shorthand}=${t.nameCn}${t.nameEn ? `(${t.nameEn})` : ""}`).join(", ");
  return (
    `你係牙科臨床記錄報價抽取器。由文本抽出報價項目，只輸出 JSON（唔好任何其他文字）：` +
    `{"items":[{"text":"原文詞","code":"療程code","amount":數字|null,"perUnit":bool}]}。` +
    `code 只能由下列清單揀（唔准自由發明，唔知就 null）：${dict}。` +
    `金額：4K=4000、900@=900 per unit、5-6K 取中 5500。`
  );
}

/** 解析 LLM 輸出（strip ``` fence + 只收字典 code）→ null = 失敗（低信心保留）。 */
export function parseQuoteItems(content: string, terms: TermLite[]): QuoteItem[] | null {
  try {
    let s = content.trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    if (fence) s = fence[1].trim();
    const j = JSON.parse(s) as any;
    if (!Array.isArray(j?.items)) return null;
    const byLower = new Map(terms.map((t) => [t.shorthand.toLowerCase(), t]));
    return j.items
      .filter((i: any) => i && typeof i === "object")
      .slice(0, 20)
      .map((i: any) => {
        const codeRaw = typeof i.code === "string" ? i.code.trim() : "";
        const code = byLower.has(codeRaw.toLowerCase()) ? byLower.get(codeRaw.toLowerCase())!.shorthand : null;
        const amt = typeof i.amount === "number" && Number.isFinite(i.amount) && i.amount > 0 ? Math.round(i.amount) : null;
        return {
          text: typeof i.text === "string" ? i.text.trim().slice(0, 60) : null,
          code,
          amount: amt,
          perUnit: i.perUnit === true,
        };
      });
  } catch {
    return null;
  }
}

export async function extractQuoteItems(notePlain: string, terms: TermLite[]): Promise<ExtractOutcome> {
  if (process.env.AI_MOCK === "1") return { items: mockItems(notePlain, terms), reason: "mock" };
  if (Date.now() < openUntil) return { items: null, reason: "breaker_open" };
  try {
    const r = await chatWithFallback(getAiConfig(), {
      messages: [{ role: "system", content: buildQuotePrompt(terms) }, { role: "user", content: notePlain.slice(0, 2000) }],
      guidedJson: ITEMS_SCHEMA, temperature: 0, maxTokens: 800, timeoutMs: 30_000,
      skipBreaker: true, // ★ 新 option（見 ③）
    });
    fails = 0;
    const items = parseQuoteItems(r.content, terms);
    return items ? { items, reason: null } : { items: null, reason: "parse_error" };
  } catch {
    // ★ 唔好 log err.message（sglang 錯誤訊息理論上唔含 prompt，但唔冒險）
    if (++fails >= 3) { openUntil = Date.now() + 60_000; fails = 0; }
    return { items: null, reason: "llm_error" };
  }
}

/** AI_MOCK：字典 shorthand 喺原文出現就回一項（決定性；e2e 用） */
function mockItems(note: string, terms: TermLite[]): QuoteItem[] {
  const low = note.toLowerCase();
  return terms.filter((t) => low.includes(t.shorthand.toLowerCase())).slice(0, 20)
    .map((t) => ({ text: t.shorthand, code: t.shorthand, amount: null, perUnit: false }));
}
