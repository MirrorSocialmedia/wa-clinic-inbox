-- cwi-qa FX-06（QA-06）：statement_timeout 由 role 級還原 — 8s 只限 web process
--
-- 背景：20260926223241_cwi_final_s6_indexes 用
--   `ALTER ROLE wa_inbox SET statement_timeout = '8s'`
-- 但 web／worker／migrate 共用 wa_inbox role（見該 migration 自註）→
--   1) 將來大 CREATE INDEX／backfill migration 超 8s 半途失敗
--   2) cron-heavy（retention-purge、weekly-report、company-sync、followup-scan）批量 SQL 被殺
--   3) FOR UPDATE 等鎖超時
--
-- 修法：role 級 RESET；web 嘅 8s 改由 web process 嘅 DATABASE_URL options 參數承載
--   （ecosystem.config.cjs wa-inbox app 啟動時 append `&options=-c%20statement_timeout%3D8000`；
--   worker／migrate 唔加 = 0 = 無超時）。
--
-- guard 同 S6 一致：role 唔存在（CI service postgres 等）→ 跳過，唔炸 migrate。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wa_inbox') THEN
    ALTER ROLE wa_inbox RESET statement_timeout;
  END IF;
END
$$;
