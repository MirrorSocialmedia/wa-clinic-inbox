-- ★ cwi-final B3 fix：Alert 冪等 race — upsertAlert 係 check-then-insert（findFirst → create）非原子。
--   DLQ 场景：3 條 job 同時最終失敗（PG 重啟後並行 retry）→ 3 個 upsertAlert 同毫秒都睇到 0 條未解決
--   → 3 條 create 成功 → 3 條 alert + 3 次 notifyAlert（T610 實錘 alertOpen=3，期望 1）。
--   語義（alerts.ts 文件註明）：同 (type, clinicId) 未解決只可有一條。
--
-- ⚠️ clinicId 可為 NULL（inbound_failed 全部 NULL）— Postgres unique index 預設 NULL 互不相等 →
--   用 coalesce 表達式索引先有效。
-- 前置：跑前 dev/生產同 (type, coalesce(clinicId,'')) 只可有一條未解決（deploy 前如生產有重複要先行手冚冚 resolve 舊）。

CREATE UNIQUE INDEX "Alert_type_open_clinic_key"
  ON "Alert"("type", coalesce("clinicId", ''))
  WHERE "resolvedAt" IS NULL;
