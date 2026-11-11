-- Takes the name of a certificate out again, back to how 0137 left things.
-- Run as the superuser, like every rollback.
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_certificate_name_fits";--> statement-breakpoint
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_certificate_named";--> statement-breakpoint
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "certificate_name";
