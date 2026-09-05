-- cwi-inboxfix-20260905（T6 / MD §5.3）：Message.voidedAt — 「標記為已作廢」純內部標記。
--
-- 語義：8 秒撤回窗口過咗之後（訊息已經發出，病人嗰邊照見），staff 可以將該 OUT 訊息
--   標記為「已作廢」（內部口徑：呢句當佢冇發過 — 後續更正訊息為準）。
--   ⚠️ 唔會通知 Meta / 病人端 — WhatsApp Cloud API 冇刪除已發訊息 endpoint（MD §5 背景）。
--   UI：氣泡加「已作廢」內部 tag + 可一鍵插入更正草稿模板。
--
-- 零鎖：純 additive（ADD COLUMN nullable）。

ALTER TABLE "Message" ADD COLUMN "voidedAt" TIMESTAMPTZ;
