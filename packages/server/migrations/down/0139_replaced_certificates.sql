-- Takes back 0139: the earlier certificates with their triggers, the question
-- for files named by a value and the reading policy for the owner on the
-- content of documents; the function of the certificate is as 0131 wrote it
-- again. Run as the superuser, like every rollback. An earlier certificate
-- would leave its file in the store with nothing naming it, and the deletion
-- of the file of its person would not find it any more; while there is one,
-- it stops. Which they are, this shows:
--
--   select person_id, qualification_id, name from replaced_certificates;

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "replaced_certificates") THEN
		RAISE EXCEPTION 'Es gibt frühere Nachweise. Die Rücknahme von 0139 ließe ihre Dateien ohne Halt im Speicher und bricht deshalb ab.';
	END IF;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "qualifications_keep_their_replaced_certificate" ON "qualifications";--> statement-breakpoint
DROP TABLE IF EXISTS "replaced_certificates";--> statement-breakpoint
DROP FUNCTION IF EXISTS "replaced_certificate_takes_its_file"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "qualification_keeps_its_replaced_certificate"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "qualification_takes_its_certificate"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	-- Only a row the lock let go reaches this: one of a file being deleted.
	IF old.certificate_sha256 IS NULL THEN
		RETURN NULL;
	END IF;

	PERFORM set_config('app.taking_file', old.tenant_id::text || '/' || old.certificate_sha256, true);

	BEGIN
		DELETE FROM public.files WHERE tenant_id = old.tenant_id AND sha256 = old.certificate_sha256;
	EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
		-- Another record still names the file, and it stays.
		NULL;
	END;

	PERFORM set_config('app.taking_file', '', true);

	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS "file_named_by_a_value"(uuid, text);--> statement-breakpoint
DROP POLICY IF EXISTS "readable_by_the_owner" ON "document_snapshots";
