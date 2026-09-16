-- cwi-followup-p3-20260916（followup-v2 MD §4.2 逐字 + template registry + opt-out/salutation/followupRepliedAt）

-- CreateEnum
CREATE TYPE "FollowupTrigger" AS ENUM ('CONVERSATION_IDLE', 'BEFORE_APPOINTMENT', 'AFTER_NO_SHOW', 'OUTSTANDING_BALANCE', 'AFTER_TREATMENT', 'RECALL_NO_REPEAT', 'QUOTED_NOT_BOOKED');

-- CreateEnum
CREATE TYPE "FollowupLevel" AS ENUM ('L1', 'L2');

-- CreateEnum
CREATE TYPE "FollowupUnit" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "FollowupStatus" AS ENUM ('SCHEDULED', 'DUE', 'SENT', 'SKIPPED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "FollowupSource" AS ENUM ('RULE', 'MANUAL', 'INTERNAL_REMINDER');

-- CreateTable
CREATE TABLE "FollowupRule" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "FollowupTrigger" NOT NULL,
    "delayValue" INTEGER NOT NULL,
    "delayUnit" "FollowupUnit" NOT NULL,
    "reasonCodes" TEXT[],
    "minAmount" INTEGER,
    "templateName" TEXT NOT NULL,
    "level" "FollowupLevel" NOT NULL DEFAULT 'L1',
    "maxSends" INTEGER NOT NULL DEFAULT 1,
    "cancelOnReply" BOOLEAN NOT NULL DEFAULT true,
    "cancelOnBooking" BOOLEAN NOT NULL DEFAULT true,
    "cancelOnArrival" BOOLEAN NOT NULL DEFAULT true,
    "cancelOnResolved" BOOLEAN NOT NULL DEFAULT true,
    "cancelOnPaid" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowupRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowupTask" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "conversationId" TEXT,
    "patientApricotId" TEXT,
    "phoneHashes" TEXT[],
    "ruleId" TEXT,
    "source" "FollowupSource" NOT NULL DEFAULT 'RULE',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "FollowupStatus" NOT NULL DEFAULT 'SCHEDULED',
    "templateName" TEXT,
    "templateVars" JSONB,
    "contextJson" JSONB,
    "note" TEXT,
    "createdBy" TEXT,
    "handledBy" TEXT,
    "handledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "sentMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowupTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowupTemplate" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'zh_HK',
    "waTemplateName" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowupTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "FollowupRule_clinicId_enabled_idx" ON "FollowupRule"("clinicId", "enabled");

-- CreateIndex
CREATE INDEX "FollowupTask_clinicId_status_dueAt_idx" ON "FollowupTask"("clinicId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowupTask_conversationId_status_idx" ON "FollowupTask"("conversationId", "status");

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "followupOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "optOutAt" TIMESTAMP(3),
ADD COLUMN "optOutSource" TEXT,
ADD COLUMN "salutation" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "followupRepliedAt" TIMESTAMP(3);
