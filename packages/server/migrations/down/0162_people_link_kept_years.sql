-- Takes back 0162 (#1132). A file can be linked to any account again, as
-- before; nothing of the staff is deleted or changed.
--
-- Run as the superuser, like every rollback.
DROP TRIGGER IF EXISTS "people_link_only_kept_years" ON "people";--> statement-breakpoint
DROP FUNCTION IF EXISTS "people_link_only_kept_years"();
