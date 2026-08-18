-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('DRAFT', 'AUTO');

-- AlterEnum
ALTER TYPE "DraftStatus" ADD VALUE 'SENT_AUTO';

-- AlterTable
ALTER TABLE "AiCallStats" ADD COLUMN     "lastLatencyMs" INTEGER,
ADD COLUMN     "lastTokens" INTEGER,
ALTER COLUMN "lastOkAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "aiMode" "AiMode" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "aiAutoSent" BOOLEAN NOT NULL DEFAULT false;
