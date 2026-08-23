/**
 * ★ Realtime P0 (R4, cwi-rt-20260823-a1) — worker concurrency 單一事實來源。
 *
 * ★ 唔准調大 — per-conversation ordering 靠佢（inbound/outbound/ai 三個 worker
 *   必須 concurrency = 1：BullMQ FIFO + 單 PM2 process → 同對話嚴格順序）。
 *   要 scale 先實施 group-by-conversationId（見 realtime MD R8 觸發條件）。
 *
 * drift guard：scripts/ordering-drift-guard.ts（pnpm test:ordering）斷言呢度嘅值
 *   + 三個 worker 嘅 Worker options 真的用咗呢啲常數。改咗常數/改返硬編碼 → CI 紅。
 */

/** inbound worker：per-conversation 順序保證 — 永遠 1。 */
export const INBOUND_CONCURRENCY = 1;
/** outbound worker：per-conversation 順序保證（发送链）— 永远 1。 */
export const OUTBOUND_CONCURRENCY = 1;
/** ai worker：context 讀 DB 時同對話必須已 settle — 永遠 1。 */
export const AI_CONCURRENCY = 1;
/**
 * media worker：media 下載冇 per-conversation 順序依賴（獨立生命週期，
 * message row 先落 PENDING 先 enqueue），可以並行 — 3。
 */
export const MEDIA_CONCURRENCY = 3;
