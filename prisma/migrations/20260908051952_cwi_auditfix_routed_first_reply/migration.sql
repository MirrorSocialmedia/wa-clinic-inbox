-- ★ cwi-auditfix-20260908（B-3）：R-7 首覆原子閘
-- 每對話只生效一次（updateMany where routedFirstReplyAt IS NULL 搶佔）—
-- 防「規則未標記 → 每條 inbound 重發 autoReplyTemplate」。
ALTER TABLE "Conversation" ADD COLUMN "routedFirstReplyAt" TIMESTAMP(3) WITH TIME ZONE;
