-- 安全審計 H-2：ADMIN TOTP（RFC 6238）兩步驟登入
-- totpSecretEnc = AES-256-GCM 密文（iv|tag|ct base64，src/lib/totp-enc.ts，key = TOTP_ENC_KEY）
-- NULL = 未啟用（STAFF 永遠 NULL；ADMIN 啟用後非 NULL）

-- AlterTable
ALTER TABLE "StaffUser" ADD COLUMN "totpSecretEnc" TEXT;
