/**
 * ★ Part F（cwi-raggolden-20260904，MD §Part F F.4）：報價鏈 + 價格守衛（deterministic）。
 *
 * 報價鏈觸發：intent=QUESTION 且 lexicon normalize 後命中價錢意圖
 *   （幾錢/收費/價錢/貴唔貴/幾多錢）→ 檢索優先 kind=PRICE 其次 SERVICE：
 * - 有 PRICE doc → 草稿 = 範圍 + 影響因素（body）+ disclaimer（**code 強制附加**）
 * - 無 PRICE doc → **唔准報價**：「呢項收費要幫你問返同事／到診評估」+ 標記人手
 *
 * price-guard（草稿生成後、入庫前，deterministic，3 條）：
 * ① 草稿含價錢符號/數字模式 且 零 PRICE 引用 → 棄用草稿改人手提示版 + log `price: unsourced amount blocked`
 * ② 有 PRICE doc 但 disclaimer 句唔喺草稿 → code 自動 append
 * ③ 草稿金額數字唔喺 [priceMin, priceMax] → 同 ① 處理
 *
 * > 呢三條係報價唯一嘅安全保證 — 模型幻覺一個價出嚟嘅風險由此結構性消除。
 *
 * ★ 純函數（零 IO）— 可單測；worker 調用後落 DB。PII：價格/服務名 = staff 管嘅參數，非病人資料。
 */
import type { CatalogDoc } from "@/lib/knowledge/catalog";
import log from "@/lib/log";

/** 價錢意圖詞（MD F.4 — lexicon normalize 後匹配）。 */
export const PRICE_INTENT_TERMS = ["幾錢", "收費", "價錢", "貴唔貴", "幾多錢"] as const;

export function isPriceIntent(normalizedText: string): boolean {
  if (!normalizedText) return false;
  return PRICE_INTENT_TERMS.some((t) => normalizedText.includes(t));
}

/**
 * 金額 pattern：幣符（$/HK$/HKD/港幣/港币/蚊/元）前後嘅數字，含範圍 $800-1200 / $800~1200 / $800至1200 兩邊各配一次。
 * 只收「同幣符綁埋」嘅數字 — 日期（2026年/5日）、時間、數量唔會誤判（deterministic）。
 * ① marker 後：$600 / HK$1500 / 500蚊？（蚊喺後見 ②）/ 600元 / $600–1200（範圍兩邊）
 * ② marker 前：500 蚊 / 500 $ / 1200 元
 */
const AMOUNT_AFTER_RE = /(?:HK\$|HKD|\$|港幣|港币|蚊|元)\s*(\d[\d,]*(?:\.\d+)?)(?:\s*[–—~至-]\s*(\d[\d,]*(?:\.\d+)?))?/g;
const AMOUNT_BEFORE_RE = /(?<![\d.\-–—~])(\d[\d,]*(?:\.\d+)?)\s*(?:蚊|HK\$|HKD|\$|元)/g;

/** 抽出草稿入面所有「金額數字」（無 → 空陣列）。範圍兩邊都抽。 */
export function extractAmounts(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const n = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  };
  for (const m of text.matchAll(AMOUNT_AFTER_RE)) push(m[1]), push(m[2]);
  for (const m of text.matchAll(AMOUNT_BEFORE_RE)) push(m[1]);
  return [...new Set(out)];
}

/** 無 PRICE doc / 金額被擋時嘅人手提示版（唔准報價 — MD F.4）。 */
export const NO_PRICE_TEXT = "呢項收費要幫你問返同事／到診評估先至準確，等我哋確認後即刻回覆你。";

export interface PriceGuardInput {
  /** 最終草稿（报价鏈決定性 draft 或 LLM draft；null = 無草稿） */
  draft: string | null;
  /** 檢索引用咗嘅 PRICE doc（stage 1 picked ∩ PRICE；無 = null） */
  priceDoc: CatalogDoc | null;
  /** 呢輪係唔係價錢意圖（trace 用） */
  priceIntent: boolean;
}

export interface PriceGuardResult {
  /** 入庫嘅最終 draft */
  draft: string;
  /** ①/③ 觸發（棄用原 draft 改人手版） */
  blocked: boolean;
  /** ② 觸發（自動 append disclaimer） */
  disclaimerAppended: boolean;
  /** ③ 觸發（金額出範圍） */
  outOfRange: boolean;
  /** blocked=true 時 needsHuman 要提升（人手提示版唔准自動發） */
  forceNeedsHuman: boolean;
}

/**
 * 報價決定性草稿（有 PRICE doc）：範圍 + 影響因素（body）+ disclaimer（code 強制）。
 * doc 冇 priceMin/Max → 唔出範圍（退人手提示版）。
 */
export function buildPriceDraft(doc: CatalogDoc): { text: string | null; rangeText: string } {
  if (doc.priceMin === null || doc.priceMax === null) {
    return { text: null, rangeText: "" };
  }
  const rangeText =
    doc.priceMin === doc.priceMax
      ? `大約 ${doc.priceMin} 元`
      : `大約 ${doc.priceMin}–${doc.priceMax} 元`;
  const body = doc.body && doc.body.trim() && doc.body.trim() !== "影響因素：" ? doc.body.trim() : "";
  const parts = [`「${doc.title}」嘅費用${rangeText}。`];
  if (body) parts.push(body);
  parts.push(doc.disclaimer ?? "");
  return { text: parts.join("\n"), rangeText };
}

/**
 * price-guard（3 條，deterministic）。入庫前必經。
 */
export function runPriceGuard(input: PriceGuardInput): PriceGuardResult {
  const { draft, priceDoc } = input;
  const result: PriceGuardResult = {
    draft: draft ?? "",
    blocked: false,
    disclaimerAppended: false,
    outOfRange: false,
    forceNeedsHuman: false,
  };
  if (!draft) return result;
  const amounts = extractAmounts(draft);

  // ③ 有 PRICE doc 且金額數字唔喺 [priceMin, priceMax] → 同 ①
  if (priceDoc && amounts.length > 0 && priceDoc.priceMin !== null && priceDoc.priceMax !== null) {
    const out = amounts.some((n) => n < priceDoc.priceMin! || n > priceDoc.priceMax!);
    if (out) {
      log.warn(
        { priceDoc: priceDoc.id, amounts, range: [priceDoc.priceMin, priceDoc.priceMax] },
        "price: out-of-range amount — 棄用草稿改人手提示版"
      );
      result.outOfRange = true;
      result.blocked = true;
      result.draft = NO_PRICE_TEXT;
      result.forceNeedsHuman = true;
      return result;
    }
  }

  // ① 有金額 pattern 但零 PRICE 引用 → 棄用（模型幻覺價）
  if (amounts.length > 0 && !priceDoc) {
    log.warn({ amounts }, "price: unsourced amount blocked");
    result.blocked = true;
    result.draft = NO_PRICE_TEXT;
    result.forceNeedsHuman = true;
    return result;
  }

  // ② 有 PRICE doc 且草稿實際含金額但缺 disclaimer → code 自動 append
  //   （只限「草稿有金額」— 非報價草稿就算 RAG 揀咗 PRICE doc 都唔好硬塞 disclaimer）
  if (priceDoc && priceDoc.disclaimer && amounts.length > 0 && !draft.includes(priceDoc.disclaimer)) {
    result.draft = `${draft}\n${priceDoc.disclaimer}`;
    result.disclaimerAppended = true;
  }
  return result;
}
