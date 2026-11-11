-- The file of a certificate goes when it is replaced or taken off, as when
-- its qualification goes with the file of its person (0131), and in neither
-- case while another record still names it (opengewerk#802).
--
-- - A file is named by a key (attachment versions, document files,
--   letterheads, qualifications) or by a value: the files of a price list
--   import (`article_imports.files`) and the logo in the content of a document
--   as it was written (`document_snapshots.content`, `issuer.logo.sha256`).
--   `qualification_takes_its_certificate` (0131) asked only the keys, through
--   the deletion they refuse, and took a file a value still named, once a
--   route let a qualification name any file of the tenant. It asks
--   `file_named_by_a_value` first now.
-- - That function runs as the owner of the tables, under their policies:
--   `article_imports` lets the owner read since 0062, `document_snapshots`
--   gets the same policy here.
-- - The trigger after an update of the hash runs the same function, so that
--   the file of an earlier certificate does not stay in the store after the
--   file of its person is deleted, with no row naming it any more.
CREATE POLICY "readable_by_the_owner" ON "document_snapshots" AS PERMISSIVE FOR SELECT TO current_user USING (true);--> statement-breakpoint
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
	-- A row the lock let go, one of a file being deleted (0131), or one whose
	-- certificate was replaced or taken off (0139).
	IF old.certificate_sha256 IS NULL THEN
		RETURN NULL;
	END IF;

	-- Named by a value, which no key holds: it stays.
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
CREATE TRIGGER "qualifications_take_their_replaced_certificate" AFTER UPDATE OF "certificate_sha256" ON "qualifications"
	FOR EACH ROW WHEN (old.certificate_sha256 IS DISTINCT FROM new.certificate_sha256) EXECUTE FUNCTION "qualification_takes_its_certificate"();
