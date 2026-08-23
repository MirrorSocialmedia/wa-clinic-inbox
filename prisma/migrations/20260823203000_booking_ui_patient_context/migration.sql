-- booking-ui patient-context + 代落單（trace cwi-bkui-20260823-a1）
-- MD: wa-clinic-inbox-booking-ui v1.0 §1/§3 — Apricot 代落單 UI + 即時刷新 + patient-context 側欄
-- ★ 本 migration 只落檔，未 apply（15432 = 老細 dev 數據，絕不觸碰）— 部署時手動 review 後先 apply

-- 1) Conversation：patient-context 釘住舊客（lookup match 後落 DB；代落單 + 側欄預約卡都靠呢組欄）
--    pinnedPhoneHash = 64-hex HMAC-SHA256（同 clinic-workforce 共用 PHONE_HASH_KEY）— raw phone 永遠唔入 DB
ALTER TABLE "Conversation" ADD COLUMN "pinnedPatientApricotId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "pinnedPatientName" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "pinnedPhoneHash" TEXT;

-- 2) Conversation：改期 Flow 進行中標記（E — nfm_reply 見到此欄 → 走 reschedule 變體而非新建 BookingRequest）
ALTER TABLE "Conversation" ADD COLUMN "reschedulingApptId" TEXT;

-- 3) BookingRequest：代落單（D — CONFIRMED 態 + rollback + 審計）
--    apricotApptId = Apricot 單號（workforce create 後寫入；rollback 成功 → 清 null，卡彈返 PENDING）
ALTER TABLE "BookingRequest" ADD COLUMN "apricotApptId" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "visitReasonCode" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "chiefComplaint" TEXT;
