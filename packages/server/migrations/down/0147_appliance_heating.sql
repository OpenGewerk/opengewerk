-- Takes back 0147 (opengewerk#816). The heating power and the cross-section of
-- the lead are what a business entered about its appliances: this rollback
-- deletes none of them. While an appliance holds one, it stops and changes
-- nothing. Which they are, this shows:
--
--   select id, designation, cord_cross_section_milli, heating_power_watts from appliances
--    where cord_cross_section_milli is not null or heating_power_watts is not null;
--
-- The owner sees no row of a table under FORCE, so the check looks past the
-- policy, in one statement with the change. The trigger of 0146 writes the
-- facts of a signed test without the two again; a protocol signed with them
-- keeps them, and the version before reads a protocol by the facts it knows.
-- The unit stays in `rule_unit`, since a value cannot be taken out of an enum
-- and an unused one does no harm (as in the rollback of 0114). Run as the
-- superuser, like every rollback.
DO $$
BEGIN
	ALTER TABLE "appliances" NO FORCE ROW LEVEL SECURITY;

	IF EXISTS (SELECT 1 FROM "appliances"
		WHERE "cord_cross_section_milli" IS NOT NULL OR "heating_power_watts" IS NOT NULL) THEN
		RAISE EXCEPTION 'Es gibt Geräte mit Heizleistung oder Querschnitt der Anschlussleitung (#816). Die Rücknahme von 0147 löscht keine Angaben und bricht deshalb ab; wer sie trotzdem braucht, sichert die Datenbank vorher. Welche es sind, zeigt die Abfrage in der Rücknahme von 0147.';
	END IF;

	ALTER TABLE "appliances" DROP CONSTRAINT "appliances_heating_power";
	ALTER TABLE "appliances" DROP CONSTRAINT "appliances_cord_cross_section";
	ALTER TABLE "appliances" DROP COLUMN "heating_power_watts";
	ALTER TABLE "appliances" DROP COLUMN "cord_cross_section_milli";
	ALTER TABLE "appliances" FORCE ROW LEVEL SECURITY;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "form_record_appliance_facts"() RETURNS trigger
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
$$;
