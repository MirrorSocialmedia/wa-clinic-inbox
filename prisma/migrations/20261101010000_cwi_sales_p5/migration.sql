-- ★ cwi-sales 第 5 期（員工／老闆審視）：no-show、高價保護、到期提醒、同步停咗通知

ALTER TABLE "SalesSettings" ADD COLUMN "expiryRemindDays" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "SalesSettings" ADD COLUMN "lastSyncAlertRunId" TEXT;
ALTER TABLE "SalesOwnership" ADD COLUMN "highValue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SalesOwnership" ADD COLUMN "expiryRemindedFor" TIMESTAMPTZ;
ALTER TABLE "SalesBooking" ADD COLUMN "attendance" VARCHAR(12);

-- 通知類別：銷售對單結果（畀銷售）／同步停咗（畀老闆）
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'SALES_REVIEW';
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'SALES_ADMIN';
