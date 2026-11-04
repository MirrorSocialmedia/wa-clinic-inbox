-- ★ cwi-workgroup-20261104：工作群（inbox 內部團隊群組；群組／成員由老闆自己管）

CREATE TABLE "WorkGroup" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "archivedAt" TIMESTAMPTZ,
    "lastMessageAt" TIMESTAMPTZ,
    CONSTRAINT "WorkGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkGroupMember" (
    "groupId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMPTZ,
    CONSTRAINT "WorkGroupMember_pkey" PRIMARY KEY ("groupId","staffId")
);

CREATE TABLE "WorkGroupMessage" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversationId" TEXT,
    "clientKey" VARCHAR(64),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkGroupMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkGroupMember_staffId_idx" ON "WorkGroupMember"("staffId");
CREATE UNIQUE INDEX "WorkGroupMessage_senderId_clientKey_key" ON "WorkGroupMessage"("senderId", "clientKey");
CREATE INDEX "WorkGroupMessage_groupId_createdAt_idx" ON "WorkGroupMessage"("groupId", "createdAt");

ALTER TABLE "WorkGroupMember" ADD CONSTRAINT "WorkGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WorkGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkGroupMessage" ADD CONSTRAINT "WorkGroupMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WorkGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
