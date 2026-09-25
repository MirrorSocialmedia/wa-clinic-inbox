-- ★ cwi-final S5-7（F2）：預約狀態一致 — BookingStatus + CANCELLED / RESCHEDULED
--   （cancel route 同步 CANCELLED；flow-reply 原子改期成功同步 RESCHEDULED；
--     reminder scan 候選 = CONFIRMED only → 兩新值天然排除）
--   ALTER TYPE ADD VALUE 不可入 transaction — psql 逐句 autocommit 執行
ALTER TYPE "BookingStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "BookingStatus" ADD VALUE 'RESCHEDULED';

-- ★ cwi-final S5-8②（F2）：T4 改期唔取消舊單 — reschedule context 欄
--   FlowSession.rescheduleOfApptId：發 Flow 時由 Conversation.reschedulingApptId 複製
--   FlowHoldEvent.rescheduleOfApptId：submit_confirm claim 時帶入（hold 卡紅標 + commit 後 102 舊單）
--   FlowHoldEvent.conversationId：對話關聯（S5-11（F4）hold sweep 先用 — 本批加好避免二次 migration）
ALTER TABLE "FlowSession" ADD COLUMN "rescheduleOfApptId" TEXT;
ALTER TABLE "FlowHoldEvent" ADD COLUMN "rescheduleOfApptId" TEXT;
ALTER TABLE "FlowHoldEvent" ADD COLUMN "conversationId" TEXT;
