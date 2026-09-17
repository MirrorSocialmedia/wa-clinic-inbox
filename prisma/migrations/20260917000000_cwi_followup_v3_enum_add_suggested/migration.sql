-- cwi-followup-v3-20260916：FollowupStatus 新增 SUGGESTED（未處理建議 — 取代 SCHEDULED/DUE）。
-- 拆獨立 migration：PG ALTER TYPE ADD VALUE 唔可以喺同一 transaction 重複加值。
ALTER TYPE "FollowupStatus" ADD VALUE IF NOT EXISTS 'SUGGESTED';
