-- Every trigger function of the foundation that runs as the owner of the
-- tables is closed to every role but the owner (opengewerk#975). A function is
-- open to PUBLIC until somebody says otherwise, and any role may make a
-- temporary table in its session and hang a trigger function on it that it
-- may execute. Hung there, one of these would write the log, the counter or
-- the files of any tenant as the owner. Triggers already on the tables fire
-- as before: the right is asked when a trigger is made, not when it fires.
-- The functions are the foundation's (blocks `audit.sql`, `instance.sql`,
-- `attachments.sql`, `sync.sql`); the trigger functions of this application
-- were closed by the migrations that made them. And no role but the owner
-- creates in public any more, which PostgreSQL 15 took from every role and a
-- cluster upgraded from an older version still grants: what another role put
-- there first would be found by these functions (block `roles.sql`). The
-- rollback leaves that as it is.
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "close_audit_chain"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "record_change"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "audit_redaction_checked"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "audit_redaction_applied"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "record_instance_change"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "version_takes_its_files"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "close_sync_counter"() FROM PUBLIC;
