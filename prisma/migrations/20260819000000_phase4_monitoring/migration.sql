-- Phase 4：監控 + 營運硬化
-- 1) Clinic：webhook 最後事件時間（stale 監控）+ quality_rating 每日檢查欄
-- 2) Alert：健康自檢 / 監控警報（冪等：同 type+clinic 未解決只可一條 — 代碼層保障）
-- 3) OpsReport：週一自動營運報表（每週 × 每 scope 一列）

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN "lastWebhookEventAt" TIMESTAMPTZ;
ALTER TABLE "Clinic" ADD COLUMN "qualityRating" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "qualityCheckedAt" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "clinicId" TEXT,
    "clinicCode" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ,
    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_type_clinicId_resolvedAt_idx" ON "Alert"("type", "clinicId", "resolvedAt");
CREATE INDEX "Alert_resolvedAt_createdAt_idx" ON "Alert"("resolvedAt", "createdAt");

-- CreateTable
CREATE TABLE "OpsReport" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ NOT NULL,
    "periodEnd" TIMESTAMPTZ NOT NULL,
    "clinicId" TEXT NOT NULL DEFAULT '',
    "metrics" JSONB NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpsReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpsReport_periodStart_clinicId_key" ON "OpsReport"("periodStart", "clinicId");
CREATE INDEX "OpsReport_periodStart_idx" ON "OpsReport"("periodStart");
