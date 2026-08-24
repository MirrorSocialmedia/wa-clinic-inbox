-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "graph" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "createdBy" TEXT,
    "publishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowDefinition_key_status_idx" ON "WorkflowDefinition"("key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_clinicId_key_version_key" ON "WorkflowDefinition"("clinicId", "key", "version");
