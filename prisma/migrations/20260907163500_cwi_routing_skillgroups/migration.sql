-- ★ cwi-routing-20260906：規則式指派 + 技能組 + 投訴兩級升級 + SUPERVISOR 主管角色。
-- 零鎖表模式（跟 20260904000000_cwi_part_f）：plain CREATE TYPE/TABLE/INDEX +
-- ALTER TABLE ADD COLUMN（Postgres 11+ nullable ADD COLUMN 唔做 full table rewrite — 唔阻 DML）+
-- ALTER TYPE ADD VALUE（catalog 級；唔鎖資料表）。

-- AlterEnum（SUPERVISOR 主管角色 — 全店唯讀 + AI 級別讀寫 + 備註可寫；覆客/設定 403）
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR';

-- AlterEnum（路由通知軌 — StaffNotice kind）
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'ROUTING_ASSIGNED';
ALTER TYPE "NoticeKind" ADD VALUE IF NOT EXISTS 'ROUTING_ESCALATION';

-- CreateEnum
CREATE TYPE "RoutingTargetType" AS ENUM ('GROUP', 'STAFF', 'CLINIC_POOL');

-- CreateTable
CREATE TABLE "SkillGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillGroupMember" (
    "groupId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillGroupMember_pkey" PRIMARY KEY ("groupId","staffId")
);

-- CreateTable
CREATE TABLE "SkillGroupClinic" (
    "groupId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,

    CONSTRAINT "SkillGroupClinic_pkey" PRIMARY KEY ("groupId","clinicId")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intents" TEXT[] NOT NULL DEFAULT '{}',
    "keywords" TEXT[] NOT NULL DEFAULT '{}',
    "patientType" TEXT,
    "targetType" "RoutingTargetType" NOT NULL,
    "targetGroupId" TEXT,
    "targetStaffId" TEXT,
    "autoReplyTemplate" TEXT,
    "escalateAfterMin" INTEGER,
    "escalateToGroupId" TEXT,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillGroup_code_key" ON "SkillGroup"("code");
CREATE INDEX "SkillGroupMember_staffId_idx" ON "SkillGroupMember"("staffId");
CREATE INDEX "SkillGroupClinic_clinicId_idx" ON "SkillGroupClinic"("clinicId");
CREATE INDEX "RoutingRule_clinicId_enabled_priority_idx" ON "RoutingRule"("clinicId", "enabled", "priority");

-- AddConversation 路由標記欄（R-2：只標記唔指派 — assigneeId 零改動）
ALTER TABLE "Conversation" ADD COLUMN "routedGroupId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "routedStaffId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "routedRuleId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "routedAt" TIMESTAMPTZ(3);
ALTER TABLE "Conversation" ADD COLUMN "escalatedAt" TIMESTAMPTZ(3);

-- CreateIndex（「派俾我」膠囊 + 升級 sweep 輔助）
CREATE INDEX "Conversation_routedGroupId_assigneeId_idx" ON "Conversation"("routedGroupId", "assigneeId");
CREATE INDEX "Conversation_routedStaffId_idx" ON "Conversation"("routedStaffId");
