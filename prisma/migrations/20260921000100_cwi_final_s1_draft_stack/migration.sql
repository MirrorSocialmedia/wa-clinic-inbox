-- ★ cwi-final S1-13（D-6）：草稿堆疊複合 index（GET drafts 取最近 3 個 PROPOSED）
CREATE INDEX IF NOT EXISTS "AiDraft_conv_status_created_idx" ON "AiDraft"("conversationId", "status", "createdAt" DESC);
-- 現有超過 3 個 PROPOSED 嘅對話：舊嘅轉 EXPIRED（唔刪）
UPDATE "AiDraft" d SET status = 'EXPIRED'
FROM (SELECT id, row_number() OVER (PARTITION BY "conversationId" ORDER BY "createdAt" DESC, id DESC) AS rn
      FROM "AiDraft" WHERE status = 'PROPOSED') x
WHERE d.id = x.id AND x.rn > 3;
