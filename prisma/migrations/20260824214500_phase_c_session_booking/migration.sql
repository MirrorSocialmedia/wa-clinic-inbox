-- AI Workflow Phase C（cwi-sess-20260824-c1）：
-- AutomationPolicy（L3/L4 gating）+ BookingSession（slot-filling engine）
-- + Message.bookingSessionId（追溯 session 回覆）+ BookingRequest.autoBooked（L4 統計鈎）
-- 全零鎖表：新 CREATE TYPE + 新表 + nullable/default 欄。

-- CreateEnum: BookingSessionStatus（slot-filling session 狀態）
CREATE TYPE "BookingSessionStatus" AS ENUM ('ACTIVE', 'CONFIRMING', 'COMPLETED', 'HANDOFF', 'ABANDONED', 'CANCELLED');

-- CreateTable: AutomationPolicy（逐店逐類自動化級別；寫入只經 admin route）
CREATE TABLE "AutomationPolicy" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AutomationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 每店每類唯一（exact 與 "*" 各一條）
CREATE UNIQUE INDEX "AutomationPolicy_clinicId_category_key" ON "AutomationPolicy"("clinicId", "category");

-- CreateTable: BookingSession（slot-filling 對話 session — 零病人自由文本，只 business metadata）
CREATE TABLE "BookingSession" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "status" "BookingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "slots" JSONB NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "noProgress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BookingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 按對話搵 active session（worker 分流）
CREATE INDEX "BookingSession_conversationId_status_idx" ON "BookingSession"("conversationId", "status");

-- CreateIndex: 過期 cron（ACTIVE/CONFIRMING + expiresAt）
CREATE INDEX "BookingSession_status_expiresAt_idx" ON "BookingSession"("status", "expiresAt");

-- AddColumn: Message.bookingSessionId（nullable — 追溯 session 回覆）
ALTER TABLE "Message" ADD COLUMN "bookingSessionId" TEXT;

-- AddColumn: BookingRequest.autoBooked（default false — 舊行語義不變）
ALTER TABLE "BookingRequest" ADD COLUMN "autoBooked" BOOLEAN NOT NULL DEFAULT false;
