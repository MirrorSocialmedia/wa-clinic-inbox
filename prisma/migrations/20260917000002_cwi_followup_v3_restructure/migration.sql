-- cwi-followup-v3-20260916：enum 搬遷 + F 類剷走 + 新欄。

-- ① 舊 task 狀態搬遷：SCHEDULED/DUE → SUGGESTED（v3 語義：未處理建議）
UPDATE "FollowupTask"
SET "status" = 'SUGGESTED'
WHERE "status" IN ('SCHEDULED', 'DUE');

-- ② F 欠款提醒整類剷走（billOsAmt 分期係正常狀態 — 主動追破壞關係）
--    F 相關未處理 task → CANCELLED（留痕）
UPDATE "FollowupTask" t
SET "status" = 'CANCELLED',
    "cancelReason" = 'MANUAL',
    "handledAt" = NOW()
FROM "FollowupRule" r
WHERE t."ruleId" = r.id
  AND r."trigger" = 'OUTSTANDING_BALANCE'
  AND t."status" = 'SUGGESTED';

--    F seed rule / template 行刪除
DELETE FROM "FollowupRule" WHERE "trigger" = 'OUTSTANDING_BALANCE';
DELETE FROM "FollowupTemplate" WHERE "key" = 'outstanding_balance';

-- ③ 新欄（schema.prisma 對應）
ALTER TABLE "Conversation" ADD COLUMN "postOpFollowupAt" TIMESTAMP(3);
ALTER TABLE "FollowupRule" ADD COLUMN "dedupWindowDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "FollowupRule" ADD COLUMN "firstUseConfirmedAt" TIMESTAMP(3);
ALTER TABLE "FollowupRule" ADD COLUMN "lastScanAt" TIMESTAMP(3);
ALTER TABLE "FollowupRule" ADD COLUMN "lastScanResult" TEXT;

-- ④ F 專屬欄 DROP（minAmount / cancelOnPaid — 只服務 OUTSTANDING_BALANCE）
ALTER TABLE "FollowupRule" DROP COLUMN "cancelOnPaid";
ALTER TABLE "FollowupRule" DROP COLUMN "minAmount";
