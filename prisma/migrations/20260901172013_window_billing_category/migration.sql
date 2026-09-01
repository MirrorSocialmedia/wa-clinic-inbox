-- AlterTable
ALTER TABLE "AiDraft" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "billingCategory" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- cwi-window-20260901（P1）：billingCategory 冪等 backfill（h6 先例）。
--
-- 只填 billingCategory IS NULL 嘅 row — 重跑零副作用（冪等）：
--   - APP_ECHO / INTERNAL      → NONE（回音/內部備註唔計費）
--   - OUT + API + template     → 按其類別（templateMeta->>'category'）：
--       MARKETING→MARKETING、AUTHENTICATION→AUTH、其餘→UTILITY（declared fallback —
--       舊 row 冇存過 category 時，mock/已知 reminder 範本全部係 UTILITY）
--   - OUT + API（其他 type）   → SERVICE（窗口內人手/AI 自由回覆都係 service）
--   - IN / HISTORY / OUT-APP_ECHO 以外未覆蓋 → NULL 保持（入站唔計費）
--
-- 寫入規則（code 層）同呢度一致：見 src/lib/wa/billing.ts + 各 outbound 寫入點。
-- 可單獨重跑：scripts/backfill-billing-category.sql（同一段 UPDATE）。
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "Message" SET "billingCategory" = CASE
  WHEN "channel" IN ('APP_ECHO', 'INTERNAL') THEN 'NONE'
  WHEN "channel" = 'API' AND "direction" = 'OUT' AND "type" = 'template' THEN
    CASE COALESCE("templateMeta" ->> 'category', '')
      WHEN 'MARKETING' THEN 'MARKETING'
      WHEN 'AUTHENTICATION' THEN 'AUTH'
      ELSE 'UTILITY'
    END
  WHEN "channel" = 'API' AND "direction" = 'OUT' THEN 'SERVICE'
  ELSE NULL
END
WHERE "billingCategory" IS NULL;
