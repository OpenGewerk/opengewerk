-- Takes back 0140: the versions of the archive and the files of a document ask
-- the keys alone again, `file_named_by_a_value` is the question of 0139 again,
-- without the lock, and the lock and the application's half go. Run as the
-- superuser, like every rollback.
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
CREATE OR REPLACE FUNCTION "file_named_by_a_value"(p_tenant uuid, p_hash text) RETURNS boolean
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
DROP FUNCTION IF EXISTS "file_naming_lock"(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS "application_file_named_by_a_value"(uuid, text);
