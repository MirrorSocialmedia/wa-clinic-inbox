/**
 * ★ cwi-final S4-4（audit3 P0-06）：Outbound Guards — 所有「非 engine 產生」嘅自動發文字必過。
 *
 * 入口原則（spec 逐字）：**唔再以 intent 做入口條件** — 任何要自動發出（auto-send）嘅草稿，
 * 只要唔係 session engine 決定性產生嘅事實句（candidate/confirm/handoff 等），一律過：
 *   ① runPriceGuard（幻覺價 / 出範圍 / 漏 disclaimer — 3 條 deterministic）
 *   ② runClaimGuard（CG-001~010 — 診斷/保證/療程/品牌/時段/術後窗）
 *   ③ TIME_CLAIM_NO_ENGINE：草稿含日期/時間宣告 但 無 backend slot（hasBackendSlot=false）
 *      → LLM 自行揀時間 = 幻覺時段（booking 時段只准 engine 用 workforce 真 slot 產生）。
 *
 * 接駁點：
 * - pipeline.ts blocks 段（free-form 草稿 — autoLevel !== L1 分支）→ blocks `guard:<code>`
 * - session-engine.ts buildReply（tone 文字 — engine 句之外嘅 LLM 語氣）→ 唔過只發 engine 句
 *
 * 純函數（零 IO）— 可單測（scripts/unit-outbound-guards.ts — T657 全 intent 清單 GoldenCase）。
 */
import { runPriceGuard, type PriceGuardInput } from "@/lib/ai/price-guard";
import { runClaimGuard, type ClaimGuardInput } from "@/lib/ai/claim-guard";

/**
 * 日期/時間宣告 pattern（deterministic）：
 * - 24h 時分：15:00 / 3：30（全角冒號）
 * - 上下午 + 數：下午3 / 早上 9
 * - 早晏夜 + 數：早9 / 夜11
 * - 星期/禮拜 一~日/天
 * - 聽日 / 後日
 * - 月日：9月1日 / 12 月 25 號
 */
const TIME_CLAIM_RE =
  /(\d{1,2}[:：]\d{2}|[上下]午\s*\d|[早晏夜]晨?\s*\d|星期[一二三四五六日天]|禮拜[一二三四五六日天]|聽日|後日|\d{1,2}\s*月\s*\d{1,2}\s*[日號])/;

export interface GuardVerdict {
  ok: boolean;
  /** 全部命中 code（PRICE / CG-00x / TIME_CLAIM_NO_ENGINE）— trace + blocks 用 */
  codes: string[];
  /** price-guard 處理後嘅草稿（block → NO_PRICE_TEXT；disclaimer append 後版本） */
  draft: string;
}

/**
 * ★ cwi-final S4-4：所有「非 engine 產生」嘅自動發文字必過（唔再以 intent 做入口條件）。
 *
 * @param input.draft 最終草稿（唔係 engine 決定性句子）
 * @param input.priceDoc 本輪引用嘅 PRICE doc（null = 零引用）
 * @param input.priceIntent 本輪係咪價錢意圖（price-guard trace 用）
 * @param input.hasBackendSlot 有冇 workforce 真 slot（free-form 永遠 false；booking engine 句唔入呢度）
 * @param input.claimInput CG 入參（products 冇 consult 傳 []；priceDoc 同上面同源）
 */
export function runOutboundGuards(input: {
  draft: string;
  priceDoc: PriceGuardInput["priceDoc"];
  priceIntent: boolean;
  hasBackendSlot: boolean;
  claimInput: Omit<ClaimGuardInput, "draft" | "hasBackendSlot">;
}): GuardVerdict {
  const codes: string[] = [];
  const pg = runPriceGuard({ draft: input.draft, priceDoc: input.priceDoc, priceIntent: input.priceIntent });
  if (pg.blocked) codes.push("PRICE");
  const cg = runClaimGuard({ ...input.claimInput, draft: pg.draft, hasBackendSlot: input.hasBackendSlot } as ClaimGuardInput);
  if (cg.blocked) codes.push(...(cg.codes ?? ["CLAIM"]));
  if (!input.hasBackendSlot && TIME_CLAIM_RE.test(pg.draft)) codes.push("TIME_CLAIM_NO_ENGINE");
  return { ok: codes.length === 0, codes, draft: pg.draft };
}
