-- ★ cwi-patient-identify-20261017：新客／舊客判定（用電話搜晒全部 Apricot 帳號）
ALTER TABLE "Contact" ADD COLUMN "patientStatus" TEXT;
ALTER TABLE "Contact" ADD COLUMN "patientCheckedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "identifiedPatientApricotId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "identifiedCount" INTEGER;
