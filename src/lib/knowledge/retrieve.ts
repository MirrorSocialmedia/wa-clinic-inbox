/**
 * ★ Part F（cwi-raggolden-20260904，MD §Part F F.3）：兩階段知識檢索。
 *
 * 階段一（選）：目錄（每條 `id | title | keywords.join("/")` 一行）入 prompt，
 *   Qwen 揀 id（max 3 按相關度；NONE = 無關）。
 * 階段二（答）：2–3 條全文入 draft prompt 新 `<knowledge>` 段（連 title 方便 trace）。
 *
 * 工程細節（MD 明言唔跟會出事 — 全部實現）：
 * - lexicon 喺階段一之前 normalize（applyLexicon，B4 src/lib/sessions/lexicon.ts）
 * - 階段一 **timeout 3s 或 NONE → 跳過 RAG 照出草稿**（fail-soft — 本函數零 throw）
 * - 回嘅 id 唔喺目錄 → 丟棄 + log `knowledge: hallucinated id`
 * - 目錄 >2500 字 log warn（catalog.ts 做）
 * - 目錄字串 cache 5 分鐘（catalog.ts；知識更新 → CONTROL_CHANNEL cache:bust）
 *
 * mock 模式（AI_MOCK=1，e2e 決定性）：keyword 匹配（score = 命中 keyword 數；
 * tie → PRICE>SERVICE>POST_OP>PREP>POLICY>FAQ）。開關（決定性，唔使重啟 worker）：
 * - question 含 `E2E-KNOWLEDGE-NONE`  → 模擬 NONE（無相關）
 * - env KNOWLEDGE_MOCK_HALLUCINATE=1 → 回目錄外 fake id（幻覺丟棄測試靶）
 * - env KNOWLEDGE_MOCK_TIMEOUT=1     → 模擬 3s timeout（fail-soft 測試靶）
 */
import { getAiConfig } from "@/lib/ai/vllm";
import { isAiMockEnabled } from "@/lib/ai/mock";
import { PRICE_INTENT_TERMS } from "@/lib/ai/price-guard";
import { getLexicon, applyLexicon } from "@/lib/sessions/lexicon";
import { getKnowledgeCatalog, type CatalogDoc, type KnowledgeCatalog } from "./catalog";
import log from "@/lib/log";

/** 階段一 timeout（MD：3s）— 唔跟住 cfg.timeoutMs（8s/20s 都太耐）。 */
const STAGE1_TIMEOUT_MS = 3000;
const MAX_PICKS = 3;
const NONE_TOKEN = "NONE";

/** mock 決定性排序：kind 優先（price chain 要 PRICE 穩排前）。 */
const KIND_PRIORITY: Record<string, number> = { PRICE: 0, SERVICE: 1, POST_OP: 2, PREP: 3, POLICY: 4, FAQ: 5 };

export interface KnowledgePickResult {
  /** 有無行過階段一（目錄唔空 + 有問題文本）— L2 自動覆前提用 */
  ran: boolean;
  /** 檢索揀出嘅條目（已按相關度排序；1–3 條；NONE/timeout/全幻覺 = []） */
  picked: CatalogDoc[];
  /** 幻覺丟棄咗幾多個 id */
  discarded: number;
  /** skip 原因（null = 冇 skip）：no-catalog / no-question / timeout / none / fail-soft */
  skipped: string | null;
  /** 階段一 latency（ms；skip 時 = 0） */
  latencyMs: number;
}

/** 階段二：`<knowledge>` 段（擺事實段之後、對話歷史之前；連 title 方便 trace/引用）。 */
export function knowledgePromptBlock(docs: CatalogDoc[]): string {
  if (docs.length === 0) return "";
  return (
    "\n\n【知識庫（診所 staff 管嘅參數 — 可參考作答；唔准斷症/開藥；報價以系統附加為準）】\n" +
    docs.map((d) => `[${d.title}]（${d.kind}）\n${d.body}`).join("\n")
  );
}

/** mock 決定性匹配分數（score = 命中 keyword 數；title 唔計 — keyword 係 staff 管嘅檢索面，title 太弱信號）。
 *  tie → PRICE>SERVICE>POST_OP>PREP>POLICY>FAQ（price chain 要 PRICE 穩排前）。 */
function mockScore(doc: CatalogDoc, question: string): number {
  if (!question) return 0;
  let score = 0;
  for (const k of doc.keywords) {
    // ★ 通用價錢詞（幾錢/收費/…）唔計分 — 否則任何價錢問題都會 match 晒 PRICE doc（錯服務報價）。
    //   價錢意圖由 isPriceIntent 判斷；doc 揀擇靠服務名 keyword。
    if (!k || (PRICE_INTENT_TERMS as readonly string[]).includes(k)) continue;
    if (question.includes(k)) score += 1;
  }
  return score;
}

/**
 * 決定性 keyword fallback（price chain 用：stage 1 picked 冇 PRICE doc 時，
 * PRICE 目錄 keyword match 撳底 — code 層，零 LLM，mock/real 同一行為）。
 */
export function matchPriceDocs(catalog: KnowledgeCatalog, question: string): CatalogDoc[] {
  if (!question) return [];
  const scored = catalog.docs
    .filter((d) => d.kind === "PRICE")
    .map((d) => ({ d, s: mockScore(d, question) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.d.title.localeCompare(b.d.title, "zh-HK"));
  return scored.slice(0, 2).map((x) => x.d);
}

/** 階段一 prompt（MD 原文）。 */
function stage1Prompt(question: string, ctx: string, catalogText: string): string {
  return [
    "以下係診所知識庫目錄。病人問題：「" + question + "」（最近 3 句 context：" + (ctx || "（無）") + "）",
    catalogText,
    "揀出可以回答呢條問題嘅條目 id，最多 " + MAX_PICKS + " 個，按相關度排序。",
    "完全冇相關就回 " + NONE_TOKEN + "。只回 id，逗號分隔，唔好解釋。",
  ].join("\n");
}

/** 階段一 LLM call（real mode）— 3s timeout，primary+fallback 各試一次，全部 fail → throw（caller fail-soft）。 */
async function stage1Llm(prompt: string): Promise<string> {
  const cfg = getAiConfig();
  if (!cfg.baseUrl) throw new Error("VLLM_BASE_URL 未設定");
  const models =
    cfg.fallbackModel && cfg.fallbackModel !== cfg.primaryModel ? [cfg.primaryModel, cfg.fallbackModel] : [cfg.primaryModel];
  let lastErr = "unknown";
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STAGE1_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 64,
          ...(cfg.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }),
      });
      if (!res.ok) throw new Error(`stage1 ${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) throw new Error("stage1 empty content");
      return content;
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      lastErr = name === "AbortError" ? `timeout ${STAGE1_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "network error";
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`stage1 failed: ${lastErr}`);
}

/** 解析階段一回覆 → id 陣列（NONE → []；只收目錄內 id — 幻覺丟棄 + log）。 */
function parsePicks(raw: string, catalog: KnowledgeCatalog): { ids: string[]; discarded: number } {
  const trimmed = raw.trim().replace(/```(?:json)?/g, "").trim();
  if (!trimmed) return { ids: [], discarded: 0 };
  // 整段就係 NONE（model 可能回 "NONE。" — 撳尾标点）
  if (/^none[.。!！]*$/i.test(trimmed.replace(/^["'\s]+|["'\s]+$/g, ""))) return { ids: [], discarded: 0 };
  const out: string[] = [];
  let discarded = 0;
  for (const part of trimmed.split(/[,，;；\s]+/)) {
    const id = part.trim().replace(/^["']+|["',，.。;；!！]+$/g, "");
    if (!id || /^none$/i.test(id)) continue;
    if (!catalog.byId.has(id)) {
      discarded += 1;
      log.warn({ id }, "knowledge: hallucinated id — 丟棄（唔喺目錄）");
      continue;
    }
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_PICKS) break;
  }
  return { ids: out, discarded };
}

/**
 * 兩階段檢索（階段一入口 — 階段二 = caller 用 knowledgePromptBlock(picked) 入 draft prompt）。
 * **fail-soft：任何失敗 → skipped 原因 + picked=[]，零 throw。**
 *
 * @param question 病人觸發訊息文本（raw；函數內 lexicon normalize）
 * @param context  最近 3 句 context（raw 行，可空）
 */
export async function pickKnowledge(opts: {
  clinicId: string | null;
  question: string | null;
  context?: string[];
}): Promise<KnowledgePickResult> {
  const t0 = Date.now();
  const question = (opts.question ?? "").trim();
  if (!question) return { ran: false, picked: [], discarded: 0, skipped: "no-question", latencyMs: 0 };

  // ── lexicon normalize（階段一之前 — MD 工程細節）──
  let normalized = question;
  try {
    const lex = await getLexicon(opts.clinicId);
    normalized = applyLexicon(question, lex);
  } catch {
    /* lexicon fail-soft → 原文 */
  }
  const ctx = (opts.context ?? []).slice(-3).join(" / ");

  const catalog = await getKnowledgeCatalog(opts.clinicId);
  if (catalog.docs.length === 0) {
    return { ran: false, picked: [], discarded: 0, skipped: "no-catalog", latencyMs: Date.now() - t0 };
  }

  // ── mock 決定性匹配（e2e；keyword token 開關）──
  if (isAiMockEnabled()) {
    // ★ e2e 靶（per-message token — worker 係長駐 process，env 開關要重起先生效，token 唔使）：
    //   E2E-KNOWLEDGE-TIMEOUT / E2E-KNOWLEDGE-HALLUCINATE（env KNOWLEDGE_MOCK_* 保留做 unit test 用）
    if (process.env.KNOWLEDGE_MOCK_TIMEOUT === "1" || /E2E-KNOWLEDGE-TIMEOUT/.test(normalized)) {
      log.warn({ clinicId: opts.clinicId ?? "global" }, "knowledge: stage1 mock timeout — 跳過 RAG（fail-soft）");
      return { ran: true, picked: [], discarded: 0, skipped: "timeout", latencyMs: STAGE1_TIMEOUT_MS };
    }
    if (/E2E-KNOWLEDGE-NONE/.test(normalized)) {
      return { ran: true, picked: [], discarded: 0, skipped: "none", latencyMs: Date.now() - t0 };
    }
    const hallucinate = process.env.KNOWLEDGE_MOCK_HALLUCINATE === "1" || /E2E-KNOWLEDGE-HALLUCINATE/.test(normalized);
    const scored = catalog.docs      .map((d) => ({ d, s: mockScore(d, normalized) }))
      .filter((x) => x.s > 0)
      .sort(
        (a, b) =>
          b.s - a.s ||
          (KIND_PRIORITY[a.d.kind] ?? 9) - (KIND_PRIORITY[b.d.kind] ?? 9) ||
          a.d.title.localeCompare(b.d.title, "zh-HK")
      );
    if (hallucinate) {
      log.info({}, "knowledge: mock hallucinate armed（返回 fake id + 真 id）");
    }
    const ids = hallucinate
      ? ["e2e-hallucinated-id", ...scored.slice(0, MAX_PICKS).map((x) => x.d.id)]
      : scored.map((x) => x.d.id);    const { ids: valid, discarded } = parsePicks(ids.join(","), catalog);
    const picked = valid.map((id) => catalog.byId.get(id)!).slice(0, MAX_PICKS);
    return { ran: true, picked, discarded, skipped: picked.length === 0 ? "none" : null, latencyMs: Date.now() - t0 };
  }

  // ── real mode：Qwen 兩階段（階段一 = LLM 選 id，3s timeout）──
  try {
    const prompt = stage1Prompt(normalized, ctx, catalog.text);
    const raw = await stage1Llm(prompt);
    const { ids, discarded } = parsePicks(raw, catalog);
    const picked = ids.map((id) => catalog.byId.get(id)!).slice(0, MAX_PICKS);
    return { ran: true, picked, discarded, skipped: picked.length === 0 ? "none" : null, latencyMs: Date.now() - t0 };
  } catch (err) {
    // 3s timeout / LLM 死 → 跳過 RAG 照出草稿（fail-soft — MD 工程細節）
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ clinicId: opts.clinicId ?? "global", err: msg }, "knowledge: stage1 失敗 — 跳過 RAG（fail-soft）");
    return { ran: true, picked: [], discarded: 0, skipped: msg.includes("timeout") ? "timeout" : "fail-soft", latencyMs: Date.now() - t0 };
  }
}
