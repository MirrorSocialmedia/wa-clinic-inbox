-- ★ cwi-followup-v3-20260916（S3/B-9）：Contact.locale — zh（default）| en。
-- B-9：EN template（*_en）由 Contact.locale 決定；salutation 唔自動估（人手可改）。
ALTER TABLE "Contact" ADD COLUMN "locale" TEXT;
