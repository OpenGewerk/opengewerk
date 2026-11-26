-- Takes back 0160 (#1037). The day of the maintenance goes with its column,
-- and so does what a recurring invoice took from its contract; the snapshots
-- keep the day in their content, and the key of the period counts every
-- invoice again. A period laid out again after a cancellation has two
-- invoices, the cancelled one and the new one, and the old key cannot hold
-- that: the rollback says so before it changes anything, also where it is
-- run by hand and not in one transaction.
--
-- Run as the superuser, like every rollback.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "documents"
		WHERE "maintenance_contract_id" IS NOT NULL
		GROUP BY "maintenance_contract_id", "service_from"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Ein Zeitraum eines Wartungsvertrags hat nach einem Storno zwei Dauerrechnungen; die Rücknahme von 0160 hält das nicht.';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "maintenance_contracts" DROP CONSTRAINT IF EXISTS "maintenance_contracts_rate_day";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_supply_on";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_taken_over";--> statement-breakpoint
DROP INDEX IF EXISTS "documents_maintenance_period_key";--> statement-breakpoint
ALTER TABLE "maintenance_contracts" DROP COLUMN IF EXISTS "rate_day";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "supply_on";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "taken_over";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_maintenance_period_key" UNIQUE("maintenance_contract_id","service_from");
