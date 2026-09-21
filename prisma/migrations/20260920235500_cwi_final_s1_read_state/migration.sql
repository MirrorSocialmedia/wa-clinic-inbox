-- AlterTable
-- ★ cwi-final S1-12（audit3 P1-09）：per-staff 已讀狀態
--   @default(now()) 必有 — 否則現有行（dev DB 有真實流量）NOT NULL 無預設值 migration 失敗。
--   既有行的 updatedAt = migration 時刻（可接受 — delta 窗從呢一刻起算）。
ALTER TABLE "Conversation" ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "ConversationRead" (
    "conversationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ConversationRead_pkey" PRIMARY KEY ("conversationId","staffId")
);

-- CreateTable
CREATE TABLE "StaffNoticeRead" (
    "noticeId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffNoticeRead_pkey" PRIMARY KEY ("noticeId","staffId")
);

-- CreateIndex
CREATE INDEX "ConversationRead_staffId_idx" ON "ConversationRead"("staffId");

-- CreateIndex
CREATE INDEX "StaffNoticeRead_staffId_idx" ON "StaffNoticeRead"("staffId");

-- CreateIndex
CREATE INDEX "Conversation_clinicId_updatedAt_idx" ON "Conversation"("clinicId", "updatedAt");
