-- ★ cwi-reminder-20261025：「等回覆」改做「⏰ 待跟進」（員工自設提醒 — FollowupTask source=MANUAL）
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'FOLLOWUP_REMINDER';

-- 「等回覆」唔再喺 UI 提供 — 現有等回覆對話轉返「處理中」（列表早已當處理中顯示）
UPDATE "Conversation" SET "status" = 'OPEN' WHERE "status" = 'PENDING';
