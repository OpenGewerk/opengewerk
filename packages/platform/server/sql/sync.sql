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
-- The counter has taken its numbers from a sequence since opengewerk#965
-- (below); the address still serves its lock and the chain of the log.
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
	SET search_path = pg_catalog, public, pg_temp
AS $$
	SELECT current_setting('opengewerk_' || kind || '.t' || replace(tenant::text, '-', ''), true);
$$;--> statement-breakpoint
CREATE FUNCTION "keep_counter_hint"(kind text, tenant uuid, hint text) RETURNS void
	LANGUAGE sql
	VOLATILE
	SET search_path = pg_catalog, public, pg_temp
AS $$
	SELECT set_config('opengewerk_' || kind || '.t' || replace(tenant::text, '-', ''), hint, true);
$$;--> statement-breakpoint
CREATE FUNCTION "counter_address"(kind text, tenant uuid) RETURNS tid
	LANGUAGE plpgsql
	STABLE
	SET search_path = pg_catalog, public, pg_temp
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

-- The counter of a tenant locked without moving it, as a logged change takes
-- it before the chain (opengewerk#914) and so do the locks of opengewerk#911.
-- The row is created on first use with no number handed out yet, so that the
-- first is still 1. It runs as whoever calls it, and only the functions that
-- run as the owner of the tables do.
CREATE FUNCTION "lock_sync_counter"(tenant uuid) RETURNS void
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
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

-- The numbers of a transaction (opengewerk#965). Moved at every number, the
-- counter row still got a version per number: found again through its address
-- since opengewerk#953, but every version that no longer fit on the page of
-- the one before went into the key as well, and the check that the key is
-- unique walked past every earlier version of the transaction. Twenty thousand
-- numbers in one transaction took nearly eleven times as long as two thousand.
--
-- So the numbers come from a sequence, one per tenant, which counts without
-- versions. The row stays what orders the transactions of a tenant and what a
-- pull reads up to (`next_value`, the last number committed). The first number
-- of a transaction locks the row, sets the sequence to the last number
-- committed and marks the row as open (`opened_in`): a transaction that
-- rolled back leaves no gap, and a sequence that is missing or behind, in a
-- restored instance or for a tenant made again, hands out no number twice.
-- Before the commit `close_sync_counter` writes the last number to the row,
-- once. A sequence is not rolled back, which is why it is set at every opening
-- and trusted for no longer than one transaction; a number given out under a
-- savepoint that is rolled back is not used again while the counter stays
-- open. Takes the savepoint the opening back as well, the next opening starts
-- from the last number committed again and hands those numbers out anew; none
-- of them stands in a row that was committed.
--
-- The sequences stand in public under the name of their tenant
-- (`sync_counter_t<id>`) and belong to the owner of the tables. The application
-- role has no right on them. That it may create nothing in public is the
-- default since PostgreSQL 15 and not something this block can rely on: a
-- cluster upgraded from an older version still lets every role. So the counter
-- takes a relation of that name only if it is a sequence of the owner of the
-- tables, and refuses otherwise, rather than count with one the application
-- made in advance and could move (security review on opengewerk#974). For the
-- same reason nothing in these functions may resolve to what another role
-- made in public or in its temporary schema: they search pg_catalog and, last,
-- pg_temp, which is never searched for a function or an operator; whatever
-- they use of public is named with its schema, compared as the types
-- pg_catalog has an operator for, and the amount is passed as the bigint the
-- function takes, so that no overload is a closer match.

-- Takes the next numbers of a tenant from its sequence and returns the first.
-- The first call of a transaction locks the row, sets the sequence to the last
-- number committed and only marks the row as open once the numbers are taken:
-- a close brought forward (`SET CONSTRAINTS ... IMMEDIATE`) fires at the end of
-- that statement, and the numbers are in it then. Not SECURITY DEFINER and
-- closed to every role but the owner: only the functions that run as the owner
-- of the tables call it, and whoever calls it sets the sequence.
CREATE FUNCTION "take_sync_numbers"(tenant uuid, amount bigint) RETURNS bigint
	LANGUAGE plpgsql
	SET search_path = pg_catalog, pg_temp
	SET enable_seqscan = off
AS $$
DECLARE
	counter text := pg_catalog.format('%I.%I', 'public', 'sync_counter_t' || replace(tenant::text, '-', ''));
	opened xid8;
	committed bigint;
	first bigint;
BEGIN
	SELECT opened_in INTO opened FROM public.sync_sequences WHERE tenant_id = tenant;

	IF opened IS NOT DISTINCT FROM pg_current_xact_id() THEN
		first := nextval(counter::regclass);

		IF amount > 1 THEN
			PERFORM setval(counter::regclass, first + amount - 1, true);
		END IF;

		RETURN first;
	END IF;

	-- On first use the row is made with no number handed out yet, so that the
	-- first is still 1. The lock waits for whoever has the counter open and
	-- then reads the last number that one committed.
	INSERT INTO public.sync_sequences (tenant_id, next_value) VALUES (tenant, 0)
	ON CONFLICT (tenant_id) DO NOTHING;

	SELECT next_value INTO committed FROM public.sync_sequences WHERE tenant_id = tenant FOR NO KEY UPDATE;

	IF to_regclass(counter) IS NULL THEN
		EXECUTE pg_catalog.format('CREATE SEQUENCE %s AS bigint MINVALUE 0', counter);
	ELSIF NOT EXISTS (
		SELECT 1
		  FROM pg_catalog.pg_class c
		 WHERE c.oid = to_regclass(counter)::oid
		   AND c.relkind = 'S'
		   AND c.relowner = (SELECT t.relowner FROM pg_catalog.pg_class t WHERE t.oid = 'public.sync_sequences'::regclass::oid)
	) THEN
		RAISE EXCEPTION 'Der Zähler des Abgleichs eines Mandanten ist keine Sequenz des Eigentümers der Tabellen: %', counter;
	END IF;

	PERFORM setval(counter::regclass, committed, true);
	first := nextval(counter::regclass);

	IF amount > 1 THEN
		PERFORM setval(counter::regclass, first + amount - 1, true);
	END IF;

	UPDATE public.sync_sequences SET opened_in = pg_current_xact_id(), updated_at = now()
	 WHERE tenant_id = tenant;

	RETURN first;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "take_sync_numbers"(uuid, bigint) FROM PUBLIC;--> statement-breakpoint

-- Writes the last number of a transaction to the row of its tenant, once,
-- before the commit, and clears `opened_in`, so that a number after a firing
-- brought forward (`SET CONSTRAINTS ... IMMEDIATE`) opens the counter again
-- and goes on from there. A transaction that rolls back takes the opening and
-- the waiting trigger with it. SECURITY DEFINER because it fires at the commit
-- of whoever changed something, who may not write the counter.
--
-- A migration that alters `sync_sequences` in the same transaction as changes
-- that travel before it fails on the waiting trigger ("pending trigger
-- events"); `SET CONSTRAINTS "sync_counter_closes" IMMEDIATE` before it writes
-- the number first.
CREATE FUNCTION "close_sync_counter"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, pg_temp
	SET enable_seqscan = off
AS $$
BEGIN
	UPDATE public.sync_sequences
	   SET next_value = currval(pg_catalog.format('%I.%I', 'public', 'sync_counter_t' || replace(new.tenant_id::text, '-', ''))::regclass),
	       opened_in = NULL,
	       updated_at = now()
	 WHERE tenant_id = new.tenant_id AND opened_in = pg_current_xact_id();

	RETURN NULL;
END;
$$;--> statement-breakpoint
-- Closed to every role but the owner (opengewerk#975). A trigger already on a
-- table fires without the right; hung on a temporary table of its own, a role
-- that may execute it would have it write as the owner of the tables.
REVOKE EXECUTE ON FUNCTION "close_sync_counter"() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sync_counter_closes" AFTER UPDATE ON "sync_sequences"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW WHEN (new.opened_in IS NOT NULL AND new.opened_in IS DISTINCT FROM old.opened_in)
	EXECUTE FUNCTION "close_sync_counter"();--> statement-breakpoint

-- The counter. SECURITY DEFINER because the application role has no business
-- writing here and does not have the grant for it; the number is handed out,
-- not asked for.
CREATE FUNCTION "next_sync_sequence"(tenant uuid) RETURNS bigint
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN public.take_sync_numbers(tenant, 1::bigint);
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
	SET search_path = pg_catalog, public, pg_temp
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
