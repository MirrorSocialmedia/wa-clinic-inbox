-- cwi-final S6-2 Index（audit3 §9.2）— 6 店數據量細，用普通 CREATE INDEX；低峰 deploy
--
-- ★ 重複檢查（先跑；任何 >0 = STOP，唔好上 unique index）：
--   SELECT "conversationId", count(*) FROM "BookingSession" WHERE status IN ('ACTIVE','CONFIRMING') GROUP BY 1 HAVING count(*) > 1;
--   SELECT "conversationId", count(*) FROM "PainTriageSession" WHERE status = 'ACTIVE' GROUP BY 1 HAVING count(*) > 1;
--   SELECT "conversationId", count(*) FROM "ConsultSession" WHERE terminal IS NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT "staffId", count(*) FROM "StaffClinic" WHERE "isPrimary" GROUP BY 1 HAVING count(*) > 1;
--   SELECT "conversationId", count(*) FROM "FlowSession" WHERE status = 'SENT' GROUP BY 1 HAVING count(*) > 1;
--   （S6 G1 sandbox 15432 實測 2026-09-26：五項全 0 → 通行；生產 deploy 前重跑）
--
-- 註：Message(conversationId, createdAt, id) 已喺 S1-1d；FollowupTask subject unique 已喺 S2-1（唔重複建）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Message_createdAt_brin" ON "Message" USING brin("createdAt");
CREATE INDEX IF NOT EXISTS "Message_waTimestamp_brin" ON "Message" USING brin("waTimestamp");
CREATE INDEX IF NOT EXISTS "Contact_profileName_trgm" ON "Contact" USING gin("profileName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Contact_waId_trgm" ON "Contact" USING gin("waId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Conv_assignee_status_last_idx" ON "Conversation"("assigneeId","status","lastMessageAt" DESC);
-- ↓ S1-2 cursor 分頁主要靠呢個（全店角色冇 clinicId 條件時另加 ("urgent" DESC, "lastMessageAt" DESC, id DESC) 一條）
CREATE INDEX IF NOT EXISTS "Conv_urgent_last_id_idx" ON "Conversation"("urgent" DESC,"lastMessageAt" DESC,"id" DESC) WHERE status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS "Conv_clinic_urgent_last_idx" ON "Conversation"("clinicId","urgent" DESC,"lastMessageAt" DESC);
CREATE INDEX IF NOT EXISTS "Conv_routed_group_idx" ON "Conversation"("routedGroupId") WHERE "assigneeId" IS NULL;
CREATE INDEX IF NOT EXISTS "Conv_pool_idx" ON "Conversation"("clinicId","lastInboundAt") WHERE "assigneeId" IS NULL AND status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS "Conv_open_last_idx" ON "Conversation"("lastMessageAt") WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS "Conv_escalate_idx" ON "Conversation"("routedRuleId") WHERE "escalatedAt" IS NULL AND "assigneeId" IS NULL;
CREATE INDEX IF NOT EXISTS "AuditLog_entity_idx" ON "AuditLog"("entity","entityId","action");
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action","createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_staff_idx" ON "AuditLog"("staffId","action","createdAt");
CREATE INDEX IF NOT EXISTS "PatientFact_sourceMessageId_idx" ON "PatientFact"("sourceMessageId");
CREATE INDEX IF NOT EXISTS "FollowupTask_status_conv_idx" ON "FollowupTask"("status","conversationId");
CREATE INDEX IF NOT EXISTS "FollowupTask_patient_rule_idx" ON "FollowupTask"("patientApricotId","ruleId");
CREATE INDEX IF NOT EXISTS "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");
CREATE INDEX IF NOT EXISTS "AiDraft_createdAt_idx" ON "AiDraft"("createdAt");

-- 唯一性（先跑重複檢查 — 見頭部 5 條 SELECT；任何 >0 = STOP）
CREATE UNIQUE INDEX IF NOT EXISTS "BookingSession_one_active" ON "BookingSession"("conversationId") WHERE status IN ('ACTIVE','CONFIRMING');
CREATE UNIQUE INDEX IF NOT EXISTS "PainTriage_one_active" ON "PainTriageSession"("conversationId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS "Consult_one_active" ON "ConsultSession"("conversationId") WHERE terminal IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "StaffClinic_one_primary" ON "StaffClinic"("staffId") WHERE "isPrimary";
CREATE UNIQUE INDEX IF NOT EXISTS "FlowSession_one_sent" ON "FlowSession"("conversationId") WHERE status = 'SENT';

-- ★ S6-2：web role statement_timeout（spec 逐字：`ALTER ROLE <web_user> SET statement_timeout = '8s'`）
--   本 repo app/migrate 同 role（wa_inbox；sandbox 實測 = superuser = 唯一 user）→
--   guard 咗 role 存在先 set（CI service postgres 環境 role 名唔同 → 跳過，唔炸 migrate）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wa_inbox') THEN
    ALTER ROLE wa_inbox SET statement_timeout = '8s';
  END IF;
END
$$;
