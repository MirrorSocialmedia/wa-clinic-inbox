-- Realtime P0 (cwi-rt-20260823-a1)：R1 clientMessageId 冪等 + R4 MediaStatus + R5 assignVersion

-- CreateEnum: MediaStatus
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'SKIPPED');

-- AlterTable: Message
ALTER TABLE "Message" ADD COLUMN "clientMessageId" TEXT;
ALTER TABLE "Message" ADD COLUMN "mediaStatus" "MediaStatus" NOT NULL DEFAULT 'READY';

-- AlterTable: Conversation
ALTER TABLE "Conversation" ADD COLUMN "assignVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: clientMessageId 冪等 key（多 NULL 允許 — 只 OUT/API 訊息用）
CREATE UNIQUE INDEX "Message_clientMessageId_key" ON "Message"("clientMessageId");
