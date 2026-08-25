-- AI Workflow Phase E（cwi-ai-20260825-t5）：學習迴路 + 成熟度儀表板 + 級別開關
-- SuggestionCard + AutomationStat 新表 + AiDraft.intent（per-draft intent 快照）。
-- 零 enum、零鎖表：兩條 CREATE TABLE + 一條 ADD COLUMN nullable。

-- AlterTable: AiDraft.intent — 統計要「當時」intent（Conversation.intent 係「最新」會漂移）。
-- nullable：歷史 row 留 null → 統計歸 UNKNOWN（唔 backfill）。
ALTER TABLE "AiDraft" ADD COLUMN "intent" TEXT;

-- CreateTable: SuggestionCard（學習迴路建議卡 — D-6 人審；evidence 全 scrub）
CREATE TABLE "SuggestionCard" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "SuggestionCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: review queue 排序（PROPOSED 先 + 時間）
CREATE INDEX "SuggestionCard_status_createdAt_idx" ON "SuggestionCard"("status", "createdAt");

-- CreateTable: AutomationStat（週統計；complaints/rollbacks 由即時路徑 increment）
CREATE TABLE "AutomationStat" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "draftCount" INTEGER NOT NULL DEFAULT 0,
    "adoptedAsIs" INTEGER NOT NULL DEFAULT 0,
    "adoptedEdited" INTEGER NOT NULL DEFAULT 0,
    "discarded" INTEGER NOT NULL DEFAULT 0,
    "autoSent" INTEGER NOT NULL DEFAULT 0,
    "complaints" INTEGER NOT NULL DEFAULT 0,
    "rollbacks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AutomationStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 每店每類每週唯一（upsert key）
CREATE UNIQUE INDEX "AutomationStat_clinicId_category_weekStart_key" ON "AutomationStat"("clinicId", "category", "weekStart");
