-- ★ consult v2.1 C5（cwi-consult-20260910b，MD §8.1 Tab 2/3）：純加法 migration（deploy-safe，零 data mutation）。
-- ConsultSetting — UI 參數 key-value 表（clinicId null = 全局；shape 由 application 層 zod 定義）。
-- 注意：clinicId nullable + @@unique 喺 Postgres 下 NULL 唔受約束（同 ConsultProduct 口徑）—
--   global row 唯一性由 C5 API find-first 守衛（唔靠 DB constraint）。

-- CreateTable
CREATE TABLE "ConsultSetting" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsultSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsultSetting_clinicId_key_key" ON "ConsultSetting"("clinicId", "key");
