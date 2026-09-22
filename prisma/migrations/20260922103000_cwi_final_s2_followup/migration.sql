-- cwi-final Stage 2 followup schema（spec 行 1906：Stage 2 全部 schema 一個 migration 收 —
-- 2-1 subjectKey、2-5 paramOrder、2-8 timestamptz、S0-8 B1 disable）

-- ① FollowupTask.subjectKey（S2-1：業務科目 appt:/noshow:/tx:/recall:/quote:/idle: — 科目級終態去重）
ALTER TABLE "FollowupTask" ADD COLUMN "subjectKey" TEXT;
CREATE INDEX "FollowupTask_ruleId_subjectKey_idx" ON "FollowupTask"("ruleId", "subjectKey");

-- ② 重複檢查（spec：有結果先人手清再建 index — dev DB 實測 0 行；照 spec 留喺度做落庫時點數）
SELECT "ruleId", "conversationId", count(*) FROM "FollowupTask" WHERE status = 'SUGGESTED' GROUP BY 1,2 HAVING count(*) > 1;

-- ③ backfill（spec 行 1917-1921 兩條逐字 + 其餘 trigger 按 contextJson 對應欄；補唔到留 NULL）
UPDATE "FollowupTask" t SET "subjectKey" = 'appt:' || (t."contextJson"->>'apptId')
FROM "FollowupRule" r WHERE r.id = t."ruleId" AND r.trigger IN ('BEFORE_APPOINTMENT') AND t."contextJson" ? 'apptId';
UPDATE "FollowupTask" t SET "subjectKey" = 'noshow:' || (t."contextJson"->>'apptId')
FROM "FollowupRule" r WHERE r.id = t."ruleId" AND r.trigger = 'AFTER_NO_SHOW' AND t."contextJson" ? 'apptId';
UPDATE "FollowupTask" t SET "subjectKey" = 'tx:' || (t."contextJson"->>'visitId')
FROM "FollowupRule" r WHERE r.id = t."ruleId" AND r.trigger = 'AFTER_TREATMENT' AND t."contextJson" ? 'visitId';
UPDATE "FollowupTask" t SET "subjectKey" = 'recall:' || t."patientApricotId" || ':' || (t."contextJson"->>'lastVisitDate')
FROM "FollowupRule" r WHERE r.id = t."ruleId" AND r.trigger = 'RECALL_NO_REPEAT' AND t."patientApricotId" IS NOT NULL AND t."contextJson" ? 'lastVisitDate';
UPDATE "FollowupTask" t SET "subjectKey" = 'quote:' || (t."contextJson"->>'quoteId')
FROM "FollowupRule" r WHERE r.id = t."ruleId" AND r.trigger = 'QUOTED_NOT_BOOKED' AND t."contextJson" ? 'quoteId';
-- CONVERSATION_IDLE：contextJson 只有 idleDays（冇 conversationId/lastInboundAt 可 backfill）→ 補唔到留 NULL

-- ④ 科目級終態：同 rule × 同科目最多一條 SUGGESTED（concurrent scan 防疊 — createTask P2002 兜底）
CREATE UNIQUE INDEX "FollowupTask_open_subject" ON "FollowupTask"("ruleId", "subjectKey")
  WHERE "subjectKey" IS NOT NULL AND status = 'SUGGESTED';

-- ⑤ FollowupTemplate.paramOrder（S2-5 過窗 template 參數次序用；本批只加欄）
ALTER TABLE "FollowupTemplate" ADD COLUMN "paramOrder" TEXT[] DEFAULT '{}' NOT NULL;

-- ⑥ Timestamptz 漂移修（S2-8）：三欄 schema 宣稱 timestamptz 但 DB 係 plain timestamp。
--    既有 wall-clock 實測全部 = UTC wall-clock（worker 經 Prisma 寫入；2026-09-22 實測驗證）→ 'UTC' 解釋正確。
ALTER TABLE "Conversation" ALTER COLUMN "postOpFollowupAt" TYPE TIMESTAMPTZ USING "postOpFollowupAt" AT TIME ZONE 'UTC';
ALTER TABLE "FollowupRule" ALTER COLUMN "firstUseConfirmedAt" TYPE TIMESTAMPTZ USING "firstUseConfirmedAt" AT TIME ZONE 'UTC';
ALTER TABLE "FollowupRule" ALTER COLUMN "lastScanAt" TYPE TIMESTAMPTZ USING "lastScanAt" AT TIME ZONE 'UTC';

-- ⑦ S0-8 B1 disable（spec 行 360 逐字）：未做首次啟用確認嘅 BEFORE_APPOINTMENT 規則永久關
--    （D-9：要等 S2-1 上線先開 — 而家 B1 只取 status 0 有效預約，改期舊單 102 唔再提醒）
UPDATE "FollowupRule" SET enabled = false WHERE trigger = 'BEFORE_APPOINTMENT' AND "firstUseConfirmedAt" IS NULL;
