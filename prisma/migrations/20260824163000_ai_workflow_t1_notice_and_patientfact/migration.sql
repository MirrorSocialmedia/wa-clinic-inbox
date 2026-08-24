-- AI Workflow T1（cwi-ai-20260824-t1）：
-- P0：PatientFact 表（D-10；retention-purge 引用）
-- Phase A：NoticeKind enum + StaffNotice 表（D-8/D-9 內部通知軌）

-- CreateEnum: NoticeKind（D-8/D-9 內部通知軌）
CREATE TYPE "NoticeKind" AS ENUM ('MEDIA_RECEIVED', 'URGENT_ESCALATION', 'HANDOFF_REQUEST', 'BOOKING_AUTO', 'SUGGESTION_READY', 'SYSTEM');

-- CreateTable: StaffNotice（內部通知 — 同客戶 unread 完全分開）
CREATE TABLE "StaffNotice" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" "NoticeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readByStaffId" TEXT,
    "readAt" TIMESTAMPTZ,

    CONSTRAINT "StaffNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 本店未讀列（readAt IS NULL → createdAt desc 排序）
CREATE INDEX "StaffNotice_clinicId_readAt_createdAt_idx" ON "StaffNotice"("clinicId", "readAt", "createdAt");

-- CreateTable: PatientFact（D-10 — 來源只可以係 Message；retention 跟對話 24 月）
CREATE TABLE "PatientFact" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "sourceWamid" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 按 contact 拉歷史 facts（側欄/booking context 用）
CREATE INDEX "PatientFact_contactId_createdAt_idx" ON "PatientFact"("contactId", "createdAt");
