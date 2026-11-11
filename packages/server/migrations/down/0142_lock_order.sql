-- Takes back 0142: the writer of the log locks the chain alone again, and the
-- two locks of 0140 take the chain alone. Run as the superuser, like every
-- rollback.
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
