-- ★ cwi-workgroup-p2-20261105：工作群第 2 期 — 分享並放手、附件、置頂；外部對話（Lab／供應商）

ALTER TABLE "Contact" ADD COLUMN "externalAt" TIMESTAMPTZ,
  ADD COLUMN "externalName" VARCHAR(40),
  ADD COLUMN "externalOrg" VARCHAR(60),
  ADD COLUMN "externalById" TEXT;

ALTER TABLE "Conversation" ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "WorkGroupMessage" ADD COLUMN "released" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "claimedById" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMPTZ,
  ADD COLUMN "attachKey" VARCHAR(80),
  ADD COLUMN "attachName" VARCHAR(120),
  ADD COLUMN "attachMime" VARCHAR(60),
  ADD COLUMN "attachSize" INTEGER,
  ADD COLUMN "pinnedAt" TIMESTAMPTZ,
  ADD COLUMN "pinnedById" TEXT;

CREATE UNIQUE INDEX "WorkGroupMessage_attachKey_key" ON "WorkGroupMessage"("attachKey");
CREATE INDEX "WorkGroupMessage_groupId_pinnedAt_idx" ON "WorkGroupMessage"("groupId", "pinnedAt");
