-- ★ cwi-final S5-1/S5-6（F1）：BookingRequest async 寫入狀態機（booking-write worker，concurrency 1）
-- writeState: null（從未寫/寫完）| WRITING | UNKNOWN（timeout/結果未知）| FAILED（確定性失敗，writeError=code）
-- idemAttempt: 冪等試次（同 booking 重試 = 同 idempotency key / 同 clientMessageId uuidv5）

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN "writeState" VARCHAR(16);
ALTER TABLE "BookingRequest" ADD COLUMN "writeAttemptAt" TIMESTAMPTZ(3);
ALTER TABLE "BookingRequest" ADD COLUMN "idemAttempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingRequest" ADD COLUMN "writeError" VARCHAR(64);
