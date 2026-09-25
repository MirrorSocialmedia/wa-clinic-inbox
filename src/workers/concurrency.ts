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
 * ★ cwi-final S1-14：ai-urgent worker — 急症通道獨立 lane（concurrency 1 同 ai 一樣：
 *   per-conversation 順序保證；獨立 queue 使急症摘要唔排喺長 job 後面）。
 */
export const AI_URGENT_CONCURRENCY = 1;
/**
 * media worker：media 下載冇 per-conversation 順序依賴（獨立生命週期，
 * message row 先落 PENDING 先 enqueue），可以並行 — 3。
 */
export const MEDIA_CONCURRENCY = 3;

/**
 * ★ cwi-final S5-1（F1）：booking-write worker — createBooking 異步寫 Apricot。
 * concurrency 1：同店寫入嚴格串行（Apricot 冪等 key 已防重，但串行係更保守嘅口徑：
 * 單一寫入點 → outcome 明確；調大要連 F 側冪等 SLA 一併評審 — 同 R8 觸發條件一樣）。
 */
export const BOOKING_WRITE_CONCURRENCY = 1;
