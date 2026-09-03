-- ★ Part F（cwi-raggolden-20260904，MD §Part F）：知識庫 RAG + GoldenCase 評測。
-- 零鎖表模式（跟 20260903084054_cwi_part_e_pain_triage）：plain CREATE TYPE/TABLE/INDEX +
-- ALTER TABLE ADD COLUMN（Postgres 11+ ADD COLUMN 唔做 full table rewrite — 新 nullable 欄唔阻 DML）。

-- CreateEnum
CREATE TYPE "KnowledgeKind" AS ENUM ('SERVICE', 'POST_OP', 'POLICY', 'PRICE', 'PREP', 'FAQ');

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "kind" "KnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL,
    "body" TEXT NOT NULL,
    "disclaimer" TEXT,
    "priceMin" INTEGER,
    "priceMax" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDoc_clinicId_enabled_idx" ON "KnowledgeDoc"("clinicId", "enabled");

-- CreateEnum
CREATE TYPE "GoldenSource" AS ENUM ('INBOX_BUTTON', 'HISTORY_SAMPLE', 'MANUAL');

-- CreateTable
CREATE TABLE "GoldenCase" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "source" "GoldenSource" NOT NULL,
    "utterance" TEXT NOT NULL,
    "contextBefore" TEXT[] NOT NULL,
    "expectIntent" TEXT NOT NULL,
    "expectRedFlag" BOOLEAN NOT NULL DEFAULT false,
    "expectAutoOk" BOOLEAN NOT NULL DEFAULT false,
    "expectDocIds" TEXT[] NOT NULL DEFAULT '{}',
    "note" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldenCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoldenCase_clinicId_enabled_idx" ON "GoldenCase"("clinicId", "enabled");

-- AlterTable：F.7 trace panel 數據源（ai.worker 每輪寫入；歷史 row null = 舊 draft）
ALTER TABLE "AiDraft" ADD COLUMN "traceJson" JSONB;
