-- The moves of what hangs on a job, found by where they came from
-- (opengewerk#946, #947). The scope of a device changes its value when a
-- record whose key pointed at something the device holds points elsewhere,
-- and `movesOf` in `database/device-scope.ts` asks the log for exactly that:
-- the changes of one key whose old value is among the records the device
-- holds. Without this index PostgreSQL would read every entry of the table on
-- every pull. Only the keys the scope follows are in it, ids each, so that no
-- long text of another field comes near the limit of an index entry.
-- Built inside the one transaction every pending migration runs in, so that
-- an update is never half done: while the two indexes are built, changes of
-- the application that is still running wait for the log. Built on a copy
-- of two million entries as wide as those of the log (977 MB), both took less
-- than a second together.
CREATE INDEX "audit_entries_moves_idx" ON "audit_entries" USING btree ("tenant_id", "table_name", "field", "old_value")
	WHERE "operation" = 'update'
	  AND "field" IN ('appliance_id', 'appointment_id', 'assignee_user_id', 'attachment_id',
	                  'circuit_id', 'customer_id', 'defect_id', 'distribution_board_id',
	                  'document_id', 'installation_id', 'inverter_id', 'job_id', 'pv_string_id',
	                  'site_id', 'user_id');
--> statement-breakpoint
-- The redactions (opengewerk#946): a deletion blacks out the old value of a
-- move with the rest, and the index above no longer finds it. Each redaction
-- is itself an entry of the log, and the scope of a device takes the last of
-- them (`lastRedaction`), one step down this index. By the field alone, since
-- the value of a redaction's side can be blacked out in its turn.
CREATE INDEX "audit_entries_redactions_idx" ON "audit_entries" USING btree ("tenant_id", "sequence")
	WHERE "table_name" = 'audit_redactions' AND "field" = 'side';
