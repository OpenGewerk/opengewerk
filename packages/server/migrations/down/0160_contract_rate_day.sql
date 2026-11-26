-- Takes back 0160 (#1037). The day of the maintenance goes with its column,
-- the snapshots keep it in their content, and the key of the period counts
-- every invoice again. A period laid out again after a cancellation keeps
-- the rollback from restoring that key; it stops then, and the office
-- removes one of the two first.
--
-- Run as the superuser, like every rollback.
ALTER TABLE "maintenance_contracts" DROP CONSTRAINT IF EXISTS "maintenance_contracts_rate_day";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_supply_on";--> statement-breakpoint
DROP INDEX IF EXISTS "documents_maintenance_period_key";--> statement-breakpoint
ALTER TABLE "maintenance_contracts" DROP COLUMN IF EXISTS "rate_day";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "supply_on";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_maintenance_period_key" UNIQUE("maintenance_contract_id","service_from");
