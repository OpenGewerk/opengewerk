-- The versions of a file in the records of a tenant: what keeps one as it was
-- written. The two tables come from the schema of an application that keeps
-- such files (`attachmentsSchema`), and the triggers that call these functions
-- from the description of the table of versions; in here are the functions.
--
-- A new version is a new row, and an old one stays readable. The grant of the
-- application role stops at INSERT and DELETE, and the second function refuses
-- every change to everybody, the owner of the table included, like a
-- signature, and every deletion but one: a document that goes for good on the
-- way an application opens for it (opengewerk/opengewerk#658), at the end of a
-- retention. Then the file of a version goes as well, the row of the tenant in
-- `files`, once nothing else names it: taken by the trigger of the version,
-- since the application role may not delete in `files` at all.
--
-- Everything that reads a table of the records is plpgsql: these functions
-- stand in every database the blocks build, also in one without such tables.

-- Who stored the version, from the request and from nothing else: who and
-- when is what the metadata of a file has to say.
CREATE FUNCTION "record_attachment_uploader"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	new.created_by := nullif(current_setting('app.user_id', true), '');

	RETURN new;
END;
$$;--> statement-breakpoint

-- Whether the application lets this document go for good now (#658). The
-- foundation does not know when a document may go; an application that lets
-- one go defines `application_attachment_may_go(uuid)` in a migration of its
-- own and answers there, from what this transaction has done. Without it,
-- nothing goes.
CREATE FUNCTION "attachment_may_go"(p_attachment uuid) RETURNS boolean
	LANGUAGE plpgsql
	STABLE
	SET search_path = pg_catalog, public
AS $$
DECLARE
	allowed boolean;
BEGIN
	IF p_attachment IS NULL OR to_regprocedure('public.application_attachment_may_go(uuid)') IS NULL THEN
		RETURN false;
	END IF;

	EXECUTE 'SELECT public.application_attachment_may_go($1)' INTO allowed USING p_attachment;

	RETURN coalesce(allowed, false);
END;
$$;--> statement-breakpoint

-- Whether this document is going for good in this very statement: what
-- `purge_attachment` is doing, and what the application allows. The locks
-- let a deletion through on it, and the log writes nothing then.
CREATE FUNCTION "attachment_purging"(p_attachment uuid) RETURNS boolean
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT p_attachment IS NOT NULL
	   AND coalesce(current_setting('app.purging_attachment', true), '') = p_attachment::text
	   AND public.attachment_may_go(p_attachment)
$$;--> statement-breakpoint

-- Refuses every change and every deletion, whoever asks, but the deletion of
-- the versions of a document that goes for good. A version whose hash could be
-- changed afterwards would show somebody a different file than the one a
-- decision was taken on.
CREATE FUNCTION "attachment_version_stays_as_written"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'DELETE' AND public.attachment_purging(old.attachment_id) THEN
		RETURN old;
	END IF;

	RAISE EXCEPTION 'Eine Fassung einer Datei wird weder geändert noch gelöscht.'
		USING ERRCODE = 'OG001';
END;
$$;--> statement-breakpoint

-- A file of a tenant goes only with a version of a document that goes for
-- good (#658), taken by `version_takes_its_files` and named by it while it
-- does; whether anything else still names it, the keys onto `files` decide,
-- also in areas the person who asks does not see. The application role has
-- no DELETE here, and the owner of the table is held to the same: a setting
-- that names the document is not enough, the file has to be the one the
-- version is taking.
CREATE FUNCTION "file_goes_with_its_document"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF coalesce(current_setting('app.taking_file', true), '') = old.tenant_id::text || '/' || old.sha256 THEN
		RETURN old;
	END IF;

	RAISE EXCEPTION 'Eine Datei geht nur mit dem Dokument, das sie als Letztes nennt.'
		USING ERRCODE = 'OG001';
END;
$$;--> statement-breakpoint

-- The lock under which a file of a tenant is named in a value rather than by
-- a key (opengewerk#911): the row of the tenant's chain of the log, the one
-- every logged change locks to the end of its transaction (`record_change`).
-- Taken by whoever is about to name a file in a value, before it reads
-- `files`; a function that takes a file for good takes it as well before it
-- asks whether a value names the file (`file_named_by_a_value`). So the two
-- never cross: one waits for the other to end and then sees what it did. The
-- chain and not a lock of its own, because a transaction that writes holds
-- the chain anyway, and a second lock beside it could be taken the other way
-- round and leave two transactions waiting for each other.
--
-- The chain alone, as a change of a row that does not travel locks it. A
-- transaction that writes rows that travel takes the counter of the sync
-- before the chain (`stamp_sync_columns` before `record_change`); it names a
-- file after its first such write, when it holds both, so that no lock is
-- taken the other way round. SECURITY DEFINER because the application role
-- may not touch the chain, and only for the tenant of the transaction, so
-- that nobody holds up the writes of another tenant. The row is created on
-- first use, as the writer does.
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

-- Whether a record still names a file of a tenant by a value rather than by a
-- key (opengewerk#911), asked before a file goes for good: the keys onto
-- `files` refuse the deletion of a file a record names, a value does not. The
-- foundation does not know where an application keeps a file in a value; an
-- application that does defines `application_file_named_by_a_value(uuid, text)`
-- in a migration of its own and answers there. Without it, no value names a
-- file. The chain of the tenant is locked first, as `file_naming_lock` does,
-- so that the answer includes a name written by a transaction that held it. A
-- deletion has locked the chain already with its own protocol, so the
-- question adds no lock to it, and none in another order.
CREATE FUNCTION "file_named_by_a_value"(p_tenant uuid, p_hash text) RETURNS boolean
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

-- The files of a version that went with its document (#658), after the
-- deletion: its file and its preview, each once no key names it any more and
-- no value either (`file_named_by_a_value`, opengewerk#911).
-- Only a deletion the lock of the version let through gets here, and that is
-- one while its document goes for good; the setting is asked once more, not
-- the application, whose answer is for the person who asks.
--
-- It runs as the owner of the tables, because the application role may not
-- delete in `files`: a file goes with the version that names it and never
-- because somebody names it. The lock of `files` lets exactly this file
-- through, and the log of `files` writes that it went.
CREATE FUNCTION "version_takes_its_files"() RETURNS trigger
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

-- Lets a document go for good (#658), on the way the application opens for it
-- (`application_attachment_may_go`) and nowhere else: its versions go, and so
-- does the file of each version in `files` once nothing else names it, who
-- stored it with it, by the trigger of the version; the document stays as a
-- row marked as deleted under the title the application gives, so that a
-- device that was offline learns that it is gone. Run as whoever asks, in
-- their transaction: what the policies show is what goes. Says how many files
-- went.
CREATE FUNCTION "purge_attachment"(p_attachment uuid, p_title text) RETURNS integer
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	tenant uuid;
	named text[];
	before text := current_setting('app.purging_attachment', true);
	left_over integer;
BEGIN
	IF NOT public.attachment_may_go(p_attachment) THEN
		RAISE EXCEPTION 'Ein Dokument wird nur auf dem Weg endgültig gelöscht, den die Anwendung dafür öffnet.'
			USING ERRCODE = 'OG001';
	END IF;

	EXECUTE 'SELECT tenant_id FROM public.attachments WHERE id = $1' INTO tenant USING p_attachment;

	IF tenant IS NULL THEN
		RETURN 0;
	END IF;

	PERFORM set_config('app.purging_attachment', p_attachment::text, true);

	EXECUTE 'SELECT coalesce(array_agg(DISTINCT named.hash), ''{}'')
	           FROM (SELECT sha256 AS hash FROM public.attachment_versions WHERE attachment_id = $1
	                 UNION
	                 SELECT preview_sha256 FROM public.attachment_versions
	                  WHERE attachment_id = $1 AND preview_sha256 IS NOT NULL) AS named'
	   INTO named USING p_attachment;

	EXECUTE 'DELETE FROM public.attachment_versions WHERE attachment_id = $1' USING p_attachment;
	EXECUTE 'UPDATE public.attachments SET title = $2, deleted_at = coalesce(deleted_at, now()) WHERE id = $1'
	  USING p_attachment, p_title;

	SELECT count(*) INTO left_over FROM public.files WHERE tenant_id = tenant AND sha256 = ANY (named);

	PERFORM set_config('app.purging_attachment', coalesce(before, ''), true);

	RETURN cardinality(named) - left_over;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "file_named_by_a_value"(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "file_naming_lock"(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "file_naming_lock"(uuid) TO "opengewerk_app";
