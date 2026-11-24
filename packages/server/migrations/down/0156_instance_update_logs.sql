-- Takes the logs of updates from the area of the instance out again, back to
-- how 0155 left things.
--
-- The rows go without asking. What they said is in the log of the instance and
-- in the audit log of every business, which keep their entries about the
-- tables, the same choice as in every earlier rollback.
--
-- Run as the superuser, like every rollback.
DROP TRIGGER IF EXISTS "audit_changes" ON "update_notices";--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "update_notices";--> statement-breakpoint
DROP TABLE IF EXISTS "update_notices";--> statement-breakpoint
DROP TRIGGER IF EXISTS "instance_changes" ON "instance_updates";--> statement-breakpoint
DROP POLICY IF EXISTS "outside_any_tenant" ON "instance_updates";--> statement-breakpoint
DROP TABLE IF EXISTS "instance_updates";
