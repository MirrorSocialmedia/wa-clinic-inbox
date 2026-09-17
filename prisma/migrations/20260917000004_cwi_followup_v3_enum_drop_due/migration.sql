-- cwi-followup-v3-20260916：FollowupTrigger enum 重建（剷 OUTSTANDING_BALANCE）。
-- 同 20260917000003 手法（本環境 PG 不支持 DROP VALUE）。
-- 前置：20260917000002 已刪 OUTSTANDING_BALANCE rule 行（cast 前無舊值殘留）。
CREATE TYPE "FollowupTriggerV3" AS ENUM (
  'CONVERSATION_IDLE', 'BEFORE_APPOINTMENT', 'AFTER_NO_SHOW',
  'AFTER_TREATMENT', 'RECALL_NO_REPEAT', 'QUOTED_NOT_BOOKED'
);

ALTER TABLE "FollowupRule"
  ALTER COLUMN "trigger" TYPE "FollowupTriggerV3"
  USING "trigger"::text::"FollowupTriggerV3";

ALTER TYPE "FollowupTrigger" RENAME TO "FollowupTriggerOld";
ALTER TYPE "FollowupTriggerV3" RENAME TO "FollowupTrigger";
DROP TYPE "FollowupTriggerOld";
