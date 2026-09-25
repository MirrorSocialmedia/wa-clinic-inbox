-- ★ cwi-final S5-11（F4）：hold 卡全套 — FlowHoldEvent 加 3 樣
-- conversationId+status index：hold 卡按對話配對（B2.3 latestHoldsByConversation 主配對；
--   舊行 conversationId=null → fallback phone 配對）
-- contactPhone：病人喺 Flow 打嘅電話（同 patientPhone = WA 號分清；卡顯示「病人留嘅電話」；
--   retention 90 日終態清 PII 同 patientPhone 一併）
-- apricotRef：commit 時必填嘅 Apricot 單號（commit 用 fetchAppointments 核對存在 + 時間一致）
ALTER TABLE "FlowHoldEvent" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "FlowHoldEvent" ADD COLUMN "apricotRef" TEXT;
CREATE INDEX "FlowHoldEvent_conversationId_status_idx" ON "FlowHoldEvent"("conversationId", "status");
