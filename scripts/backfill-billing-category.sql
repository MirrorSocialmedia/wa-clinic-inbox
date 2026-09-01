-- cwi-window-20260901（P1）：billingCategory 冪等 backfill（同 migration
-- 20260901172013_window_billing_category 內嘅同一段 UPDATE — 可單獨重跑）。
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
