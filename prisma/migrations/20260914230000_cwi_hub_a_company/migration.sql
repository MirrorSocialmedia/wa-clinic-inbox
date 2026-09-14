-- cwi-hub-a-20260914（Part A，MD A.1）：公司層（三公司 × 六診所）
-- 順序唔准調（MD A.1）：DDL → 1) Company 三行 → 2) Clinic.companyId 回填 → 3) ADMIN→ALL → 4) STAFF→CLINICS
-- 第 5 步（驗證 Clinic.companyId NULL = 0）喺 deploy 後手動跑（MD 要求「先繼續」— 唔入 migration 防新診所 NULL 誤報）。
-- 註：`Conversation.resolvedBy` SET DATA TYPE TEXT 嘅 drift 係既有（DB varchar vs schema String），唔屬本單，刻意排除。

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN "companyId" TEXT;

-- AlterTable
ALTER TABLE "StaffUser" ADD COLUMN "scopeCompanyId" TEXT,
ADD COLUMN "scopeType" TEXT NOT NULL DEFAULT 'CLINICS';

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE INDEX "Clinic_companyId_idx" ON "Clinic"("companyId");

-- AddForeignKey
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Step 1：建 Company 三行（A/B/C — 老細拍板 2026-09-14；固定 id = 25 字 cuid 形，冪等）──
INSERT INTO "Company" ("id", "code", "name", "enabled") VALUES
    ('chubacompanya000000000000001', 'A', '菁薈', true),
    ('chubacompanyb000000000000002', 'B', '臻善', true),
    ('chubacompanyc000000000000003', 'C', '匯樂', true)
ON CONFLICT ("id") DO NOTHING;

-- ── Step 2：Clinic.companyId 回填（六間生產對應；WTC = dev-only 第三試點店 → 歸 C，CEO 決定）──
UPDATE "Clinic" SET "companyId" = 'chubacompanya000000000000001' WHERE "code" = 'TY';
UPDATE "Clinic" SET "companyId" = 'chubacompanyb000000000000002' WHERE "code" IN ('YMT', 'TW', 'MF');
UPDATE "Clinic" SET "companyId" = 'chubacompanyc000000000000003' WHERE "code" IN ('TKW', 'YL', 'WTC');

-- ── Step 3：現有 role=ADMIN → scopeType='ALL'（MD A-3：ADMIN 就係 ADMIN，靠範圍限制）──
UPDATE "StaffUser" SET "scopeType" = 'ALL' WHERE "role" = 'ADMIN' AND "scopeType" IS DISTINCT FROM 'ALL';

-- ── Step 4：現有 role=STAFF → scopeType='CLINICS'（已有 StaffClinic，唔郁）──
UPDATE "StaffUser" SET "scopeType" = 'CLINICS' WHERE "role" = 'STAFF' AND "scopeType" IS DISTINCT FROM 'CLINICS';
