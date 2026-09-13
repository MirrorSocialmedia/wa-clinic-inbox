/**
 * ★ cwi-reopenreply-20260910（T84 決策 (b) 收窄版）：翻開後首句（reopenedFirstReply）閘。
 *
 * 老細拍板（2026-09-10）：RESOLVED 對話翻開後嘅**首句**覆 → 唔 auto-send、出草稿，
 * **除非同時滿足三條件**（齊 = 當普通新對話，照正常 auto）：
 *   ① intent === QUESTION（其餘 intent — BOOKING_REQUEST / PAIN / COMPLAINT /
 *      URGENT_PAIN / OUT_OF_SCOPE / OTHER — 一律 block）
 *   ② 距離上次解決 > 7 日（now - lastResolvedAt > 7d）
 *   ③ 訊息唔含不滿訊號（見 REOPEN_COMPLAINT_SIGNALS）
 * 任一條件唔中 → 强制 DRAFT（PROPOSED 草稿照出、唔 auto-send；trace reasons += reopenedFirstReply）。
 *
 * **首句判斷**（brief 公式）：
 *   `reopenedAt != null && (lastOutboundAt == null || lastOutboundAt <= reopenedAt)`
 * = 翻開後未發過任何 OUT（病人未收到過覆）。lastOutboundAt 由 outbound.worker SENT 成功
 *   路徑即時維護（touchConv 唯一 call site；另有 APP_ECHO 回音 + batch OUT sync）→
 *   首句真正發出後，第二句起 `lastOutboundAt > reopenedAt` → 閘自然失效，完全正常級別。
 *
 * **lastResolvedAt 數據源**（T2 cwi-statusrole2 翻開四聯動會清 resolvedAt — 實核 2026-09-10：
 * inbound.worker touchConversation reopen 分支 `resolvedAt = CASE WHEN RESOLVED THEN NULL`）：
 *   1. `conv.resolvedAt`（若未 null — 防禦性；翻開後實際恒 null）
 *   2. 否則：最新 auto-resolve INTERNAL 備註（body 前綴 = AUTO_RESOLVE_NOTE_PREFIX、
 *      OUT/INTERNAL/note、`waTimestamp <= reopenedAt`）— auto-resolve 每單必然同 tx 落呢條備註
 *   3. 仍無 = null → 條件②唔中 → DRAFT（保守方向 = 「任一條唔中出草稿」）
 *   ⚠ 已知邊界：手動 resolve（PATCH status）從未寫 resolvedAt、無 audit、無備註 → 不可導出
 *      → 手動解決嘅對話翻開首句恒 DRAFT — 安全方向（寧願多草稿唔寧願亂 auto），記錄為決策。
 *
 * PII：本檔只有詞表/常數 + 純函數；raw/canonical 文字只喺 memory 內比對，唔入 log / DB。
 */

/** auto-resolve INTERNAL 備註 body 前綴（單一來源 — auto-resolve.ts 用呢個前綴組備註）。 */
export const AUTO_RESOLVE_NOTE_PREFIX = "系統自動標記已解決";

/**
 * ③ 不滿訊號詞（T84 (b) — 2026-09-13 consult-audit §4 D-1 拍板清單 = 5 詞，cwi-consult-d1 補齊「之前講過」）。
 * **可擴展**：新增詞 = 擴 block 範圍。
 * 比對慣例跟 repo lexicon 做法：raw ∨ canonical（applyLexicon 後）雙比對，
 * 大小寫不敏感（lowercase 後 includes；詞本身純中文，case 只影響英文夾雜文字），
 * 標點天然容忍（substring 匹配，唔要求詞邊界）。
 */
export const REOPEN_COMPLAINT_SIGNALS = ["上次", "點解", "仲未", "都話咗", "之前講過"] as const;

/** ② 距上次解決需 **嚴格大過** 呢個日數先准 auto（= 7 日）。 */
export const REOPEN_AUTO_REPLY_MIN_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** 翻開後首句 = 翻開後未發過任何 OUT 俾病人（brief 公式；time 欄接受 Date|string）。 */
export function isReopenedFirstReply(conv: {
  reopenedAt: Date | string | null;
  lastOutboundAt: Date | string | null;
}): boolean {
  if (conv.reopenedAt == null) return false;
  if (conv.lastOutboundAt == null) return true;
  return new Date(conv.lastOutboundAt).getTime() <= new Date(conv.reopenedAt).getTime();
}

/** ③ raw ∨ canonical 任一分支命中訊號詞即回 true。 */
export function hasComplaintSignal(raw: string | null, canonical?: string | null): boolean {
  if (!raw) return false;
  const haystacks: string[] = [raw.toLowerCase()];
  if (canonical) haystacks.push(canonical.toLowerCase());
  return REOPEN_COMPLAINT_SIGNALS.some((s) => haystacks.some((h) => h.includes(s)));
}

/**
 * 三條件決策（純函數 — worker 層調）。齊 → safe（照正常 auto）；任一唔中 → block。
 * @param lastResolvedAt 「翻開前最後一次解決時間」由 caller 導出（見檔頭數據源）；null = 不可導出 → ② 唔中
 * @param now 可注入（測試用）
 */
export function isReopenedFirstReplySafe(input: {
  intent: string;
  lastResolvedAt: Date | string | null;
  raw: string | null;
  canonical?: string | null;
  now?: Date;
}): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  // ① QUESTION 以外一律 block
  if (input.intent !== "QUESTION") reasons.push("intent");
  // ② 距上次解決 > 7 日（strict >；unknown = 唔中）
  const t = (input.now ?? new Date()).getTime();
  if (input.lastResolvedAt == null) {
    reasons.push("age-unknown");
  } else if (t - new Date(input.lastResolvedAt).getTime() <= REOPEN_AUTO_REPLY_MIN_DAYS * MS_PER_DAY) {
    reasons.push("age");
  }
  // ③ 唔含不滿訊號
  if (hasComplaintSignal(input.raw, input.canonical)) reasons.push("signal");
  return { safe: reasons.length === 0, reasons };
}
