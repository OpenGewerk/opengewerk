-- The totals an issued document froze, on the document itself (#1035). The
-- office and the site worked them out again from the lines and the rules of
-- the running version, while the PDF, the e-invoice and the payments read the
-- snapshot; a later version that changed what applies to a past day would
-- have shown an issued invoice with other figures than the ones it went out
-- with. The snapshot never travels to a device, the document does: the
-- column carries the totals of the snapshot there, copied by a trigger when
-- the snapshot is written, whichever way a document is issued.
--
-- `document_stays_fixed` lets an issued document take exactly the totals its
-- snapshot holds, and nothing else along with them. The documents issued
-- before get theirs here. An installation migrates as the owner of the
-- tables, under FORCE, where the update would meet no row: the three tables
-- it touches go without FORCE for it and get it back right after.
ALTER TABLE "documents" ADD COLUMN "issued_totals" jsonb;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "document_stays_fixed"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	bookkeeping text[] := ARRAY['status', 'updated_at', 'updated_by', 'device_id',
		'version', 'change_sequence'];
	issuing text[] := ARRAY['status', 'updated_at', 'updated_by', 'device_id',
		'version', 'change_sequence', 'number', 'issued_at', 'issued_by'];
	totalling text[] := ARRAY['issued_totals', 'updated_at', 'updated_by', 'device_id',
		'version', 'change_sequence'];
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
	-- The totals of the snapshot, written once it exists (#1035): exactly
	-- those, and with them nothing but the bookkeeping.
	IF new.issued_totals IS DISTINCT FROM old.issued_totals THEN
		IF to_jsonb(new) - totalling IS DISTINCT FROM to_jsonb(old) - totalling
		   OR new.issued_totals IS DISTINCT FROM (
				SELECT s.content -> 'totals' FROM public.document_snapshots s
				WHERE s.tenant_id = new.tenant_id AND s.document_id = new.id
			) THEN
			RAISE EXCEPTION 'Die Summen eines festgeschriebenen Belegs sind die seines Stands bei der Ausstellung und ändern sich nicht.'
				USING ERRCODE = 'OG001';
		END IF;
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
$$;--> statement-breakpoint
CREATE FUNCTION "document_takes_its_issued_totals"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
	-- Only where it changes something: an update that changes nothing meets the
	-- last refusal of `document_stays_fixed`, and the snapshot would not be
	-- written. A snapshot without totals, which no version of the application
	-- writes, leaves the document as it is.
	UPDATE public.documents SET issued_totals = new.content -> 'totals'
		WHERE tenant_id = new.tenant_id AND id = new.document_id
			AND issued_totals IS DISTINCT FROM new.content -> 'totals';
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "document_snapshots_give_their_totals" AFTER INSERT ON "document_snapshots"
	FOR EACH ROW EXECUTE FUNCTION "document_takes_its_issued_totals"();--> statement-breakpoint
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_snapshots" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_entries" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
SELECT set_config('app.reason', 'migration', true);--> statement-breakpoint
UPDATE "documents" d
	SET "issued_totals" = s.content -> 'totals'
	FROM "document_snapshots" s
	WHERE s.tenant_id = d.tenant_id AND s.document_id = d.id
		AND d.status IN ('issued', 'cancelled')
		AND d.issued_totals IS DISTINCT FROM s.content -> 'totals';--> statement-breakpoint
SELECT set_config('app.reason', '', true);--> statement-breakpoint
ALTER TABLE "audit_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issued_totals" CHECK ("documents"."issued_totals" is null or "documents"."status" in ('issued', 'cancelled'));
