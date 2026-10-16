-- ★ wa-meta-compliance-20261016（Meta App Review 合規修正）：
-- ① Message.proactive — 主動訊息標記（B.1/B.2：outbound worker 發送前最後 opt-out 攔截）
-- ② ContactConsent — 主動聯絡同意記錄（B.3/C.2：來源/時間/用途 三要素；opt-out 清旗必帶）
-- ③ Conversation.patientRequestedHuman — 病人要求真人（C.1：AI 停自動 session/AUTO 覆，staff 掣先清）
-- 全部 additive + default（存量 row 行為不變：proactive=false / patientRequestedHuman=false）。

ALTER TABLE "Message" ADD COLUMN "proactive" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Conversation" ADD COLUMN "patientRequestedHuman" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "patientRequestedHumanAt" TIMESTAMPTZ;

CREATE TABLE "ContactConsent" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PROACTIVE_CONTACT',
    "source" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "staffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactConsent_contactId_createdAt_idx" ON "ContactConsent"("contactId", "createdAt");

ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
