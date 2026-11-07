-- ★ cwi-sticker-20261107：貼圖庫（我的貼圖／診所貼圖）

CREATE TABLE "Sticker" (
    "id" TEXT NOT NULL,
    "ownerKey" VARCHAR(40) NOT NULL,
    "name" VARCHAR(30),
    "fileKey" VARCHAR(80) NOT NULL,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ,
    CONSTRAINT "Sticker_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Sticker_fileKey_key" ON "Sticker"("fileKey");
CREATE UNIQUE INDEX "Sticker_ownerKey_sha256_key" ON "Sticker"("ownerKey", "sha256");
CREATE INDEX "Sticker_ownerKey_createdAt_idx" ON "Sticker"("ownerKey", "createdAt");
