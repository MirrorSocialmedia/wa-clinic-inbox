/**
 * unit-phone-hash — cwi-followup-p0-20260915（MD §1.2）：W 側多號 E.164 hash unit tests
 *
 * 範圍：
 *   P1 8 位本地號 / 852-11 / +852 / 其他國家 → E.164
 *   P2 多號分隔符（space / , / ; / 、 / /）+ 去重（本地 8 位 vs 852-11 同一 E.164）
 *   P3 唔合法 → 丟（5 位、8 位 1/0 開頭、含空格片段）
 *   P4 空值 → []
 *   P5 ★ 跨 repo 對齊：與 CWM src/lib/phone.test.ts 同一 pinned vectors
 *      （同 key `phone-test-key-fup0-0123456789abcdef` → 同 hash）
 *      — 改任何一邊算法/vectors 必改兩邊（MD §1.2 原始電話唔過界 → 兩邊各一份）
 *   P6 PII：hash 輸出永唔含原始電話字串
 *
 * 純函數（唔落 DB、唔要 env key — 顯式傳 key）。
 * 用法（repo root）：pnpm tsx scripts/unit-phone-hash.ts
 * 退出碼：0 = 全過；1 = 有 fail。
 */

import { normalizeHkPhones, phoneHashes, phoneHash, normalizePhone } from "../src/lib/phone-hash";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ★ 同 CWM src/lib/phone.test.ts（cross-repo parity 錨點）
const KEY = "phone-test-key-fup0-0123456789abcdef";
const H_PLUS852_9123 = "3f2b21b65d326ef050ad31a6f2acf099dff8b2e3aa9b8624fb77d32dc9fe094b"; // +85291234567
const H_PLUS852_6123 = "5f3a32e797caf75bb44877935fa53b6b1973a80fa7619215d856c353df9a0291"; // +85261234567
const H_PLUS852_2312 = "4d8318b66d69df7636a35e06e17534bc3c5cbf5a1df7d67a50b8de44675a00b1"; // +85223123456

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main(): void {
  // ── P1 單一號碼 → E.164 ───────────────────────────────────────────
  check("P1 8 位本地 9x → +852", eq(normalizeHkPhones("91234567"), ["+85291234567"]));
  check("P1 8 位本地 6x → +852", eq(normalizeHkPhones("61234567"), ["+85261234567"]));
  check("P1 8 位本地 2x → +852", eq(normalizeHkPhones("23123456"), ["+85223123456"]));
  check("P1 852-11（無 +）→ +852", eq(normalizeHkPhones("85291234567"), ["+85291234567"]));
  check("P1 +852 原樣", eq(normalizeHkPhones("+85291234567"), ["+85291234567"]));
  check("P1 其他國家 +65 保留", eq(normalizeHkPhones("+6591234567"), ["+6591234567"]));

  // ── P2 多號 + 去重 ────────────────────────────────────────────────
  check("P2 space 分隔", eq(normalizeHkPhones("85291234567 61234567"), ["+85291234567", "+85261234567"]));
  check("P2 comma 分隔", eq(normalizeHkPhones("85291234567,61234567"), ["+85291234567", "+85261234567"]));
  check("P2 semicolon 分隔", eq(normalizeHkPhones("91234567;61234567"), ["+85291234567", "+85261234567"]));
  check("P2 、分隔", eq(normalizeHkPhones("91234567、61234567"), ["+85291234567", "+85261234567"]));
  check("P2 / 分隔", eq(normalizeHkPhones("91234567/61234567"), ["+85291234567", "+85261234567"]));
  check("P2 重複 → 去重", eq(normalizeHkPhones("91234567 / 91234567"), ["+85291234567"]));
  check("P2 本地 8 位 vs 852-11 → 同一 E.164", eq(normalizeHkPhones("91234567,85291234567"), ["+85291234567"]));
  check("P2 +852 vs 本地 8 位 → 去重", eq(normalizeHkPhones("+85291234567 91234567"), ["+85291234567"]));

  // ── P3 唔合法 → 丟 ────────────────────────────────────────────────
  check("P3 5 位 → 丟", eq(normalizeHkPhones("91234"), []));
  check("P3 8 位 1 開頭 → 丟", eq(normalizeHkPhones("12345678"), []));
  check("P3 8 位 0 開頭 → 丟", eq(normalizeHkPhones("01234567"), []));
  check("P3 內含空格片段 → 全丟（spec 行為 — 空格係分隔符）", eq(normalizeHkPhones("9123 4567 / 6123 4567"), []));
  check("P3 混合：1 個合法 + 1 個唔合法 → 只留合法", eq(normalizeHkPhones("91234567 12345"), ["+85291234567"]));

  // ── P4 空值 ───────────────────────────────────────────────────────
  check("P4 null → []", eq(normalizeHkPhones(null), []));
  check("P4 undefined → []", eq(normalizeHkPhones(undefined), []));
  check("P4 空字串 → []", eq(normalizeHkPhones(""), []));
  check("P4 純分隔符 → []", eq(normalizeHkPhones(" / ,;、 "), []));

  // ── P5 跨 repo parity（同 CWM pinned vectors）────────────────────
  check("P5 phoneHashes(91234567) = CWM H_PLUS852_9123", eq(phoneHashes("91234567", KEY), [H_PLUS852_9123]));
  check("P5 phoneHashes(+85291234567) 同 E.164 → 同 hash", eq(phoneHashes("+85291234567", KEY), [H_PLUS852_9123]));
  check("P5 phoneHashes(85291234567) 同 E.164 → 同 hash", eq(phoneHashes("85291234567", KEY), [H_PLUS852_9123]));
  check("P5 多號 → 多 hash（順序保留）", eq(phoneHashes("91234567;61234567", KEY), [H_PLUS852_9123, H_PLUS852_6123]));
  check("P5 23123456 → H_PLUS852_2312", eq(phoneHashes("23123456", KEY), [H_PLUS852_2312]));
  check("P5 確定性（兩次同值）", eq(phoneHashes("91234567", KEY), phoneHashes("91234567", KEY)));

  // ── P6 PII：hash 唔含原始電話 ─────────────────────────────────────
  const raw = "91234567,61234567";
  const hashes = phoneHashes(raw, KEY);
  check("P6 所有 hash 64-hex", hashes.length === 2 && hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), JSON.stringify(hashes));
  check("P6 hash 字串唔含原始電話片段", hashes.every((h) => !h.includes("91234567") && !h.includes("61234567")));

  // ── 舊 phoneHash 行為保留（P0 唔變 — 8 位 format）────────────────
  process.env.PHONE_HASH_KEY = KEY;
  check("舊 normalizePhone(91234567) = 8 位", normalizePhone("91234567") === "91234567");
  check("舊 phoneHash = 64-hex（8 位 format）", /^[0-9a-f]{64}$/.test(phoneHash("91234567")));
  check("舊 format ≠ 新 format（記錄兩 format 差異 — P1 遷移時留意）", phoneHash("91234567") !== H_PLUS852_9123);
}

main();
console.log(`\n[unit-phone-hash] ${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
