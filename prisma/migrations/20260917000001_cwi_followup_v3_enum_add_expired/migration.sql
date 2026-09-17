-- cwi-followup-v3-20260916：FollowupStatus 新增 EXPIRED（時效過期 — §2.4 自動）。
ALTER TYPE "FollowupStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
