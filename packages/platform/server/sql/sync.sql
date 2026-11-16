-- The offline data layer: what keeps a record true while it is changed in two
-- places at once. The three tables come from the schema, and so do the five
-- columns a travelling record carries; in here is what fills them.
--
-- All of it is kept by a trigger rather than by whoever writes the row. A line
-- the application has to remember is a line it forgets at the sixteenth place,
-- and here it would forget it invisibly: a stale version only hurts the next
-- time two devices meet, which is days later and somewhere else.
--
-- 1. `version`, `updated_by`, `device_id`: who changed the row, from where,
--    and how often it has changed at all.
-- 2. `change_sequence`: where the change sits in the tenant's stream. It comes
--    from one counter row per tenant, so the numbers come out in the order the
--    transactions commit. A cursor on timestamps instead would quietly skip a
--    row whose transaction started early and committed late, and the device
--    would never hear about that row again.
-- 3. `deleted_at`: a row is marked, not removed. A removed row is a row a
--    device that was offline never learns about, because a delta pull delivers
--    what changed and a row that is gone is not among it.

-- Where a transaction left the rows of a tenant it holds (opengewerk#953). A
-- transaction that logs many changes moves the counter once per change and,
-- without this, found the row again through its key each time: past every
-- version of the row it had written itself, which no vacuum may remove while
-- the transaction runs. The thousandth change walked a thousand versions, and
-- 152 000 changes in one transaction had not ended after nine minutes.
--
-- So the address (`ctid`) of the version a transaction wrote or locked last is
-- kept in a setting of the transaction, one per kind and tenant, and the next
-- access goes there directly. The setting is a hint and nothing more. Anybody
-- may set it; the access through it asks for the tenant as well and sees only
-- the version that is current for the transaction, so an address that is
-- stale, foreign or made up finds nothing, and the access goes the way it went
-- before, through the key. Set with `is_local`, it ends with the transaction
-- and goes back with a savepoint that is rolled back, as the row does.
--
-- The functions that go by such an address name the scan they use: no
-- sequential scan and no index, which leaves the one by address. A plan is
-- made the first time a session runs the statement and kept for the session;
-- made while the tables are small, as in a fresh instance, it chose to read
-- the table or the key, and either way it walked every version again.
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
	held text := public.counter_hint(kind, tenant);
BEGIN
	IF held ~ '^\(\d{1,10},\d{1,5}\)$' THEN
		RETURN held::tid;
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint

-- The counter of a tenant locked without moving it, as a logged change takes
-- it before the chain (opengewerk#914) and so do the locks of opengewerk#911.
-- The row is created on first use with no number handed out yet, so that the
-- first is still 1. It runs as whoever calls it, and only the functions that
-- run as the owner of the tables do.
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

-- The counter. SECURITY DEFINER because the application role has no business
-- writing here and does not have the grant for it; the number is handed out,
-- not asked for.
--
-- ON CONFLICT DO UPDATE rather than DO NOTHING, for the same reason as in the
-- audit chain: DO NOTHING would let a second transaction fall through without
-- seeing the row the first one has not committed yet. From the second number
-- of a transaction on, the row is moved through the address it holds
-- (`counter_address`).
CREATE FUNCTION "next_sync_sequence"(tenant uuid) RETURNS bigint
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

-- A function is open to every role until somebody says otherwise, and this
-- one runs as the owner of the tables: left open, any role in the cluster
-- could move the counter of any tenant. The application role calls it through
-- the trigger below whenever it writes a row that travels; the owner keeps the
-- right because the function is its own.
REVOKE EXECUTE ON FUNCTION "next_sync_sequence"(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "next_sync_sequence"(uuid) TO "opengewerk_app";--> statement-breakpoint

-- What keeps the five columns true. It does not touch a table, so it runs as
-- whoever triggered it; the counter it calls is the part that needs more.
--
-- The trigger that calls it goes on every table that carries the columns, and
-- its name matters. PostgreSQL fires BEFORE triggers in alphabetical order, so
-- `stamp_sync_columns` runs after a trigger named for its table, and a check
-- that guards a fixed record sees the row as the caller sent it.
CREATE FUNCTION "stamp_sync_columns"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	new.updated_at := now();
	new.updated_by := nullif(current_setting('app.user_id', true), '');
	new.device_id := nullif(current_setting('app.device_id', true), '');
	new.version := CASE WHEN tg_op = 'UPDATE' THEN old.version + 1 ELSE 1 END;
	new.change_sequence := public.next_sync_sequence(new.tenant_id);

	RETURN new;
END;
$$;
