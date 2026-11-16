-- Takes the block `sync.sql` back out. The trigger goes wherever it hangs, not
-- wherever a list claims it does: the catalogue is asked, the same way round
-- as a test asks it.
DO $$
DECLARE
	target text;
BEGIN
	FOR target IN
		SELECT c.relname
		  FROM pg_trigger t
		  JOIN pg_class c ON c.oid = t.tgrelid
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public'
		   AND t.tgname = 'stamp_sync_columns'
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS "stamp_sync_columns" ON %I', target);
	END LOOP;
END
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS "stamp_sync_columns"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "next_sync_sequence"(uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'sync_counter_closes') THEN
		SET CONSTRAINTS "sync_counter_closes" IMMEDIATE;
	END IF;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_counter_closes" ON "sync_sequences";--> statement-breakpoint
DROP FUNCTION IF EXISTS "close_sync_counter"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "take_sync_numbers"(uuid, bigint);--> statement-breakpoint
DO $$
DECLARE
	counter text;
BEGIN
	FOR counter IN
		SELECT c.relname
		  FROM pg_catalog.pg_class c
		  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname OPERATOR(pg_catalog.~~) 'sync\_counter\_t%'
	LOOP
		EXECUTE pg_catalog.format('DROP SEQUENCE IF EXISTS %I.%I', 'public', counter);
	END LOOP;
END
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS "lock_sync_counter"(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS "counter_address"(text, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS "keep_counter_hint"(text, uuid, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS "counter_hint"(text, uuid);
