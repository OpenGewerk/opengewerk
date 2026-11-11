-- Takes the name of a certificate out again, back to how 0137 left things.
-- Run as the superuser, like every rollback. A qualification that names a
-- certificate would lose its name, and 0138 could not come back over it,
-- since a certificate is a file with its name; while there is one, it stops.
-- Which they are, this shows:
--
--   select id, person_id, certificate_name from qualifications
--    where certificate_sha256 is not null;

DO $$
BEGIN
	ALTER TABLE "qualifications" NO FORCE ROW LEVEL SECURITY;

	IF EXISTS (SELECT 1 FROM "qualifications" WHERE "certificate_sha256" IS NOT NULL) THEN
		RAISE EXCEPTION 'Es gibt Qualifikationen mit einem Nachweis. Die Rücknahme von 0138 nähme ihnen den Namen und bricht deshalb ab.';
	END IF;

	ALTER TABLE "qualifications" FORCE ROW LEVEL SECURITY;
END
$$;--> statement-breakpoint
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_certificate_name_fits";--> statement-breakpoint
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_certificate_named";--> statement-breakpoint
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "certificate_name";
