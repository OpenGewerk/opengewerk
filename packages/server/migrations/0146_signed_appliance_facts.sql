-- A signed test of an appliance keeps the facts its limits were worked out
-- from (opengewerk#954): the protection class and the length of the lead, as
-- they stood at the signature. Until now every page and every print of a
-- signed protocol read them from the appliance as it is today, so that a
-- protection class corrected afterwards changed the limits and the verdicts
-- of a test nobody touched.
--
-- **Who writes them.** Only this trigger. A protocol that becomes signed gets
-- the facts of its appliance in the same statement; every other row keeps
-- none, whatever a client sends. The device sends the facts it judged with,
-- and the sync refuses the signature as a conflict when they are not those of
-- the appliance (`signedFacts` in `database/sync.ts`). That check reads the
-- row of the protocol under its lock and holds the counter of the tenant,
-- which every change of an appliance takes as well (`stamp_sync_columns`), so
-- that the appliance this trigger reads is the one the check compared. A
-- protocol that is signed already is left as it is written: the trigger of
-- 0043 refuses to change it, and the erasure of a site (0132) empties it,
-- these facts included (`emptySite` in `privacy/site-erasure.ts`).
--
-- **The protocols signed before.** They get the facts their appliance has
-- now, the best that is known; the CHANGELOG says so. A protocol in the bin
-- after the erasure of its site gets none. The trigger of 0043 is
-- off for the one statement, and row level security on both tables, because
-- an installation migrates as the owner of the tables (as 0096 does). The
-- statement is logged and counted like every change, so that the devices
-- fetch the protocols again.
ALTER TABLE "form_records" ADD COLUMN "appliance_facts" text;--> statement-breakpoint
ALTER TABLE "form_records" ADD CONSTRAINT "form_records_appliance_facts_signed" CHECK ("form_records"."appliance_facts" is null
        or ("form_records"."status" = 'signed' and "form_records"."appliance_id" is not null
          and char_length("form_records"."appliance_facts") <= 1000));--> statement-breakpoint
CREATE FUNCTION "form_record_appliance_facts"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF tg_op = 'UPDATE' AND old.status = 'signed' THEN
		RETURN new;
	END IF;

	IF new.status = 'signed' AND new.appliance_id IS NOT NULL THEN
		new.appliance_facts := (
			SELECT jsonb_build_object(
				'protectionClass', a.protection_class,
				'cordLengthMilli', a.cord_length_milli)::text
			  FROM public.appliances a
			 WHERE a.tenant_id = new.tenant_id AND a.id = new.appliance_id);
	ELSE
		new.appliance_facts := NULL;
	END IF;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "form_records_appliance_facts" BEFORE INSERT OR UPDATE ON "form_records"
	FOR EACH ROW EXECUTE FUNCTION "form_record_appliance_facts"();--> statement-breakpoint
ALTER TABLE "form_records" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appliances" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_records" DISABLE TRIGGER "form_records_stay_signed";--> statement-breakpoint
SELECT set_config('app.reason', 'migration', true);--> statement-breakpoint
UPDATE "form_records" f
	SET "appliance_facts" = jsonb_build_object(
		'protectionClass', a.protection_class,
		'cordLengthMilli', a.cord_length_milli)::text
	FROM "appliances" a
	WHERE a.tenant_id = f.tenant_id AND a.id = f.appliance_id AND f.status = 'signed'
	  AND f.deleted_at IS NULL;--> statement-breakpoint
SELECT set_config('app.reason', '', true);--> statement-breakpoint
ALTER TABLE "form_records" ENABLE TRIGGER "form_records_stay_signed";--> statement-breakpoint
ALTER TABLE "appliances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_records" FORCE ROW LEVEL SECURITY;
