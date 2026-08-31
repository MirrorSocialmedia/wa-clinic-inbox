-- CreateTable
CREATE TABLE "StaffClinic" (
    "staffId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffClinic_pkey" PRIMARY KEY ("staffId","clinicId")
);

-- CreateIndex
CREATE INDEX "StaffClinic_clinicId_idx" ON "StaffClinic"("clinicId");

-- AddForeignKey
ALTER TABLE "StaffClinic" ADD CONSTRAINT "StaffClinic_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffClinic" ADD CONSTRAINT "StaffClinic_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
