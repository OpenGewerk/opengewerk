-- Takes back 0145: the moves away and the redactions are read without an
-- index again. Run as the superuser, like every rollback, and with the
-- instance closed (CLOSED=true, docs/betrieb.md): dropping an index waits for
-- every transaction on the log, and every change of the application waits
-- behind it.
DROP INDEX "audit_entries_redactions_idx";--> statement-breakpoint
DROP INDEX "audit_entries_moves_idx";
