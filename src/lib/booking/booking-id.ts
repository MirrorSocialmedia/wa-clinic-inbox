/**
 * ★ cwi-final S5-6（F1）：booking confirm 冪等 id（uuidv5）— 零第三方依賴（node:crypto 實作）。
 *
 * RFC 9562 §5.2（UUIDv5 = SHA-1 命名空間變體）：
 *   hash = SHA-1(nsBytes(16) ‖ nameBytes)；取前 16 bytes；set version=5 + variant=10。
 * 用途：confirm 雙擊/並發 — 同 booking + 同 idemAttempt → 恒等 clientMessageId，
 *   Message.clientMessageId @unique（Realtime P0，:475）物理擋第二條確認訊息。
 * 交叉驗證（獨立純手算實作 sha1(ns‖name) 前 16B + 位元設定）：
 *   uuidv5("example.org", "6ba7b811-9dad-11d1-80b4-00c04fd430c8") = "54a35416-963c-5dd6-a1e2-5ab7bb5bafc7"
 *   （注意：部分 Python build 嘅 uuid.NAMESPACE_DNS 常量帶 typo（…b810），唔可當 reference — 用 RFC 字面值。）
 */
import { createHash } from "node:crypto";

/** uuidv5 namespace（booking-confirm 專用）— v4 隨機生成一次，commit 做常量（唔可再改）。 */
export const BOOKING_CONFIRM_NS = "671bdf71-1762-4423-ba6e-e40fc157c829";

/**
 * RFC 9562 §5.2 UUIDv5（SHA-1）。ns 必須係 UUID 字串（連/唔連 hyphen 都得）。
 * 輸入非法 ns → throw（fail-closed — 唔好静默退化去亂冪等）。
 */
export function uuidv5(name: string, ns: string): string {
  const nsHex = ns.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(nsHex)) {
    throw new Error(`uuidv5: 非法 namespace UUID: ${ns}`);
  }
  const nsBytes = Buffer.from(nsHex, "hex");
  if (nsBytes.length !== 16) throw new Error(`uuidv5: namespace 要 16 bytes: ${ns}`);
  const h = createHash("sha1").update(nsBytes).update(name, "utf8").digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * S5-6：confirm 訊息 clientMessageId（staff 三掣「已人手落單」+ worker CONFIRMED 自動訊息共用）。
 * 同 booking + 同 idemAttempt → 恒等值；uuid 形式（clientMessageId 欄位校驗 = uuid 字串 — 見 Realtime P0 慣例）。
 */
export function bookingConfirmClientMessageId(bookingId: string, idemAttempt: number): string {
  return uuidv5(`booking-confirm:${bookingId}:${idemAttempt}`, BOOKING_CONFIRM_NS);
}
