-- workforce switch（trace cwi-wfsw-20260823-a1）— Apricot 直連拆除，來源切換 clinic-workforce External API
-- ★ 本 migration 只落檔，未 apply（15432 = 老細 dev 數據，絕不觸碰）— 部署時手動 review 後先 apply

-- 1) Drop ApricotSession — wa-inbox 唔再持有 Apricot 憑證（三件套加密 token 一併消失）
--    無 FK 依賴（singleton id=1，只被 app code 讀寫）
DROP TABLE "ApricotSession";

-- 2) BookingRequest.precheckPassed → nullable
--    pure requirement 變體（資料源離線，Flow 只收日期+時段偏好）= null（未經空檔核對）
ALTER TABLE "BookingRequest" ALTER COLUMN "precheckPassed" DROP NOT NULL;

-- 3) BookingRequest.requestedTime → nullable + timeOfDay 新欄
--    pure requirement 變體：病人只揀日期 + 上晝/下晝/夜晚（DatePicker + RadioButtons）
--    requestedTime 留空俾 staff 人手對醫生系統時定具體時段
ALTER TABLE "BookingRequest" ALTER COLUMN "requestedTime" DROP NOT NULL;
ALTER TABLE "BookingRequest" ADD COLUMN "timeOfDay" TEXT;

-- 4) WorkforceSyncState — workforce API 逐店 sync 狀態（取代 ApricotSession heartbeat）
--    lastOkAt = L2 新鮮度判斷（≤5 分鐘）+ workforce_api_degraded alert 訊號（>15 分鐘）
--    metadata only：零憑證、零病人資料
CREATE TABLE "WorkforceSyncState" (
    "clinicId" TEXT NOT NULL,
    "lastOkAt" TIMESTAMPTZ(3) NOT NULL,
    "lastStale" BOOLEAN,
    "lastErrorAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "WorkforceSyncState_pkey" PRIMARY KEY ("clinicId")
);
