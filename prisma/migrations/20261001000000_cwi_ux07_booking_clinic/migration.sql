-- cwi-ux UX-07（2026-10-01）：負責人跨分店預約 — 加欄唔改舊欄（spec §7.3 資料）
--
-- BookingRequest.bookingClinicId：預約喺邊間店做（目標店）。null = 同 clinicId（舊資料零改動）。
--   clinicId 意思唔變（對話所屬店：權限範圍 / /bookings 隊列 / 通知）；
--   時段／Apricot／確認訊息／改期／取消／提醒 一律用 effectiveBookingClinicId()。
-- FlowSession.bookingClinicId：發 Flow 嘅預約目標店（token 簽名帶；病人揀完用同一間店，
--   payload 改店 → 拒）。null = 對話所屬店（舊 flow 零改動）。
--
-- 零回填：舊 row 全部 null（= 舊語義）。

ALTER TABLE "BookingRequest" ADD COLUMN "bookingClinicId" VARCHAR(36);

CREATE INDEX "BookingRequest_bookingClinicId_status_createdAt_idx"
  ON "BookingRequest"("bookingClinicId", "status", "createdAt");

ALTER TABLE "FlowSession" ADD COLUMN "bookingClinicId" VARCHAR(36);
