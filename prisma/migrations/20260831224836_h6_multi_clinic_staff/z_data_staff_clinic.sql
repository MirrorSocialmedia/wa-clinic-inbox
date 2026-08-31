-- cwi-h6-20260830 §1：data migration — 所有 clinicId != null 嘅 STAFF → 插 StaffClinic 行（isPrimary=true）。
-- ADMIN 唔插（佢全店）。冪等（ON CONFLICT DO NOTHING — migration 重跑 / 手動補跑安全）。
INSERT INTO "StaffClinic" ("staffId", "clinicId", "isPrimary", "createdAt")
SELECT "id", "clinicId", true, now()
FROM "StaffUser"
WHERE "role" = 'STAFF' AND "clinicId" IS NOT NULL
ON CONFLICT ("staffId", "clinicId") DO NOTHING;
