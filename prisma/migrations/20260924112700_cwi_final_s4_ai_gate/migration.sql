-- ★ cwi-final S4-2（audit3 P0-01 / P0-02 / P2-23 / P2-39；D-6）：AI 自動覆原子閘。
-- 1) Message.replyToMessageId：AI／session 自動覆對應嘅 inbound Message.id（trace + dedup key）。
-- 2) partial unique index：每條 inbound 只可被 AI 自動覆一次（WHERE aiAutoSent=true）。
--    Postgres unique index 允許多 NULL → 人手覆／舊 row 零影響；同 trigger 第二個 gate tx
--    INSERT 撞 index → P2002 → gate 回 duplicate-reply（concurrent 競態只成一件）。
--    （Prisma schema 表唔到 partial index → 呢度手寫；D-6：DraftStatus 唔加 SUPERSEDED。）
ALTER TABLE "Message" ADD COLUMN "replyToMessageId" TEXT;

CREATE UNIQUE INDEX "Message_ai_reply_once" ON "Message"("replyToMessageId") WHERE "aiAutoSent" = true;
