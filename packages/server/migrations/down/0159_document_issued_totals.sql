-- Takes back 0159 (#1035). The totals go with their column; the snapshot
-- still holds them, and the version before works them out again on screen.
--
-- Run as the superuser, like every rollback.
DROP TRIGGER IF EXISTS "document_snapshots_give_their_totals" ON "document_snapshots";--> statement-breakpoint
DROP FUNCTION IF EXISTS "document_takes_its_issued_totals"();--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_issued_totals";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "issued_totals";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "document_stays_fixed"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	bookkeeping text[] := ARRAY['status', 'updated_at', 'updated_by', 'device_id',
		'version', 'change_sequence'];
	issuing text[] := ARRAY['status', 'updated_at', 'updated_by', 'device_id',
		'version', 'change_sequence', 'number', 'issued_at', 'issued_by'];
BEGIN
	-- Emptied with its customer once nothing holds it (#845), never deleted.
	IF tg_op = 'UPDATE' AND old.customer_id = new.customer_id
	   AND public.customer_erasing(old.customer_id) THEN
		RETURN new;
	END IF;

	IF tg_op = 'DELETE' THEN
		IF old.status = 'signed' THEN
			RAISE EXCEPTION 'Ein unterschriebener Beleg wird nicht gelöscht.'
				USING ERRCODE = 'OG001';
		END IF;
		IF old.status <> 'draft' THEN
			RAISE EXCEPTION 'Ein festgeschriebener Beleg wird nicht gelöscht, sondern storniert.'
				USING ERRCODE = 'OG001';
		END IF;
		RETURN old;
	END IF;
	IF old.status = 'draft' THEN
		RETURN new;
	END IF;
	IF old.status = 'signed' THEN
		IF new.status = 'issued' AND to_jsonb(new) - issuing IS NOT DISTINCT FROM to_jsonb(old) - issuing THEN
			RETURN new;
		END IF;
		RAISE EXCEPTION 'Ein unterschriebener Beleg wird nicht mehr geändert. Festschreiben lässt er sich noch.'
			USING ERRCODE = 'OG001';
	END IF;
	IF old.status = 'issued' AND new.status = 'cancelled' THEN
		IF to_jsonb(new) - bookkeeping IS DISTINCT FROM to_jsonb(old) - bookkeeping THEN
			RAISE EXCEPTION 'Beim Stornieren darf sich außer dem Status nichts ändern.'
				USING ERRCODE = 'OG001';
		END IF;
		RETURN new;
	END IF;
	RAISE EXCEPTION 'Ein festgeschriebener Beleg wird nicht geändert, sondern storniert und neu ausgestellt.'
		USING ERRCODE = 'OG001';
END;
$$;
