-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "CompanySyncRun" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "CompanySyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanySyncRun_runAt_idx" ON "CompanySyncRun"("runAt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_sourceId_key" ON "Company"("sourceId");
