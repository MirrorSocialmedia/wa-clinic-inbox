-- ★ cwi-final S5-11（F4）：FlowHoldEvent.patientPhone 改 nullable
--   retention-purge（每日 04:00）：終態（RELEASED/EXPIRED/COMMITTED）90 日 →
--   清 patientName/patientPhone/notes/contactPhone（PII 不留 90 日以上）。
--   非破壞：只鬆約束，唔刪欄唔改型；既有 row 全部有值。

-- DropIndex on nullable column 唔使（[patientPhone,status] index 對 NULL 行照行，purged row 唔再 match 任何查詢）
ALTER TABLE "FlowHoldEvent" ALTER COLUMN "patientPhone" DROP NOT NULL;
