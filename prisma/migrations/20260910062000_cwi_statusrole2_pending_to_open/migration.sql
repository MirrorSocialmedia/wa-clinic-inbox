-- ★ cwi-statusrole2-20260910 T1（MD §1.2）：PENDING 資料歸零（純資料，enum 保留）
-- ConvStatus.PENDING 保留喺 enum（舊 API link `GET /api/conversations?status=PENDING` 仍接受），
-- UI 唔會再產生 PENDING；現存 status=PENDING 嘅對話一次過改做 OPEN。
UPDATE "Conversation" SET "status" = 'OPEN' WHERE "status" = 'PENDING';
