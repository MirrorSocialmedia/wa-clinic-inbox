/**
 * TOTP secret 加密存儲（安全審計 H-2 配套）。
 *
 * 跟 repo 現行 encryption 模式（同 Flow key wrap 同一套）：
 * - AES-256-GCM，格式 `iv(12B)|tag(16B)|ciphertext` → base64
 * - key = env `TOTP_ENC_KEY`（32-byte base64，openssl rand -base64 32）
 *
 * 點解獨立 key 而唔係重用其他 data encryption key：
 * - TOTP secret 係核心認證資產（dump 咗 = admin 帳號永久可偽裝），
 *   數據側 key 洩漏時 rotation 唔應該連帶影響 auth 邊（同 SESSION_SECRET /
 *   MEDIA_ENC_KEY / FLOW_JWT_SECRET 一樣：每類敏感資產獨立 key）。
 *
 * Fail-closed：
 * - key 冇 / 格式壞 → throw（enroll 會 500；login 遇到有密文但解唔到 → 500 + alert，
 *   唔會靜默放行 — MFA 解唔到 = 拒入）。
 */
import crypto from "node:crypto";

function requireKey(): Buffer {
  const k = Buffer.from((process.env.TOTP_ENC_KEY ?? "").trim(), "base64");
  if (k.length !== 32) {
    throw new Error(
      "TOTP_ENC_KEY missing or not 32-byte base64 — generate: openssl rand -base64 32（TOTP secret 加密用）"
    );
  }
  return k;
}

export function encryptTotpSecret(plainB32: string): string {
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plainB32, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptTotpSecret(encB64: string): string {
  const key = requireKey();
  const raw = Buffer.from(encB64, "base64");
  if (raw.length < 28 + 1) throw new Error("totp secret: 密文長度壞");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
