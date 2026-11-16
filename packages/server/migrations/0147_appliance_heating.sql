-- The heating power of an appliance and the cross-section of its lead
-- (opengewerk#816), both optional: an appliance with heating elements is held
-- to 0.3 MΩ and above 3.5 kW to a protective conductor current of a
-- milliampere per kilowatt, a lead over 1.5 mm² to its own resistance. The
-- limits are rules of the package Elektro; the unit `square_micrometres` of
-- the foundation (`ruleUnits`) holds the 1.5 mm² of the table, and this
-- application stores none of it in `tenant_parameters`.
--
-- **What a signed test keeps.** The trigger of 0146 writes the facts of the
-- appliance into a protocol at its signature; it names the two new ones as
-- well now, so that a test signed with them keeps them. A protocol signed
-- before keeps what it was signed with, without them, and is read as an
-- appliance without heating elements and with a lead of up to 1.5 mm², the
-- limits it was signed against.
--
-- **Fits the version before it**: the older version writes neither column,
-- and they stay empty.
ALTER TYPE "public"."rule_unit" ADD VALUE 'square_micrometres';--> statement-breakpoint
ALTER TABLE "appliances" ADD COLUMN "cord_cross_section_milli" integer;--> statement-breakpoint
ALTER TABLE "appliances" ADD COLUMN "heating_power_watts" integer;--> statement-breakpoint
ALTER TABLE "appliances" ADD CONSTRAINT "appliances_cord_cross_section" CHECK ("appliances"."cord_cross_section_milli" is null or "appliances"."cord_cross_section_milli" between 1 and 1000000);--> statement-breakpoint
ALTER TABLE "appliances" ADD CONSTRAINT "appliances_heating_power" CHECK ("appliances"."heating_power_watts" is null or "appliances"."heating_power_watts" between 1 and 1000000);--> statement-breakpoint
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
				'cordLengthMilli', a.cord_length_milli,
				'cordCrossSectionMilli', a.cord_cross_section_milli,
				'heatingPowerWatts', a.heating_power_watts)::text
			  FROM public.appliances a
			 WHERE a.tenant_id = new.tenant_id AND a.id = new.appliance_id);
	ELSE
		new.appliance_facts := NULL;
	END IF;

	RETURN new;
END;
$$;
