-- cwi-roster-20261001：醫生名錄自動同步（workforce → inbox）
--
-- Provider.sourceProviderId = workforce Provider.id（可空，向後兼容）：
--   同一醫生喺唔同 Apricot 帳號會有多行（每帳號一個 apricotId），用呢欄認返同一個人
--   （顯示／報表合併用；null = workforce 未綁或者 seed 行）。
--   唔改 apricotId @unique、唔改 ProviderClinic 結構 —— 「一個 apricotId 一行 Provider」維持。
--
-- ProviderSyncRun = 同步運行記錄（同 CompanySyncRun 口徑 — 每鐘 :20 cron + 手動「立即同步醫生名錄」共用）。
--
-- 零回填：舊 row 全部 null。

ALTER TABLE "Provider" ADD COLUMN "sourceProviderId" TEXT;

CREATE INDEX "Provider_sourceProviderId_idx" ON "Provider"("sourceProviderId");

CREATE TABLE "ProviderSyncRun" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "ProviderSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderSyncRun_runAt_idx" ON "ProviderSyncRun"("runAt");
