-- Many logged changes in one transaction take about the same time each
-- (opengewerk#953). Every change moved the counter of the sync and the chain of
-- the log and found both rows again through their keys, past every version the
-- transaction had written of them; 152 000 changes in one transaction had not
-- ended after nine minutes. The counter and the locks now go through the
-- address the transaction holds (`counter_address`), and the chain is opened
-- by the first change of a transaction and written once, before the commit
-- (`opened_in`, `close_audit_chain`). The functions are the foundation's
-- (blocks `sync.sql`, `audit.sql` and `attachments.sql`).
ALTER TABLE "audit_chains" ADD COLUMN "opened_in" "xid8";--> statement-breakpoint
CREATE FUNCTION "counter_hint"(kind text, tenant uuid) RETURNS text
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT current_setting('opengewerk_' || kind || '.t' || replace(tenant::text, '-', ''), true);
$$;--> statement-breakpoint
CREATE FUNCTION "keep_counter_hint"(kind text, tenant uuid, hint text) RETURNS void
	LANGUAGE sql
	VOLATILE
	SET search_path = pg_catalog, public
AS $$
	SELECT set_config('opengewerk_' || kind || '.t' || replace(tenant::text, '-', ''), hint, true);
$$;--> statement-breakpoint
CREATE FUNCTION "counter_address"(kind text, tenant uuid) RETURNS tid
	LANGUAGE plpgsql
	STABLE
	SET search_path = pg_catalog, public
AS $$
DECLARE
	parts text[] := regexp_match(public.counter_hint(kind, tenant), '^\((\d{1,10}),(\d{1,5})\)$');
BEGIN
	-- Within the range of a `tid` as well, so that a made-up address finds
	-- nothing rather than failing the cast.
	IF parts IS NOT NULL AND parts[1]::bigint <= 4294967295 AND parts[2]::integer <= 65535 THEN
		RETURN ('(' || parts[1] || ',' || parts[2] || ')')::tid;
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "lock_sync_counter"(tenant uuid) RETURNS void
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
	SET enable_seqscan = off
	SET enable_indexscan = off
	SET enable_bitmapscan = off
AS $$
DECLARE
	address tid := public.counter_address('sync', tenant);
BEGIN
	IF address IS NOT NULL THEN
		SELECT ctid INTO address FROM public.sync_sequences
		 WHERE ctid = address AND tenant_id = tenant FOR NO KEY UPDATE;
	END IF;

	IF address IS NULL THEN
		SELECT ctid INTO address FROM public.sync_sequences WHERE tenant_id = tenant FOR NO KEY UPDATE;

		IF NOT FOUND THEN
			INSERT INTO public.sync_sequences (tenant_id, next_value) VALUES (tenant, 0) ON CONFLICT (tenant_id) DO NOTHING;
			SELECT ctid INTO address FROM public.sync_sequences WHERE tenant_id = tenant FOR NO KEY UPDATE;
		END IF;

		PERFORM public.keep_counter_hint('sync', tenant, address::text);
	END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "lock_audit_chain"(tenant uuid, OUT next_sequence bigint, OUT head_hash text, OUT opened_in xid8, OUT address tid)
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
	SET enable_seqscan = off
	SET enable_indexscan = off
	SET enable_bitmapscan = off
AS $$
BEGIN
	address := public.counter_address('audit', tenant);

	IF address IS NOT NULL THEN
		SELECT c.next_sequence, c.head_hash, c.opened_in, c.ctid INTO next_sequence, head_hash, opened_in, address
		  FROM public.audit_chains c
		 WHERE c.ctid = address AND c.tenant_id = tenant FOR NO KEY UPDATE;
	END IF;

	IF address IS NULL THEN
		SELECT c.next_sequence, c.head_hash, c.opened_in, c.ctid INTO next_sequence, head_hash, opened_in, address
		  FROM public.audit_chains c
		 WHERE c.tenant_id = tenant FOR NO KEY UPDATE;

		IF NOT FOUND THEN
			INSERT INTO public.audit_chains AS c (tenant_id)
			VALUES (tenant)
			ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
			RETURNING c.next_sequence, c.head_hash, c.opened_in, c.ctid INTO next_sequence, head_hash, opened_in, address;
		END IF;

		PERFORM public.keep_counter_hint('audit', tenant, address::text);
	END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "audit_chain_head"(tenant uuid, committed_place bigint, committed_hash text, OUT place bigint, OUT previous text)
	LANGUAGE plpgsql
	STABLE
	SET search_path = pg_catalog, public
	SET enable_seqscan = off
	SET enable_bitmapscan = off
	SET enable_sort = off
AS $$
DECLARE
	held text := public.counter_hint('audit_head', tenant);
	last record;
BEGIN
	place := committed_place;
	previous := committed_hash;

	IF held = 'opened' THEN
		RETURN;
	END IF;

	IF held ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
		SELECT e.tenant_id, e.sequence, e.hash INTO last FROM public.audit_entries e WHERE e.id = held::uuid;

		IF FOUND AND last.tenant_id = tenant AND last.sequence >= committed_place THEN
			place := last.sequence + 1;
			previous := last.hash;
			RETURN;
		END IF;
	END IF;

	SELECT e.sequence + 1, e.hash INTO place, previous
	  FROM public.audit_entries e
	 WHERE e.tenant_id = tenant AND e.sequence >= committed_place
	 ORDER BY e.sequence DESC
	 LIMIT 1;

	IF NOT FOUND THEN
		place := committed_place;
		previous := committed_hash;
	END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "close_audit_chain"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	SET enable_seqscan = off
	SET enable_bitmapscan = off
	SET enable_sort = off
AS $$
DECLARE
	chain record;
	place bigint;
	previous text;
BEGIN
	SELECT c.next_sequence, c.head_hash, c.ctid AS address INTO chain
	  FROM public.audit_chains c
	 WHERE c.tenant_id = new.tenant_id FOR NO KEY UPDATE;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT e.sequence + 1, e.hash INTO place, previous
	  FROM public.audit_entries e
	 WHERE e.tenant_id = new.tenant_id AND e.sequence >= chain.next_sequence
	 ORDER BY e.sequence DESC
	 LIMIT 1;

	IF NOT FOUND THEN
		place := chain.next_sequence;
		previous := chain.head_hash;
	END IF;

	UPDATE public.audit_chains
	   SET next_sequence = place, head_hash = previous, opened_in = NULL, updated_at = now()
	 WHERE ctid = chain.address AND tenant_id = new.tenant_id;

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "audit_chain_closes" AFTER UPDATE ON "audit_chains"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW WHEN (new.opened_in IS NOT NULL AND new.opened_in IS DISTINCT FROM old.opened_in)
	EXECUTE FUNCTION "close_audit_chain"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "next_sync_sequence"(tenant uuid) RETURNS bigint
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	SET enable_seqscan = off
	SET enable_indexscan = off
	SET enable_bitmapscan = off
AS $$
DECLARE
	address tid := public.counter_address('sync', tenant);
	assigned bigint;
BEGIN
	IF address IS NOT NULL THEN
		UPDATE public.sync_sequences SET next_value = next_value + 1, updated_at = now()
		 WHERE ctid = address AND tenant_id = tenant
		RETURNING next_value, ctid INTO assigned, address;
	END IF;

	IF address IS NULL THEN
		INSERT INTO public.sync_sequences (tenant_id)
		VALUES (tenant)
		ON CONFLICT (tenant_id) DO UPDATE SET next_value = sync_sequences.next_value + 1,
			updated_at = now()
		RETURNING next_value, ctid INTO assigned, address;
	END IF;

	PERFORM public.keep_counter_hint('sync', tenant, address::text);

	RETURN assigned;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "record_change"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	before_row jsonb := '{}'::jsonb;
	after_row jsonb := '{}'::jsonb;
	present jsonb;
	chain record;
	head record;
	entry public.audit_entries;
	wrote boolean := false;
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
	PERFORM public.lock_sync_counter(entry.tenant_id);

	-- The first change of the transaction starts at the head of the row and
	-- opens the chain; every further one starts after its own last entry, and
	-- the head reaches the row before the commit (`close_audit_chain`,
	-- opengewerk#953).
	chain := public.lock_audit_chain(entry.tenant_id);
	place := chain.next_sequence;
	previous := chain.head_hash;

	IF chain.opened_in = pg_current_xact_id() THEN
		head := public.audit_chain_head(entry.tenant_id, chain.next_sequence, chain.head_hash);
		place := head.place;
		previous := head.previous;
	END IF;

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
		wrote := true;
	END LOOP;

	IF wrote THEN
		PERFORM public.keep_counter_hint('audit_head', entry.tenant_id, entry.id::text);
	ELSIF chain.opened_in IS DISTINCT FROM pg_current_xact_id() THEN
		PERFORM public.keep_counter_hint('audit_head', entry.tenant_id, 'opened');
	END IF;

	-- Opened after the entries and after the hint: whoever has the trigger
	-- fire at once (`SET CONSTRAINTS ... IMMEDIATE`) has it write the head
	-- with them, not before them.
	IF chain.opened_in IS DISTINCT FROM pg_current_xact_id() THEN
		UPDATE public.audit_chains SET opened_in = pg_current_xact_id(), updated_at = now()
		 WHERE ctid = chain.address AND tenant_id = entry.tenant_id
		RETURNING ctid INTO chain.address;

		PERFORM public.keep_counter_hint('audit', entry.tenant_id, chain.address::text);
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
	PERFORM public.lock_sync_counter(new.tenant_id);
	PERFORM public.lock_audit_chain(new.tenant_id);

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

	PERFORM public.lock_sync_counter(p_tenant);
	PERFORM public.lock_audit_chain(p_tenant);
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
	PERFORM public.lock_sync_counter(p_tenant);
	PERFORM public.lock_audit_chain(p_tenant);

	IF to_regprocedure('public.application_file_named_by_a_value(uuid,text)') IS NULL THEN
		RETURN false;
	END IF;

	EXECUTE 'SELECT public.application_file_named_by_a_value($1, $2)' INTO named USING p_tenant, p_hash;

	RETURN coalesce(named, false);
END;
$$;--> statement-breakpoint
