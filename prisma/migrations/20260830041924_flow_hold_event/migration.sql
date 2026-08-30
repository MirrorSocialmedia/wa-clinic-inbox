-- CreateTable
CREATE TABLE "FlowHoldEvent" (
    "id" TEXT NOT NULL,
    "flowToken" TEXT NOT NULL,
    "workforceHoldId" TEXT,
    "clinicCode" TEXT NOT NULL,
    "clinicId" TEXT,
    "providerName" TEXT NOT NULL,
    "providerId" TEXT,
    "date" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "patientName" TEXT,
    "patientPhone" TEXT NOT NULL,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'whatsapp_flow',
    "committedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "FlowHoldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FlowHoldEvent_flowToken_key" ON "FlowHoldEvent"("flowToken");

-- CreateIndex
CREATE INDEX "FlowHoldEvent_patientPhone_status_idx" ON "FlowHoldEvent"("patientPhone", "status");

-- CreateIndex
CREATE INDEX "FlowHoldEvent_clinicCode_status_idx" ON "FlowHoldEvent"("clinicCode", "status");
