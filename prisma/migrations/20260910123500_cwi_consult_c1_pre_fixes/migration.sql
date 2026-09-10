-- ★ consult v2.1 C1（cwi-consult-20260910b，MD §0.5-B + §2）：純加欄（deploy-safe，零回改）。
-- 1. Message.sentVia — 發送來源（"AI_ADOPTED" | "AI_AUTO" | "HUMAN_TYPED" | null）— §2.1 M-1
-- 2. KnowledgeDoc.shortDisclaimer — 短版 disclaimer（≤12 字）— §0.5-B-2
-- 3. Conversation.sessionTrigger — 最近一輪最終 consult trigger（FLOOR ?? LLM）— §2.2 M-2
-- 4. Conversation.consultGateAction — 最近一輪 consult 閘動作（WINDOW_EXPIRED_HANDOFF）— §2.3 M-3
-- 5. Conversation.humanTookOver — 店員 typing 接手旗 — §2.1 M-1
-- 6. Conversation.lastOutboundText — 實際發出嘅最後 OUT 文字（下輪 context）— §2.1 M-1

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "sentVia" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeDoc" ADD COLUMN "shortDisclaimer" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "sessionTrigger" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "consultGateAction" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "humanTookOver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "lastOutboundText" TEXT;
