-- cwi-final S6-3②（audit3 P1-21）+ S6-4：mediaKey unique + TelemetryCounter
-- 建前已跑 scripts/s6-mediakey-dupcheck.ts pre（3 項全 0 — 2026-09-27 HK）

-- 1) Message.mediaKey：/api/media/[file] findUnique 查詢鍵（Index Scan）
ALTER TABLE "Message" ADD COLUMN "mediaKey" TEXT;

-- backfill：basename(mediaPath)（同一 migration 內完成，atomic）
UPDATE "Message" SET "mediaKey" = regexp_replace("mediaPath", '^.*/', '') WHERE "mediaPath" IS NOT NULL;

CREATE UNIQUE INDEX "Message_mediaKey_key" ON "Message"("mediaKey");

-- 2) TelemetryCounter：client 回報指標計數器（只計數、零 PII）
--    "listTruncated"（S1-2 列表截斷 banner — S6-6 分區觸發觀察）
--    "pendingStatusDropped"（S1-1c sweep 24h 死行 drop 累計）
CREATE TABLE "TelemetryCounter" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "TelemetryCounter_pkey" PRIMARY KEY ("key")
);
