-- ★ cwi-inbox-r4：公司轉地點白名單（單向；空 = 只限同公司）
ALTER TABLE "Company" ADD COLUMN "transferToCompanyIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
