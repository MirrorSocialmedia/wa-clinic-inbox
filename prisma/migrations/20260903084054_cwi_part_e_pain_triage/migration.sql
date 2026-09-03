-- CreateEnum
CREATE TYPE "PainTriageStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'HANDOFF');

-- CreateTable
CREATE TABLE "PainTriageSession" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "status" "PainTriageStatus" NOT NULL DEFAULT 'ACTIVE',
    "slots" JSONB NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "noProgress" INTEGER NOT NULL DEFAULT 0,
    "closeReason" TEXT,
    "impression" TEXT,
    "autoPostOp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PainTriageSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PainTriageSession_conversationId_status_idx" ON "PainTriageSession"("conversationId", "status");

-- CreateIndex
CREATE INDEX "PainTriageSession_status_expiresAt_idx" ON "PainTriageSession"("status", "expiresAt");

