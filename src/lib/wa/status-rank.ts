/**
 * ★ cwi-final S1-1c（C-1③ / audit3 P1-06）— WA 訊息狀態單調性（純函數，client 可 import，零 prisma）。
 *
 * 問題（audit3 P1-06）：status webhook 冇單調性 — `read` 之後到 `delivered`（Meta 重送／亂序）
 * 會令 UI 倒退。呢度定義 rank 階層 + nextStatus 決策，worker（status-apply.ts）同 client
 * （inbox-client.tsx message:status handler）共用同一套規則。
 *
 * rank 階層（只升唔降）：
 *   QUEUED(0) → SENDING(1) / UNKNOWN(1) → SENT(2) → DELIVERED(3) → READ(4)
 *   - SENDING / UNKNOWN 預留俾 S1-15（condition-based update 之後嘅中間態）— 現行 STATUS_MAP
 *     唔會產出呢兩個值，但 rank 已位。
 *   - FAILED / CANCELLED 唔入 rank（終態，特別處理，見 nextStatus）。
 *
 * nextStatus(current, incoming) 決策表：
 *   - current === "CANCELLED"            → null（已撤銷嘅訊息唔再變 — 8 秒撤回窗口鐵律）
 *   - incoming === "FAILED"：
 *       current ∈ {DELIVERED, READ, FAILED} → null（已送出／已讀後嘅 failed = 亂序 stale，保守唔覆寫）
 *       其餘（QUEUED/SENDING/UNKNOWN/SENT）→ "FAILED"（UNKNOWN 收到 failed = 證實冇送出）
 *   - current === "FAILED"                → null（FAILED 之後嘅 sent 係亂序，保守唔覆寫）
 *   - 其餘：rank[incoming] > rank[current] → incoming，否則 null（同級／倒退 = no-op）
 */

export const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  UNKNOWN: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

/**
 * 單調決策：incoming 有冇辦法喺 current 之上。
 * @returns 應該寫入嘅新狀態；null = 唔改（倒退／同級／終態語義擋下）。
 */
export function nextStatus(current: string, incoming: string): string | null {
  if (current === "CANCELLED") return null;

  if (incoming === "FAILED") {
    // 已送出後嘅 failed = 亂序 stale（delivered/read 都證明送得出）→ 唔覆寫。
    if (current === "DELIVERED" || current === "READ" || current === "FAILED") return null;
    return "FAILED";
  }

  // FAILED 之後嘅 sent/delivered/read 全部係亂序 → 保守唔覆寫。
  if (current === "FAILED") return null;

  const cur = STATUS_RANK[current];
  const inc = STATUS_RANK[incoming];
  if (typeof cur !== "number" || typeof inc !== "number") return null;
  return inc > cur ? incoming : null;
}
