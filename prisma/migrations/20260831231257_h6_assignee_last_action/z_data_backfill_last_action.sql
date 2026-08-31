-- cwi-h6-20260830 §3（h5 §1）：backfill — 已 assign 對話 assigneeLastActionAt = assignedAt
-- （負責人接手嗰一刻 = 佢最近一次已知動作；未 assign 對話留 null）。冪等（重複跑值不變）。
UPDATE "Conversation"
SET "assigneeLastActionAt" = "assignedAt"
WHERE "assigneeId" IS NOT NULL
  AND "assignedAt" IS NOT NULL
  AND "assigneeLastActionAt" IS NULL;
