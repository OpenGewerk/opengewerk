-- Every logged change of a tenant takes the counter of the sync before the
-- chain of the log (opengewerk#914). A change of a row that travels locked the
-- counter first already (`stamp_sync_columns`, then `record_change`); a change
-- of a row that does not travel took only the chain, and a transaction that
-- wrote one of those first and a row that travels after took the two the
-- other way round. The deletion by the deletion concept did so with its
-- protocol, and a change at the same moment could leave both waiting in a
-- circle until PostgreSQL broke one off. `record_change` now locks the counter
-- before the chain, without moving it, and so do the two locks of opengewerk#911
-- (`file_naming_lock`, `file_named_by_a_value`). A redaction takes both before
-- it locks its entry (`audit_redaction_checked`), as a deletion that blacks out
-- entries holds them already. The functions are the foundation's (blocks
-- `audit.sql` and `attachments.sql`).
CREATE OR REPLACE FUNCTION "record_change"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	before_row jsonb := '{}'::jsonb;
	after_row jsonb := '{}'::jsonb;
	present jsonb;
	chain public.audit_chains;
	entry public.audit_entries;
	place bigint;
	previous text;
	changed text;
	old_nonce text;
	new_nonce text;
BEGIN
	IF tg_op <> 'INSERT' THEN
		before_row := to_jsonb(old);
	END IF;

	IF tg_op <> 'DELETE' THEN
		after_row := to_jsonb(new);
	END IF;

	present := CASE WHEN tg_op = 'DELETE' THEN before_row ELSE after_row END;

	entry.tenant_id := coalesce(present ->> 'tenant_id', present ->> 'id')::uuid;
	entry.record_id := (present ->> 'id')::uuid;
	entry.change_id := uuidv7();
	entry.table_name := tg_table_name;
	entry.operation := lower(tg_op)::public.audit_operation;
	entry.changed_at := now();
	entry.user_id := nullif(current_setting('app.user_id', true), '');
	entry.reason := nullif(current_setting('app.reason', true), '');
	entry.database_role := session_user;
	entry.fingerprint_version := 3;

	-- The counter of the sync before the chain (opengewerk#914): a change of a
	-- row that travels has locked the counter already (`stamp_sync_columns`),
	-- and every other logged change takes it here as well, so that all of them
	-- take the two in one order and no two transactions of a tenant wait for
	-- each other in a circle. Locked without being moved; a row created here
	-- has handed out no number yet, so that the first is still 1.
	PERFORM 1 FROM public.sync_sequences WHERE tenant_id = entry.tenant_id FOR NO KEY UPDATE;

	IF NOT FOUND THEN
		INSERT INTO public.sync_sequences (tenant_id, next_value) VALUES (entry.tenant_id, 0) ON CONFLICT (tenant_id) DO NOTHING;
		PERFORM 1 FROM public.sync_sequences WHERE tenant_id = entry.tenant_id FOR NO KEY UPDATE;
	END IF;

	INSERT INTO public.audit_chains (tenant_id)
	VALUES (entry.tenant_id)
	ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
	RETURNING * INTO chain;

	place := chain.next_sequence;
	previous := chain.head_hash;

	FOR changed IN
		SELECT k.field
		  FROM jsonb_object_keys(before_row || after_row) AS k(field)
		 WHERE NOT (k.field = ANY (ARRAY['updated_at', 'updated_by', 'version', 'change_sequence']))
		   AND (before_row ->> k.field) IS DISTINCT FROM (after_row ->> k.field)
		 ORDER BY k.field
	LOOP
		entry.id := uuidv7();
		entry.sequence := place;
		entry.previous_hash := previous;
		entry.field := changed;
		entry.old_value := before_row ->> changed;
		entry.new_value := after_row ->> changed;
		old_nonce := CASE WHEN entry.old_value IS NULL THEN NULL
			ELSE encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex') END;
		new_nonce := CASE WHEN entry.new_value IS NULL THEN NULL
			ELSE encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex') END;
		entry.old_value_digest := public.audit_value_commitment(old_nonce, entry.old_value);
		entry.new_value_digest := public.audit_value_commitment(new_nonce, entry.new_value);
		entry.hash := public.audit_fingerprint(entry);

		INSERT INTO public.audit_entries VALUES (entry.*);

		INSERT INTO public.audit_value_nonces (entry_id, tenant_id, side, nonce)
		SELECT entry.id, entry.tenant_id, s.side, s.nonce
		  FROM (VALUES ('old', old_nonce), ('new', new_nonce)) AS s(side, nonce)
		 WHERE s.nonce IS NOT NULL;

		previous := entry.hash;
		place := place + 1;
	END LOOP;

	IF place <> chain.next_sequence THEN
		UPDATE public.audit_chains
		   SET next_sequence = place, head_hash = previous, updated_at = now()
		 WHERE tenant_id = entry.tenant_id;
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit_redaction_checked"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	entry public.audit_entries;
	found_problem text;
BEGIN
	IF new.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid
	   OR NOT EXISTS (
	     SELECT 1 FROM public.memberships m
	       JOIN public.tenant_roles r ON r.tenant_id = m.tenant_id AND r.key = ANY (m.roles) AND r.leads
	      WHERE m.tenant_id = new.tenant_id
	        AND m.user_id = nullif(current_setting('app.user_id', true), '')
	        AND m.blocked_at IS NULL
	        AND (m.last_day IS NULL OR m.last_day >= (now() AT TIME ZONE 'Europe/Berlin')::date)) THEN
		RAISE EXCEPTION 'Einen Wert im Änderungsprotokoll schwärzt nur, wer den Mandanten führt.'
			USING ERRCODE = 'insufficient_privilege';
	END IF;

	-- The counter of the sync and the chain of the log before the entry
	-- (opengewerk#914): a deletion holds both when it blacks out the entries of
	-- what it deletes, and a redaction that held the entry first and then
	-- waited for them, to log itself, would wait in a circle with it.
	PERFORM 1 FROM public.sync_sequences WHERE tenant_id = new.tenant_id FOR NO KEY UPDATE;

	IF NOT FOUND THEN
		INSERT INTO public.sync_sequences (tenant_id, next_value) VALUES (new.tenant_id, 0) ON CONFLICT (tenant_id) DO NOTHING;
		PERFORM 1 FROM public.sync_sequences WHERE tenant_id = new.tenant_id FOR NO KEY UPDATE;
	END IF;

	INSERT INTO public.audit_chains (tenant_id)
	VALUES (new.tenant_id)
	ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now();

	SELECT * INTO entry FROM public.audit_entries e
	 WHERE e.id = new.entry_id AND e.tenant_id = new.tenant_id
	   FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Diesen Eintrag gibt es im Änderungsprotokoll nicht.'
			USING ERRCODE = 'OG006';
	END IF;

	IF (new.side = 'old' AND entry.old_value IS NULL) OR (new.side = 'new' AND entry.new_value IS NULL) THEN
		RAISE EXCEPTION 'Dieser Wert ist leer oder schon geschwärzt.'
			USING ERRCODE = 'OG006';
	END IF;

	found_problem := public.audit_entry_problem(entry);

	IF found_problem IS NOT NULL THEN
		RAISE EXCEPTION 'Der Eintrag ist nicht mehr, wie er geschrieben wurde; geschwärzt wird nichts. %', found_problem
			USING ERRCODE = 'OG006';
	END IF;

	new.redacted_by := nullif(current_setting('app.user_id', true), '');

	IF entry.fingerprint_version = 1 THEN
		IF entry.old_value_digest IS NULL AND entry.new_value_digest IS NULL THEN
			entry.old_value_digest := public.audit_value_digest(entry.old_value);
			entry.new_value_digest := public.audit_value_digest(entry.new_value);
		END IF;

		new.witness := public.audit_witness(entry);
	ELSE
		new.witness := NULL;
	END IF;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "file_naming_lock"(p_tenant uuid) RETURNS void
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF p_tenant IS NULL OR p_tenant::text IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '') THEN
		RAISE EXCEPTION 'Gesperrt wird nur für den Mandanten der Transaktion.'
			USING ERRCODE = 'OG001';
	END IF;

	PERFORM 1 FROM public.sync_sequences WHERE tenant_id = p_tenant FOR NO KEY UPDATE;

	IF NOT FOUND THEN
		INSERT INTO public.sync_sequences (tenant_id, next_value) VALUES (p_tenant, 0) ON CONFLICT (tenant_id) DO NOTHING;
		PERFORM 1 FROM public.sync_sequences WHERE tenant_id = p_tenant FOR NO KEY UPDATE;
	END IF;

	INSERT INTO public.audit_chains (tenant_id)
	VALUES (p_tenant)
	ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now();
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "file_named_by_a_value"(p_tenant uuid, p_hash text) RETURNS boolean
	LANGUAGE plpgsql
	VOLATILE
	SET search_path = pg_catalog, public
AS $$
DECLARE
	named boolean;
BEGIN
	PERFORM 1 FROM public.sync_sequences WHERE tenant_id = p_tenant FOR NO KEY UPDATE;

	IF NOT FOUND THEN
		INSERT INTO public.sync_sequences (tenant_id, next_value) VALUES (p_tenant, 0) ON CONFLICT (tenant_id) DO NOTHING;
		PERFORM 1 FROM public.sync_sequences WHERE tenant_id = p_tenant FOR NO KEY UPDATE;
	END IF;

	INSERT INTO public.audit_chains (tenant_id)
	VALUES (p_tenant)
	ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now();

	IF to_regprocedure('public.application_file_named_by_a_value(uuid,text)') IS NULL THEN
		RETURN false;
	END IF;

	EXECUTE 'SELECT public.application_file_named_by_a_value($1, $2)' INTO named USING p_tenant, p_hash;

	RETURN coalesce(named, false);
END;
$$;
