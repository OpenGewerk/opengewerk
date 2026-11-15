-- Takes back 0145: the moves away are read without an index again. Run as the
-- superuser, like every rollback.
DROP INDEX "audit_entries_moves_idx";
