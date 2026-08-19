/**
 * TOTP（RFC 6238）— ADMIN 兩步驟登入（安全審計 H-2）。
 *
 * 零外部依賴：node:crypto 直接實作 HMAC-SHA1 TOTP（otplib 等效）—
 * 縮少依賴面（M-7 審計焦點）。
 *
 * 參數（跟主流 authenticator app 預設）：
 * - 6 位數字
 * - 30 秒 period
 * - verify window ±1 step（容忍 30s 內嘅 clock skew）
 *
 * secret：20 bytes random → base32（32 字符，無 padding）。
 *
 * ★ PII/secret 鐵律：secret 只出現喺 enroll 回應（一次顯示）同 DB 密文欄 —
 *   任何 log 都唔准帶 secret / TOTP code。
 */
import crypto from "node:crypto";

const PERIOD_SEC = 30;
const DIGITS = 6;
const VERIFY_WINDOW = 1; // ±1 step

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 生成 20-byte random secret → base32（32 字符）。 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * 計算指定時間嘅 TOTP code（6 位數字字串）。
 * @param secretB32 base32 secret
 * @param timeMs epoch ms（測試可傳固定時間 — e2e 唔靠真時間漂）
 */
export function totpCode(secretB32: string, timeMs: number = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / PERIOD_SEC);
  const key = base32Decode(secretB32);
  // counter 做 8-byte big-endian
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  // dynamic truncation（RFC 4226 §5.4）
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * 驗證 TOTP code（window ±1 step）。
 * 比較用 timing-safe（constant-time，防 timing side channel）。
 */
export function verifyTotp(secretB32: string, code: string, timeMs: number = Date.now()): boolean {
  const normalized = String(code).trim();
  if (!/^\d{6}$/.test(normalized)) return false;
  for (let step = -VERIFY_WINDOW; step <= VERIFY_WINDOW; step++) {
    const expected = totpCode(secretB32, timeMs + step * PERIOD_SEC * 1000);
    if (timingSafeStringEqual(expected, normalized)) return true;
  }
  return false;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * otpauth:// URI（authenticator app 掃 QR / 手輸用）。
 * @param account 帳號顯示名（admin email — 只呈畀 admin 自己）
 */
export function otpauthUri(account: string, secretB32: string, issuer = "WA Clinic Inbox"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SEC}`;
}
