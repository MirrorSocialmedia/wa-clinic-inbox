-- cwi-final S1-1d（=S1-11）：延遲送達訊息 reload 後唔見 — latest page / before 改 createdAt 軸
-- 純 index 新增（零數據改動）：支援 messages route latest page `orderBy createdAt+id` + before keyset
CREATE INDEX "Message_conversationId_createdAt_id_idx" ON "Message"("conversationId", "createdAt", "id");
