-- Phase 1 init migration (base schema from MD §4 + Phase 1 改動)
-- 1) pg_trgm: 中文 fuzzy 搜尋（Contact/Message 全文搜尋用）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('API', 'APP_ECHO', 'HISTORY');

-- CreateEnum
CREATE TYPE "ConvStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MsgStatus" AS ENUM ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PROPOSED', 'SENT_AS_IS', 'SENT_EDITED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "waPhoneNumberId" TEXT NOT NULL,
    "waDisplayNumber" TEXT NOT NULL,
    "apricotClinicId" TEXT,
    "greetingConfig" JSONB,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "clinicId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "profileName" TEXT,
    "labels" TEXT[],

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "ConvStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT,
    "intent" TEXT,
    "intentConfidence" DOUBLE PRECISION,
    "lastInboundAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "waMessageId" TEXT,
    "direction" "Direction" NOT NULL,
    "channel" "Channel" NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "mediaPath" TEXT,
    "status" "MsgStatus" NOT NULL,
    "errorCode" TEXT,
    "sentByStaffId" TEXT,
    "aiDraftId" TEXT,
    "waTimestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inReplyToMessageId" TEXT NOT NULL,
    "draftText" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PROPOSED',
    "finalText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "flowToken" TEXT NOT NULL,
    "providerApricotId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "requestedDate" TEXT NOT NULL,
    "requestedTime" TEXT NOT NULL,
    "precheckPassed" BOOLEAN NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "handledByStaffId" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySlot" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerApricotId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "bookedCount" INTEGER NOT NULL,
    "isOpen" BOOLEAN NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApricotSession" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "iatEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApricotSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "staffId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_code_key" ON "Clinic"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_waPhoneNumberId_key" ON "Clinic"("waPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_clinicId_waId_key" ON "Contact"("clinicId", "waId");

-- CreateIndex
CREATE INDEX "Conversation_clinicId_status_lastMessageAt_idx" ON "Conversation"("clinicId", "status", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_clinicId_contactId_key" ON "Conversation"("clinicId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_waMessageId_key" ON "Message"("waMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_waTimestamp_idx" ON "Message"("conversationId", "waTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_flowToken_key" ON "BookingRequest"("flowToken");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySlot_clinicId_providerApricotId_date_startTime_key" ON "AvailabilitySlot"("clinicId", "providerApricotId", "date", "startTime");

