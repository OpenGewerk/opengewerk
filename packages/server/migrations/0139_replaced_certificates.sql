-- The certificates a qualification named before (opengewerk#802). One that is
-- replaced or taken off stays in the store until the file of its person goes
-- by the deletion concept (decided by Moritz on 11.11.2026): a mistake in the
-- dialog loses no file, and nothing of the person stays after.
--
-- - `replaced_certificates` (the foundation's, `qualificationSchema`) holds
--   each by a key on `files`, with the person and the qualification. The
--   trigger after an update of the hash writes the row, as whoever changes
--   the qualification; the application may read and insert, and delete only
--   while the file of the person is deleted (`goes_with_the_file`, 0131), the
--   same as the qualification itself.
-- - When a row goes, its file goes as well, as the owner of the tables
--   through the lock of 0087, unless another record still names it
--   (`replaced_certificate_takes_its_file`), as 0131 does for the certificate
--   a qualification names when it goes.
-- - A file is named by a key or by a value: the files of a price list import
--   (`article_imports.files`) and the logo in the content of a document as it
--   was written (`document_snapshots.content`, `issuer.logo.sha256`). Both
--   functions that take a certificate ask `file_named_by_a_value` first; the
--   one of 0131 asked only the keys. It runs as the owner of the tables,
--   under their policies: `article_imports` lets the owner read since 0062,
--   `document_snapshots` gets the same policy here.
CREATE TABLE "replaced_certificates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"qualification_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replaced_certificates_is_a_hash" CHECK ("replaced_certificates"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "replaced_certificates_name_fits" CHECK (char_length("replaced_certificates"."name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "replaced_certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "replaced_certificates" ADD CONSTRAINT "replaced_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replaced_certificates" ADD CONSTRAINT "replaced_certificates_of_somebody_here" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replaced_certificates" ADD CONSTRAINT "replaced_certificates_of_a_qualification_here" FOREIGN KEY ("tenant_id","qualification_id") REFERENCES "public"."qualifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replaced_certificates" ADD CONSTRAINT "replaced_certificates_stored" FOREIGN KEY ("tenant_id","sha256") REFERENCES "public"."files"("tenant_id","sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replaced_certificates_of_a_person" ON "replaced_certificates" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE POLICY "readable_by_the_owner" ON "document_snapshots" AS PERMISSIVE FOR SELECT TO current_user USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "replaced_certificates" AS PERMISSIVE FOR ALL TO "opengewerk_app" USING ("replaced_certificates"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("replaced_certificates"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "replaced_certificates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "replaced_certificates" TO "opengewerk_app";--> statement-breakpoint
CREATE TRIGGER "audit_changes" AFTER INSERT OR UPDATE OR DELETE ON "replaced_certificates"
	FOR EACH ROW EXECUTE FUNCTION "record_change"();--> statement-breakpoint
CREATE FUNCTION "file_named_by_a_value"(p_tenant uuid, p_hash text) RETURNS boolean
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT EXISTS (
		SELECT 1 FROM public.article_imports
		 WHERE tenant_id = p_tenant
		   AND files @> jsonb_build_array(jsonb_build_object('sha256', p_hash))
	) OR EXISTS (
		SELECT 1 FROM public.document_snapshots
		 WHERE tenant_id = p_tenant
		   AND content #>> '{issuer,logo,sha256}' = p_hash
	);
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "file_named_by_a_value"(uuid, text) FROM PUBLIC;--> statement-breakpoint
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

	-- Named by a value, which no key holds: it stays (0139).
	IF public.file_named_by_a_value(old.tenant_id, old.certificate_sha256) THEN
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
CREATE FUNCTION "qualification_keeps_its_replaced_certificate"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	INSERT INTO public.replaced_certificates (tenant_id, person_id, qualification_id, sha256, name)
	VALUES (old.tenant_id, old.person_id, old.id, old.certificate_sha256, old.certificate_name);

	RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "qualification_keeps_its_replaced_certificate"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "qualifications_keep_their_replaced_certificate" AFTER UPDATE OF "certificate_sha256" ON "qualifications"
	FOR EACH ROW WHEN (old.certificate_sha256 IS NOT NULL AND old.certificate_sha256 IS DISTINCT FROM new.certificate_sha256)
	EXECUTE FUNCTION "qualification_keeps_its_replaced_certificate"();--> statement-breakpoint
CREATE TRIGGER "replaced_certificates_go_with_the_file" BEFORE DELETE ON "replaced_certificates"
	FOR EACH ROW EXECUTE FUNCTION "goes_with_the_file"('Ein früherer Nachweis wird nur mit der Akte nach dem Löschkonzept gelöscht.');--> statement-breakpoint
CREATE FUNCTION "replaced_certificate_takes_its_file"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	-- Only a row the lock let go reaches this: one of a file being deleted.
	IF public.file_named_by_a_value(old.tenant_id, old.sha256) THEN
		RETURN NULL;
	END IF;

	PERFORM set_config('app.taking_file', old.tenant_id::text || '/' || old.sha256, true);

	BEGIN
		DELETE FROM public.files WHERE tenant_id = old.tenant_id AND sha256 = old.sha256;
	EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
		-- Another record still names the file, and it stays.
		NULL;
	END;

	PERFORM set_config('app.taking_file', '', true);

	RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "replaced_certificate_takes_its_file"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "replaced_certificates_take_their_file" AFTER DELETE ON "replaced_certificates"
	FOR EACH ROW EXECUTE FUNCTION "replaced_certificate_takes_its_file"();
