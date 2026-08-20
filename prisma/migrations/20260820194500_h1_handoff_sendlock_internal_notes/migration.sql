-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'INTERNAL';

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "assignPolicy" JSONB;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedAt" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "StaffUser" ADD COLUMN     "lastAssignedAt" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "NoteReadReceipt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteReadReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoteReadReceipt_messageId_staffId_key" ON "NoteReadReceipt"("messageId", "staffId");

