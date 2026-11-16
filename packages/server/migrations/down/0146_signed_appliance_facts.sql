-- Takes back 0146 (opengewerk#954). The facts a test of an appliance was
-- signed with belong to what it proves: this rollback deletes none of them.
-- While a protocol holds them, it stops and changes nothing. Which they are,
-- this shows:
--
--   select id, appliance_id, appliance_facts from form_records where appliance_facts is not null;
--
-- The owner sees no row of a table under FORCE, so the check looks past the
-- policy. Check and change are one statement: the lock the first ALTER takes
-- holds until its end, so no protocol can be signed between the check and the
-- drop of the column, and if anything fails, nothing of it stays changed. Run
-- as the superuser, like every rollback.
DO $$
BEGIN
	ALTER TABLE "form_records" NO FORCE ROW LEVEL SECURITY;

	IF EXISTS (SELECT 1 FROM "form_records" WHERE "appliance_facts" IS NOT NULL) THEN
		RAISE EXCEPTION 'Es gibt unterschriebene Prüfungen von Geräten mit den Angaben, mit denen sie unterschrieben wurden (#954). Die Rücknahme von 0146 löscht keine Nachweise und bricht deshalb ab; wer sie trotzdem braucht, sichert die Datenbank vorher. Welche es sind, zeigt die Abfrage in der Rücknahme von 0146.';
	END IF;

	DROP TRIGGER "form_records_appliance_facts" ON "form_records";
	DROP FUNCTION "form_record_appliance_facts"();
	ALTER TABLE "form_records" DROP CONSTRAINT "form_records_appliance_facts_signed";
	ALTER TABLE "form_records" DROP COLUMN "appliance_facts";
	ALTER TABLE "form_records" FORCE ROW LEVEL SECURITY;
END
$$;
