-- The counter of the sync takes its numbers from a sequence of the tenant
-- (opengewerk#965). Moved at every number, the counter row still got a version
-- per number, and the check that its key is unique walked past every earlier
-- one of the transaction: twenty thousand numbers in one transaction took
-- nearly eleven times as long as two thousand. Now the first number of a
-- transaction locks the row, sets the sequence to the last number committed
-- and marks the row as open (`opened_in`), and `close_sync_counter` writes the
-- last number once, before the commit. The functions are the foundation's
-- (block `sync.sql`); `reserve_sync_sequences` of the article import takes its
-- numbers the same way.
ALTER TABLE "sync_sequences" ADD COLUMN "opened_in" "xid8";--> statement-breakpoint
CREATE FUNCTION "take_sync_numbers"(tenant uuid, amount bigint) RETURNS bigint
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
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
		 WHERE c.oid = to_regclass(counter)
		   AND c.relkind = 'S'
		   AND c.relowner = (SELECT t.relowner FROM pg_catalog.pg_class t WHERE t.oid = 'public.sync_sequences'::regclass)
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
CREATE FUNCTION "close_sync_counter"() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public, pg_temp
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
CREATE CONSTRAINT TRIGGER "sync_counter_closes" AFTER UPDATE ON "sync_sequences"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW WHEN (new.opened_in IS NOT NULL AND new.opened_in IS DISTINCT FROM old.opened_in)
	EXECUTE FUNCTION "close_sync_counter"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "next_sync_sequence"(tenant uuid) RETURNS bigint
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
	RETURN public.take_sync_numbers(tenant, 1::bigint);
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reserve_sync_sequences"(amount integer) RETURNS bigint
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
	IF NOT public.article_import_writing() OR tenant IS NULL OR amount < 1 THEN
		RAISE EXCEPTION 'Nummern des Abgleichs gibt es am Stück nur für einen Import, der übernommen wird.';
	END IF;

	-- From the sequence of the tenant, as every other number: the block follows
	-- the numbers the transaction has taken so far, and the numbers after it
	-- follow the block.
	RETURN public.take_sync_numbers(tenant, amount::bigint);
END;
$$;
