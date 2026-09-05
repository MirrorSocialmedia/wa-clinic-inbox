-- cwi-inboxfix-20260905（T1/T2 合併單一 migration — CEO preflight #11 授權，兩處註解清楚）：
--
-- (1) MsgStatus.CANCELLED（MD §5.2 I-9）：
--     8 秒撤回窗口內撳撤回 → outbound job remove + Message.status = CANCELLED（病人永遠收唔到）。
--     已 SENT 嘅訊息唔會變 CANCELLED（過窗 → 409「已經發出」）。
--
-- (2) Conversation.slaNotifiedAt（MD §1.4 I-5）：
--     公海 SLA 提醒防重複洗版旗。cron（*/5）揀 assigneeId=null AND 未解 AND
--     lastInboundAt <= now-N 分 AND slaNotifiedAt IS NULL → push 後標 now；
--     被接手（assign 成功）時清返 NULL。
--
-- 零鎖：純 additive（ADD VALUE / ADD COLUMN nullable）— 唔改現有行、唔 rebuild index。

ALTER TYPE "MsgStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "Conversation" ADD COLUMN "slaNotifiedAt" TIMESTAMPTZ;
