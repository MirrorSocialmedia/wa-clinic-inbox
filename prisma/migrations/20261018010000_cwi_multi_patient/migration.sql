-- ★ cwi-multi-patient-20261018：一個電話連幾個病人檔
CREATE TABLE "ContactPatientLink" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "patientCode" TEXT,
    "patientName" TEXT,
    "relation" TEXT,
    "source" TEXT NOT NULL,
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactPatientLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactPatientLink_contactId_patientApricotId_key" ON "ContactPatientLink"("contactId", "patientApricotId");

ALTER TABLE "ContactPatientLink" ADD CONSTRAINT "ContactPatientLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 回填：舊對話已釘住嘅病人 + 電話判定只認到一個嘅病人 → 加入「此電話嘅病人」（重跑唔重複）
INSERT INTO "ContactPatientLink" ("id", "contactId", "patientApricotId", "patientCode", "patientName", "source", "updatedAt")
SELECT DISTINCT ON (c."contactId", c."pinnedPatientApricotId")
       'cpl_' || md5(c."contactId" || ':' || c."pinnedPatientApricotId"), c."contactId", c."pinnedPatientApricotId", NULL, c."pinnedPatientName", 'LOOKUP', CURRENT_TIMESTAMP
FROM "Conversation" c
WHERE c."pinnedPatientApricotId" IS NOT NULL
ON CONFLICT ("contactId", "patientApricotId") DO NOTHING;

INSERT INTO "ContactPatientLink" ("id", "contactId", "patientApricotId", "patientCode", "patientName", "source", "updatedAt")
SELECT 'cpl_' || md5(ct."id" || ':' || ct."identifiedPatientApricotId"), ct."id", ct."identifiedPatientApricotId", ct."identifiedPatientCode", NULL, 'IDENTIFIED', CURRENT_TIMESTAMP
FROM "Contact" ct
WHERE ct."identifiedPatientApricotId" IS NOT NULL
ON CONFLICT ("contactId", "patientApricotId") DO UPDATE SET "patientCode" = COALESCE("ContactPatientLink"."patientCode", EXCLUDED."patientCode");
