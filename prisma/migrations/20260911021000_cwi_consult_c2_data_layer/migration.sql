-- ★ consult v2.1 C2（cwi-consult-20260910b，MD §3 資料層）：純加法 migration（deploy-safe，零 data mutation）。
-- ConsultSession / ConsultProduct 兩張新表 + index + FK。
-- 注意：本 migration 刻意唔含 `ALTER TABLE "Conversation" ALTER COLUMN "resolvedBy" SET DATA TYPE TEXT`
--   — 呢條係 pre-existing drift（R1 migration 落 VARCHAR，Prisma String 對應 TEXT；Postgres 兩者語義相同），
--   唔係 C2 改動；放低係為保持本 migration 純加（deploy-safe 自檢口徑）。

-- CreateTable
CREATE TABLE "ConsultSession" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'DISCOVER',
    "terminal" TEXT,
    "slots" JSONB NOT NULL DEFAULT '{}',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "candidateCategory" TEXT,
    "comparedProducts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "askedSlots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "purchaseIntent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastAction" TEXT,
    "nextAction" TEXT,
    "ctaGiven" BOOLEAN NOT NULL DEFAULT false,
    "humanTookOver" BOOLEAN NOT NULL DEFAULT false,
    "lastOutboundText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultProduct" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "workflow" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT,
    "brand" TEXT,
    "productFamily" TEXT,
    "model" TEXT,
    "material" TEXT,
    "surface" TEXT,
    "positioning" TEXT NOT NULL,
    "approvedWording" TEXT NOT NULL,
    "avoidPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeWording" TEXT,
    "packageNote" TEXT,
    "warrantyNote" TEXT,
    "priceDocTitle" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "ConsultProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultSession_conversationId_terminal_idx" ON "ConsultSession"("conversationId", "terminal");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultProduct_clinicId_workflow_code_key" ON "ConsultProduct"("clinicId", "workflow", "code");

-- AddForeignKey
ALTER TABLE "ConsultSession" ADD CONSTRAINT "ConsultSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
