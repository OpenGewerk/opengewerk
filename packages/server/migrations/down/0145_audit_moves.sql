-- Takes back 0145: the moves away and the redactions are read without an
-- index again. Run as the superuser, like every rollback.
DROP INDEX "audit_entries_redactions_idx";--> statement-breakpoint
DROP INDEX "audit_entries_moves_idx";
