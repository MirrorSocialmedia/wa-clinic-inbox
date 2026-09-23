-- cwi-final S3-5（TOTP enroll/confirm 兩段式）：StaffUser 加 totpPendingEnc（一次性 migration）。
-- enroll 生成新 secret 先寫呢度（AES-256-GCM 密文，同 totpSecretEnc 格式，key = TOTP_ENC_KEY）；
-- confirm 驗過 code 先搬去 totpSecretEnc。NULL = 冇進行中 enroll。
ALTER TABLE "StaffUser" ADD COLUMN "totpPendingEnc" TEXT;
