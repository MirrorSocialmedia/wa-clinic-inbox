-- Phase 3：Apricot 空檔 + WhatsApp Flow 預約收集
-- Provider/ProviderClinic（醫生名錄 sync 表）+ FlowSession（Flow 狀態）
-- + ApricotSession 監控欄 + BookingRequest 隊列 index

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apricotId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderClinic" (
    "providerId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderClinic_pkey" PRIMARY KEY ("providerId","clinicId")
);

-- CreateTable
CREATE TABLE "FlowSession" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "flowToken" TEXT NOT NULL,
    "flowMessageWamid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ,
    CONSTRAINT "FlowSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Provider_apricotId_key" ON "Provider"("apricotId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowSession_flowToken_key" ON "FlowSession"("flowToken");

-- CreateIndex
CREATE INDEX "FlowSession_conversationId_status_idx" ON "FlowSession"("conversationId", "status");

-- CreateIndex
CREATE INDEX "FlowSession_status_createdAt_idx" ON "FlowSession"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_clinicId_status_createdAt_idx" ON "BookingRequest"("clinicId", "status", "createdAt");

-- AlterTable
ALTER TABLE "ApricotSession" ADD COLUMN     "lastSyncAt" TIMESTAMPTZ,
ADD COLUMN     "lastKeepaliveAt" TIMESTAMPTZ,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "rotationCount" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "ProviderClinic" ADD CONSTRAINT "ProviderClinic_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderClinic" ADD CONSTRAINT "ProviderClinic_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
