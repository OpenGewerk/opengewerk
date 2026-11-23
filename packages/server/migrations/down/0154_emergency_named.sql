-- Takes back 0154 (#1081). The named surcharge goes with its columns; the
-- version before bills every emergency call by the settings of the day.
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_emergency_named";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "emergency_named_basis_points";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "emergency_named_flat_cents";
