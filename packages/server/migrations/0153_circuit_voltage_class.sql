-- Two facts of a circuit for the test record (#1021): its nominal voltage
-- after Table 6.1 of DIN VDE 0100-600, which sets the least insulation
-- resistance, and whether its RCD is selective (type S), which may take up
-- to 500 ms. Every circuit from before is up to 500 V and has an RCD of
-- the general kind, which is how its record has been judged so far.
CREATE TYPE "public"."circuit_voltage_class" AS ENUM('up_to_500', 'selv_pelv', 'above_500');--> statement-breakpoint
ALTER TABLE "circuits" ADD COLUMN "voltage_class" "circuit_voltage_class" DEFAULT 'up_to_500' NOT NULL;--> statement-breakpoint
ALTER TABLE "circuits" ADD COLUMN "rcd_selective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_selective_rcd_has_type" CHECK (not "circuits"."rcd_selective" or "circuits"."rcd_type" is not null);