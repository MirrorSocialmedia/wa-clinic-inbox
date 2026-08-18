-- Phase 2（AI triage）migration — 理由：
-- 1. Conversation 加 urgency / urgent / aiSummary：
--    intent/urgency/summary 落 Conversation（沿用 Phase 1 intent 欄慣例；
--    UI 隊列欄 + 側欄都要喺對話層顯示，語義係對話而家嘅狀態）。
--    urgent = 鐵律旗（urgency=HIGH 或 intent=URGENT_PAIN 由 AI worker 置 true；
--    置 true 後唔自動清，由 RESOLVED / staff 手動清）。
-- 2. AiDraft 加 @@unique([conversationId, inReplyToMessageId])：
--    冪等 — 同一條 inbound Message 重跑 AI job（attempts 3）唔會生成重複 draft。
-- 3. 新表 AiCallStats（singleton row id=1）：
--    AI call 計數（admin AI 狀態卡「最近 call 成功率」）；只存計數/時間/錯訊短句，
--    零 prompt/response 內容（metadata only）。

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "urgency" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "aiSummary" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_conversationId_inReplyToMessageId_key" ON "AiDraft"("conversationId", "inReplyToMessageId");

-- CreateTable
CREATE TABLE "AiCallStats" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "okCalls" INTEGER NOT NULL DEFAULT 0,
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiCallStats_pkey" PRIMARY KEY ("id")
);
