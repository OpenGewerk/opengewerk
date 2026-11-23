-- Takes back 0153 (#1021). The nominal voltage and the selective RCD go with
-- their columns; the version before knows neither and judges every circuit
-- as up to 500 V with a general RCD.
ALTER TABLE "circuits" DROP CONSTRAINT "circuits_selective_rcd_has_type";--> statement-breakpoint
ALTER TABLE "circuits" DROP COLUMN "rcd_selective";--> statement-breakpoint
ALTER TABLE "circuits" DROP COLUMN "voltage_class";--> statement-breakpoint
DROP TYPE "public"."circuit_voltage_class";
