-- ★ cwi-inbox-r3 Q5：跟進分店（轉地點）— additive；null = 由對話所屬店（WhatsApp 號碼店）跟進
ALTER TABLE "Conversation" ADD COLUMN "handlingClinicId" TEXT;
CREATE INDEX "Conversation_handlingClinicId_status_lastMessageAt_idx" ON "Conversation"("handlingClinicId", "status", "lastMessageAt");
