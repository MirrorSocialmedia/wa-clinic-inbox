-- AlterTable
ALTER TABLE "FlowSession" ADD COLUMN     "messageId" TEXT;

-- CreateIndex
CREATE INDEX "FlowSession_messageId_idx" ON "FlowSession"("messageId");
