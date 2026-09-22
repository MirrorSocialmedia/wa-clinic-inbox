-- cwi-final S1-15 (P0-07): MsgStatus 新增 SENDING + UNKNOWN。
-- SENDING = outbound worker 已 atomic claim（QUEUED+waMessageId null → SENDING），Graph call 進行中。
-- UNKNOWN = Graph 結果未知（中斷 / timeout）— 禁自動重發（防雙發），人工核（T715 / P0-07）。
-- 手寫 migration（禁 prisma migrate dev — 避免吸收 pre-existing drift）。
ALTER TYPE "MsgStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "MsgStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';
