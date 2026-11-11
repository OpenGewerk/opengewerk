-- A file goes for good only once nothing names it, by a key or by a value,
-- on every way that takes one (opengewerk#911), and never while somebody is
-- about to name it.
--
-- - `file_named_by_a_value` is the foundation's now (block `attachments.sql`):
--   it locks the tenant's chain of the log, as every logged change does, and
--   then asks the application, which answers in
--   `application_file_named_by_a_value` the question 0139 asked: the files of
--   a price list import and the logo in the content of a document as it was
--   written.
-- - `file_naming_lock` takes the same lock for the tenant of the transaction.
--   The import takes it before it reads its files in `files`; the writing of
--   a document holds it already when it reads its logo once more, from the
--   change of the document before. So a file is either named and kept, or
--   gone before it is read.
-- - The versions of the archive (`version_takes_its_files`, 0087) and the
--   files of a document (`document_file_takes_its_file`, 0130) ask it as the
--   certificates of a qualification do since 0139.
CREATE FUNCTION "application_file_named_by_a_value"(p_tenant uuid, p_hash text) RETURNS boolean
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
REVOKE EXECUTE ON FUNCTION "application_file_named_by_a_value"(uuid, text) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "file_naming_lock"(p_tenant uuid) RETURNS void
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF p_tenant IS NULL OR p_tenant::text IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '') THEN
		RAISE EXCEPTION 'Gesperrt wird nur für den Mandanten der Transaktion.'
			USING ERRCODE = 'OG001';
	END IF;

	INSERT INTO public.audit_chains (tenant_id)
	VALUES (p_tenant)
	ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now();
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "file_naming_lock"(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "file_naming_lock"(uuid) TO "opengewerk_app";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "file_named_by_a_value"(p_tenant uuid, p_hash text) RETURNS boolean
	LANGUAGE plpgsql
	VOLATILE
	SET search_path = pg_catalog, public
AS $$
DECLARE
	named boolean;
BEGIN
	INSERT INTO public.audit_chains (tenant_id)
	VALUES (p_tenant)
	ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now();

	IF to_regprocedure('public.application_file_named_by_a_value(uuid,text)') IS NULL THEN
		RETURN false;
	END IF;

	EXECUTE 'SELECT public.application_file_named_by_a_value($1, $2)' INTO named USING p_tenant, p_hash;

	RETURN coalesce(named, false);
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "version_takes_its_files"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	hash text;
BEGIN
	IF coalesce(current_setting('app.purging_attachment', true), '') <> old.attachment_id::text THEN
		RETURN NULL;
	END IF;

	FOREACH hash IN ARRAY ARRAY[old.sha256, old.preview_sha256] LOOP
		CONTINUE WHEN hash IS NULL;
		CONTINUE WHEN public.file_named_by_a_value(old.tenant_id, hash);

		PERFORM set_config('app.taking_file', old.tenant_id::text || '/' || hash, true);

		BEGIN
			DELETE FROM public.files WHERE tenant_id = old.tenant_id AND sha256 = hash;
		EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
			-- Another record still names the file, and it stays.
			NULL;
		END;
	END LOOP;

	PERFORM set_config('app.taking_file', '', true);

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "document_file_takes_its_file"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	hash text;
BEGIN
	-- Only a row the lock let go reaches this: one of a customer being deleted.
	SELECT sha256 INTO hash FROM public.files WHERE id = old.file_id AND tenant_id = old.tenant_id;

	IF hash IS NULL THEN
		RETURN NULL;
	END IF;

	-- Named by a value, which no key holds: it stays (0140).
	IF public.file_named_by_a_value(old.tenant_id, hash) THEN
		RETURN NULL;
	END IF;

	PERFORM set_config('app.taking_file', old.tenant_id::text || '/' || hash, true);

	BEGIN
		DELETE FROM public.files WHERE id = old.file_id AND tenant_id = old.tenant_id;
	EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
		-- Another record still names the file, and it stays.
		NULL;
	END;

	PERFORM set_config('app.taking_file', '', true);

	RETURN NULL;
END;
$$;
