-- Back to the counter row moved at every number. A counter opened in this
-- transaction is written first, so that the trigger can go; every number a
-- sequence handed out is in the row by then.
SET CONSTRAINTS "sync_counter_closes" IMMEDIATE;--> statement-breakpoint
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
CREATE OR REPLACE FUNCTION "reserve_sync_sequences"(amount integer) RETURNS bigint
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
	last bigint;
BEGIN
	IF NOT public.article_import_writing() OR tenant IS NULL OR amount < 1 THEN
		RAISE EXCEPTION 'Nummern des Abgleichs gibt es am Stück nur für einen Import, der übernommen wird.';
	END IF;

	INSERT INTO public.sync_sequences (tenant_id, next_value)
	VALUES (tenant, amount)
	ON CONFLICT (tenant_id) DO UPDATE SET next_value = sync_sequences.next_value + amount,
		updated_at = now()
	RETURNING next_value INTO last;

	RETURN last - amount + 1;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_counter_closes" ON "sync_sequences";--> statement-breakpoint
DROP FUNCTION IF EXISTS "close_sync_counter"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "take_sync_numbers"(uuid, bigint);--> statement-breakpoint
DROP SCHEMA IF EXISTS "sync_counters" CASCADE;--> statement-breakpoint
ALTER TABLE "sync_sequences" DROP COLUMN IF EXISTS "opened_in";
