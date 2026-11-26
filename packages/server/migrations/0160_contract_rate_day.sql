-- Which day decides the rate of the recurring invoices of a contract (#1037):
-- the day of the maintenance a period pays for, or the end of the period for
-- a flat price that pays for a running service. A contract from before takes
-- the end of the period, which is what it had; a new one the maintenance.
-- The column gets its old value for the rows that are there and the new
-- default after, so no row is updated.
--
-- A recurring invoice names that day as `supply_on`, and so does its
-- cancellation. One invoice per contract and period, but a cancelled one no
-- longer counts: the office lays the period out again after cancelling it.
ALTER TABLE "documents" DROP CONSTRAINT "documents_maintenance_period_key";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "supply_on" date;--> statement-breakpoint
ALTER TABLE "maintenance_contracts" ADD COLUMN "rate_day" text DEFAULT 'period_end' NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_contracts" ALTER COLUMN "rate_day" SET DEFAULT 'visit';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_maintenance_period_key" ON "documents" USING btree ("maintenance_contract_id","service_from") WHERE "documents"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_supply_on" CHECK ("documents"."supply_on" is null or "documents"."kind" in ('recurring_invoice', 'cancellation_invoice'));--> statement-breakpoint
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_rate_day" CHECK ("maintenance_contracts"."rate_day" in ('visit', 'period_end'));