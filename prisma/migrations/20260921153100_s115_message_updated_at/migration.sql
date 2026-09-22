-- cwi-final S1-15 (P0-07): Message 加 updatedAt（Prisma @updatedAt 自動維護）。
-- 用途：outbound-sweep 判斷 stuck SENDING（>5 min 未更新 = stuck → UNKNOWN + SENDING_TIMEOUT）。
-- 新欄可空：既有行由 UPDATE 全表補現值；之後 Prisma 寫入自動帶。
ALTER TABLE "Message" ADD COLUMN "updatedAt" TIMESTAMPTZ;
UPDATE "Message" SET "updatedAt" = "createdAt";
