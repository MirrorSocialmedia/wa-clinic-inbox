/**
 * unit-price-guard — price-guard 安全鏈 core：extractAmounts pure unit tests（審計 B-2）
 *
 * 範圍（零 DB / 零網絡 — 純 deterministic 邏輯）：
 *   extractAmounts 兩個 regex group 都必須覆蓋：
 *   - AMOUNT_AFTER_RE（幣符喺前：$600 / HK$1500 / HKD 2000 / 港幣800 / 範圍 $800-1200 兩邊）
 *   - AMOUNT_BEFORE_RE（幣符喺後：500蚊 / 600 元 / 500$）
 *   重點回歸：範圍第二邊（m[2]）必須抽出 — B-2 之前係 comma operator 單行，
 *   若被人「修」成只剩一個 push，$800-1200 只抽到 800 → 幻覺報價偵測漏一半。
 *
 * 用法（repo root）：pnpm test:unit-price-guard
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { extractAmounts, isPriceIntent } from "../src/lib/ai/price-guard";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sameSet = (a: number[], b: number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

// ── AMOUNT_AFTER_RE（幣符喺前）──────────────────────────────────────────
check("$600（基本）", sameSet(extractAmounts("$600"), [600]), JSON.stringify(extractAmounts("$600")));
check("HK$1500", sameSet(extractAmounts("HK$1500"), [1500]), JSON.stringify(extractAmounts("HK$1500")));
check("HKD 2000（空格）", sameSet(extractAmounts("HKD 2000"), [2000]), JSON.stringify(extractAmounts("HKD 2000")));
check("港幣800", sameSet(extractAmounts("港幣800"), [800]), JSON.stringify(extractAmounts("港幣800")));
check("範圍 $800-1200 兩邊（m[2] 必抽 — B-2 重點回歸）", sameSet(extractAmounts("$800-1200"), [800, 1200]), JSON.stringify(extractAmounts("$800-1200")));
check("範圍 $30000–60000（en-dash）", sameSet(extractAmounts("$30000–60000"), [30000, 60000]), JSON.stringify(extractAmounts("$30000–60000")));
check("範圍 $800~1200（波浪）", sameSet(extractAmounts("$800~1200"), [800, 1200]), JSON.stringify(extractAmounts("$800~1200")));
check("千分位 $1,234", sameSet(extractAmounts("$1,234"), [1234]), JSON.stringify(extractAmounts("$1,234")));

// ── AMOUNT_BEFORE_RE（幣符喺後）──────────────────────────────────────────
check("500蚊（幣符後 — BEFORE group）", sameSet(extractAmounts("500蚊"), [500]), JSON.stringify(extractAmounts("500蚊")));
check("600 元（空格）", sameSet(extractAmounts("600 元"), [600]), JSON.stringify(extractAmounts("600 元")));
check("500$", sameSet(extractAmounts("500$"), [500]), JSON.stringify(extractAmounts("500$")));

// ── 混合 / 去重 / 負例 ──────────────────────────────────────────────────
check("混合 $500 + 800蚊（兩 group 同抽）", sameSet(extractAmounts("$500 800蚊"), [500, 800]), JSON.stringify(extractAmounts("$500 800蚊")));
check("同額去重 $500 500蚊 → [500]", sameSet(extractAmounts("$500 500蚊"), [500]), JSON.stringify(extractAmounts("$500 500蚊")));
check("空字串 → []", extractAmounts("").length === 0);
check("日期 2026年12月15日 → []（唔誤判）", extractAmounts("2026年12月15日").length === 0, JSON.stringify(extractAmounts("2026年12月15日")));
check("時間/數量 3日 10:30 → []（唔誤判）", extractAmounts("3日 10:30").length === 0, JSON.stringify(extractAmounts("3日 10:30")));
check("純文字無金額 → []", extractAmounts("多謝查詢，歡迎到診").length === 0);

// ── isPriceIntent（觸發口徑 smoke）──────────────────────────────────────
check("isPriceIntent 幾錢 → true", isPriceIntent("箍牙幾錢") === true);
check("isPriceIntent 無關句 → false", isPriceIntent("我想問下時間") === false);
check("isPriceIntent 空 → false", isPriceIntent("") === false);

// ── summary ───────────────────────────────────────────────────────────

console.log(`\n${passes + failures} checks: ${passes} pass / ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);
