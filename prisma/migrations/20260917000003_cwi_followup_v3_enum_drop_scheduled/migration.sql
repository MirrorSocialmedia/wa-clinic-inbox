-- cwi-followup-v3-20260916：FollowupStatus enum 重建（新值集：SUGGESTED|SENT|SKIPPED|CANCELLED|COMPLETED|EXPIRED）。
-- 本環境 PG 不支持 ALTER TYPE ... DROP VALUE（實測 "not implemented"）→ 標準 rebuild 手法：
--   建新 type → cast 欄 → rename → drop 舊 type。
-- 前置：20260917000002 已將 SCHEDULED/DUE 行全部搬遷為 SUGGESTED（cast 前無舊值殘留）。
CREATE TYPE "FollowupStatusV3" AS ENUM ('SUGGESTED', 'SENT', 'SKIPPED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

ALTER TABLE "FollowupTask" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "FollowupTask"
  ALTER COLUMN "status" TYPE "FollowupStatusV3"
  USING "status"::text::"FollowupStatusV3";
ALTER TABLE "FollowupTask" ALTER COLUMN "status" SET DEFAULT 'SUGGESTED'::"FollowupStatusV3";

ALTER TYPE "FollowupStatus" RENAME TO "FollowupStatusOld";
ALTER TYPE "FollowupStatusV3" RENAME TO "FollowupStatus";
DROP TYPE "FollowupStatusOld";
