-- cwi-final S1-15 (P0-07) seg3-fix：Message.updatedAt 對齊 Prisma schema（non-nullable @updatedAt）。
--
-- 根因（e2e 確定性紅，T300/T301/T302 ×12 + T85 ×3）：
--   153100 加欄時用 `ADD COLUMN "updatedAt" TIMESTAMPTZ`（nullable）+ 既有行回填，
--   但 Prisma schema 宣告 `updatedAt DateTime @updatedAt`（non-nullable）。
--   e2e fixture 走 raw SQL INSERT（唔帶 updatedAt 欄 — mock-e2e I 段 51+3 條 / T85 staff OUT seed）
--   → NULL 行 → Prisma 任何 default-select 讀到該行即 throw
--   `Error converting field "updatedAt" ... found incompatible value of "null"`：
--     · GET /api/conversations/:id/messages（findMany）→ 500（T300–T302）
--     · AI pipeline loadLastOutboundMeta（T85 human-recent 閘讀 staff OUT）→ ai job 崩 →
--       無 draft + 無 "human-recent" log（T85 ×3）
--
-- 修法（三行，冪等）：
--   1. 殘留 NULL 回填 createdAt（153100 已回填過既有行；呢度只補 raw INSERT 漏網 —
--      必做，否則下一步 SET NOT NULL 會 fail）
--   2. SET DEFAULT now()：raw SQL INSERT 唔帶 updatedAt 自動補（23502 唔會發生 —
--      e2e fixture 口徑唔改；Prisma 寫入仍由 client 帶值，唔依賴 default）
--   3. SET NOT NULL：同 schema 對齊（schema 無 @default — Prisma client 維護）
UPDATE "Message" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Message" ALTER COLUMN "updatedAt" SET DEFAULT now();
ALTER TABLE "Message" ALTER COLUMN "updatedAt" SET NOT NULL;
