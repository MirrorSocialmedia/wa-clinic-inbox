-- AlterTable
-- Phase B drift fix（拆出獨立 migration — 原嚟自動生成喺 Phase D migration 入面，
-- 但 Phase D 時間戳 183137 < Phase B 184500，fresh apply 時 remindedAt 仲未存在 → T39 爆）。
-- remindedAt 由 20260824184500_phase_b_template_reminder 建（TIMESTAMP(3) naive），
-- schema 聲明 @db.Timestamptz — 呢度拉齊。
ALTER TABLE "BookingRequest" ALTER COLUMN "remindedAt" SET DATA TYPE TIMESTAMPTZ;
