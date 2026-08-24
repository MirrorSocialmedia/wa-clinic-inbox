-- Phase B（cwi-tmpl-20260824-b1）：template 發送鏈 + T-24h 預約提醒
-- 三個 ALTER TABLE ADD COLUMN（全 nullable）— 零鎖表、零 enum 動作、零數據回填。
--   Message.templateMeta        template 發送元數據（type="template" 先有；PII 白名單：只 template 變數）
--   BookingRequest.remindedAt   T-24h 提醒冪等旗（null = 未提醒；改期/rollback reset）
--   Clinic.waBusinessAccountId  WABA id（template 列表 API 作用域；onboarding exchange 帶到先寫入）

-- AlterTable: Message + templateMeta（Phase B B1.1）
ALTER TABLE "Message" ADD COLUMN "templateMeta" JSONB;

-- AlterTable: BookingRequest + remindedAt（Phase B B2 冪等旗）
ALTER TABLE "BookingRequest" ADD COLUMN "remindedAt" TIMESTAMP(3);

-- AlterTable: Clinic + waBusinessAccountId（Phase B B3 template 列表作用域）
ALTER TABLE "Clinic" ADD COLUMN "waBusinessAccountId" TEXT;
