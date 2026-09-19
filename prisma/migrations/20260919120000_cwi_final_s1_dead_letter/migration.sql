-- ★ cwi-final S1-1a：inbound job 最終失敗 dead-letter（DLQ）。
-- payloadEnc = AES-256-GCM 加密嘅 raw webhook event（同 media key：MEDIA_ENC_KEY）— log 零病人原文。
-- 重放 = scripts/replay-dead-letters.ts / admin 重放掣（WebhookEvent claim 冪等 → 重放安全）。
-- retention：30 日清（retention-purge step 5；守 S0-11 skipped gate）。
CREATE TABLE "DeadLetter" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobId" TEXT,
    "payloadEnc" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMP(3) WITH TIME ZONE,
    CONSTRAINT "DeadLetter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeadLetter_queue_replayedAt_idx" ON "DeadLetter"("queue", "replayedAt");
