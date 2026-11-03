-- ★ cwi-sales-20261028：銷售系統第 1 期（銷售人員勾選、保護期／綁定、預約綁定、對話轉交、意向分級）
-- PII：只存 Apricot 病人／預約 id 同員工 id — 零姓名電話。

CREATE TYPE "SalesOwnershipState" AS ENUM ('PROTECTED', 'BOUND', 'POOL');

ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'SALES_PROTECTION';
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'SALES_HANDOVER';
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'SALES_UNANSWERED';

ALTER TABLE "StaffUser" ADD COLUMN "isSales" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "salesApricotUserId" TEXT,
ADD COLUMN "salesApricotUserName" TEXT,
ADD COLUMN "workforceEmployeeId" TEXT,
ADD COLUMN "workforceEmployeeName" TEXT;
CREATE UNIQUE INDEX "StaffUser_salesApricotUserId_key" ON "StaffUser"("salesApricotUserId");
CREATE UNIQUE INDEX "StaffUser_workforceEmployeeId_key" ON "StaffUser"("workforceEmployeeId");

ALTER TABLE "Conversation" ADD COLUMN "salesIntent" VARCHAR(8),
ADD COLUMN "salesIntentAt" TIMESTAMPTZ,
ADD COLUMN "salesIntentByStaffId" TEXT,
ADD COLUMN "salesUnansweredNotifiedAt" TIMESTAMPTZ;

CREATE TABLE "SalesSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "protectionDays" INTEGER NOT NULL DEFAULT 7,
    "highValueProtectionDays" INTEGER NOT NULL DEFAULT 14,
    "maxDaysAhead" INTEGER NOT NULL DEFAULT 30,
    "cycleCap" INTEGER NOT NULL DEFAULT 3,
    "noShowCap" INTEGER NOT NULL DEFAULT 2,
    "concurrentCap" INTEGER NOT NULL DEFAULT 30,
    "boundAutoReleaseMonths" INTEGER NOT NULL DEFAULT 24,
    "unansweredNotifyMinutes" INTEGER NOT NULL DEFAULT 30,
    "notifyWindowStart" VARCHAR(5) NOT NULL DEFAULT '09:00',
    "notifyWindowEnd" VARCHAR(5) NOT NULL DEFAULT '21:00',
    "intentLabels" TEXT[] DEFAULT ARRAY['高', '中', '低']::TEXT[],
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "updatedByStaffId" TEXT,
    CONSTRAINT "SalesSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesOwnership" (
    "id" TEXT NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "state" "SalesOwnershipState" NOT NULL,
    "salesStaffId" TEXT,
    "lastSalesStaffId" TEXT,
    "protectedUntil" TIMESTAMPTZ,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "noShowStreak" INTEGER NOT NULL DEFAULT 0,
    "lastApptId" TEXT,
    "lastApptDate" VARCHAR(10),
    "clinicId" TEXT,
    "since" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "SalesOwnership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesOwnership_patientApricotId_key" ON "SalesOwnership"("patientApricotId");
CREATE INDEX "SalesOwnership_salesStaffId_state_idx" ON "SalesOwnership"("salesStaffId", "state");
CREATE INDEX "SalesOwnership_state_protectedUntil_idx" ON "SalesOwnership"("state", "protectedUntil");

CREATE TABLE "SalesBooking" (
    "id" TEXT NOT NULL,
    "apricotApptId" TEXT NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "salesStaffId" TEXT,
    "conversationId" TEXT,
    "clinicId" TEXT,
    "apptDate" VARCHAR(10) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "outcome" VARCHAR(24) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesBooking_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesBooking_apricotApptId_key" ON "SalesBooking"("apricotApptId");
CREATE INDEX "SalesBooking_patientApricotId_createdAt_idx" ON "SalesBooking"("patientApricotId", "createdAt");
CREATE INDEX "SalesBooking_salesStaffId_createdAt_idx" ON "SalesBooking"("salesStaffId", "createdAt");

CREATE TABLE "SalesDelegation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "toStaffId" TEXT NOT NULL,
    "byStaffId" TEXT NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(200),
    "expiresAt" TIMESTAMPTZ,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDelegation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SalesDelegation_conversationId_revokedAt_idx" ON "SalesDelegation"("conversationId", "revokedAt");
CREATE INDEX "SalesDelegation_toStaffId_revokedAt_idx" ON "SalesDelegation"("toStaffId", "revokedAt");
