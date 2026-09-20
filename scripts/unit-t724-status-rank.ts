/**
 * T724 — cwi-final S1-1c（C-1③ / audit3 P1-06）nextStatus 真值表 pure unit test（零 DB / 零網絡）。
 *
 * 範圍：STATUS_RANK 值 + nextStatus 全 32 格（
 *   current ∈ {QUEUED, SENDING, UNKNOWN, SENT, DELIVERED, READ, FAILED, CANCELLED}
 *   × incoming ∈ {SENT, DELIVERED, READ, FAILED}）
 *
 * 期望語義（施工單 spec）：
 *   - 只升唔降：rank[incoming] > rank[current] → incoming，否則 null（同級／倒退 no-op）
 *   - current === CANCELLED → 恆 null（撤回終態）
 *   - incoming === FAILED：current ∈ {DELIVERED, READ, FAILED} → null（stale）；其餘 → FAILED
 *   - current === FAILED → 恆 null（FAILED 之後嘅 sent 係亂序，保守唔覆寫）
 *
 * 用法（repo root）：pnpm test:unit-t724
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { STATUS_RANK, nextStatus } from "../src/lib/wa/status-rank";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── [1] STATUS_RANK 值（SENDING/UNKNOWN 預留俾 S1-15）────────────────
console.log("\n[1] STATUS_RANK");
check("QUEUED=0", STATUS_RANK.QUEUED === 0);
check("SENDING=1", STATUS_RANK.SENDING === 1);
check("UNKNOWN=1（同 SENDING 一層）", STATUS_RANK.UNKNOWN === 1);
check("SENT=2", STATUS_RANK.SENT === 2);
check("DELIVERED=3", STATUS_RANK.DELIVERED === 3);
check("READ=4", STATUS_RANK.READ === 4);
check("FAILED 唔入 rank（終態特別處理）", !("FAILED" in STATUS_RANK));
check("CANCELLED 唔入 rank（終態特別處理）", !("CANCELLED" in STATUS_RANK));

// ── [2] nextStatus 真值表 8 × 4 = 32 格 ──────────────────────────────
console.log("\n[2] nextStatus 真值表（32 格）");
const CURRENTS = ["QUEUED", "SENDING", "UNKNOWN", "SENT", "DELIVERED", "READ", "FAILED", "CANCELLED"];
const INCOMINGS = ["SENT", "DELIVERED", "READ", "FAILED"];
const NULL = null;

// expected[incoming] per current
const EXPECTED: Record<string, Record<string, string | null>> = {
  QUEUED: { SENT: "SENT", DELIVERED: "DELIVERED", READ: "READ", FAILED: "FAILED" },
  SENDING: { SENT: "SENT", DELIVERED: "DELIVERED", READ: "READ", FAILED: "FAILED" },
  UNKNOWN: { SENT: "SENT", DELIVERED: "DELIVERED", READ: "READ", FAILED: "FAILED" }, // failed = 證實冇送出
  SENT: { SENT: NULL, DELIVERED: "DELIVERED", READ: "READ", FAILED: "FAILED" },
  DELIVERED: { SENT: NULL, DELIVERED: NULL, READ: "READ", FAILED: NULL },
  READ: { SENT: NULL, DELIVERED: NULL, READ: NULL, FAILED: NULL }, // 倒退全擋
  FAILED: { SENT: NULL, DELIVERED: NULL, READ: NULL, FAILED: NULL }, // FAILED 之後全係亂序
  CANCELLED: { SENT: NULL, DELIVERED: NULL, READ: NULL, FAILED: NULL }, // 撤回終態
};

for (const cur of CURRENTS) {
  for (const inc of INCOMINGS) {
    const expected = EXPECTED[cur][inc];
    const actual = nextStatus(cur, inc);
    check(
      `nextStatus(${cur}, ${inc}) = ${expected === null ? "null" : `"${expected}"`}`,
      actual === expected,
      `actual=${actual === null ? "null" : `"${actual}"`}`,
    );
  }
}

// ── [3] 額外邊界（超出 32 格嘅輸入 — defensive）──────────────────────
console.log("\n[3] 額外邊界");
check("未知 current → null（冇 rank）", nextStatus("BOGUS", "READ") === null);
check("未知 incoming → null（冇 rank）", nextStatus("QUEUED", "BOGUS") === null);
check("nextStatus(QUEUED, RECEIVED)=null（RECEIVED 唔入 rank）", nextStatus("QUEUED", "RECEIVED") === null);

console.log(`\nT724: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
