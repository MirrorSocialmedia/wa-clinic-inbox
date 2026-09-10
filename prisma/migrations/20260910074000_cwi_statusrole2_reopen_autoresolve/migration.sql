-- ★ cwi-statusrole2-20260910 T2（MD §3/§4）：Conversation 加四欄（全部 nullable — deploy-safe）
-- 1) lastOutboundAt：§4 auto-resolve 守門 ②（病人最後一句已覆 = lastInboundAt <= lastOutboundAt）
ALTER TABLE "Conversation" ADD COLUMN "lastOutboundAt" TIMESTAMPTZ(3);
-- 2) reopenedAt：§3 已解決翻開聯動（badge「↻ 重新開啟」24h 窗口；只由 inbound reopen 分支寫）
ALTER TABLE "Conversation" ADD COLUMN "reopenedAt" TIMESTAMPTZ(3);
-- 3) resolvedBy / resolvedAt：§4 解決者（staffId 手動 / "AUTO" cron）+ 解決時間
ALTER TABLE "Conversation" ADD COLUMN "resolvedBy" VARCHAR;
ALTER TABLE "Conversation" ADD COLUMN "resolvedAt" TIMESTAMPTZ(3);

-- 純資料 backfill：lastOutboundAt = 該對話最後一條 OUT+SENT 訊息時間（守門 ② 對舊對話即刻正確；
-- 無回覆嘅對話留 null = 守門 ② 保守不達標，等下一條回覆先計入 auto-resolve 範圍）
UPDATE "Conversation" c
SET "lastOutboundAt" = (
  SELECT MAX(m."waTimestamp") FROM "Message" m
  WHERE m."conversationId" = c.id
    AND m."direction" = 'OUT'
    AND m."status" = 'SENT'
)
WHERE c."lastOutboundAt" IS NULL;
