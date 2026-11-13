-- Takes back 0143 (opengewerk#817). A file of an appliance is a record a
-- business keeps, and its photo may stand in a signed protocol: this rollback
-- deletes none of them. While a file hangs on an appliance, it stops and
-- changes nothing. Which they are, this shows:
--
--   select id, title, appliance_id from attachments where appliance_id is not null;
--
-- The owner sees no row of a table under FORCE, so the check looks past the
-- policy. Check and change are one statement: the lock the first ALTER takes
-- holds until its end, so no file can be hung on an appliance between the
-- check and the drop of the column, and if anything fails, nothing of it
-- stays changed. Run as the superuser, like every rollback.
DO $$
BEGIN
	ALTER TABLE "attachments" NO FORCE ROW LEVEL SECURITY;

	IF EXISTS (SELECT 1 FROM "attachments" WHERE "appliance_id" IS NOT NULL) THEN
		RAISE EXCEPTION 'Es gibt Dateien an Geräten (#817). Die Rücknahme von 0143 löscht keine Dateien und bricht deshalb ab; wer sie trotzdem braucht, sichert die Datenbank und hängt die Dateien vorher selbst an einen anderen Ort. Welche es sind, zeigt die Abfrage in der Rücknahme von 0143.';
	END IF;

	ALTER TABLE "attachments" DROP CONSTRAINT "attachments_have_a_home";
	ALTER TABLE "attachments" DROP CONSTRAINT "attachments_appliance_in_tenant";
	DROP INDEX "attachments_appliance_idx";
	ALTER TABLE "attachments" DROP COLUMN "appliance_id";
	ALTER TABLE "attachments" ADD CONSTRAINT "attachments_have_a_home" CHECK (num_nonnulls("attachments"."customer_id", "attachments"."site_id", "attachments"."installation_id", "attachments"."job_id") >= 1);
	ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
END
$$;
