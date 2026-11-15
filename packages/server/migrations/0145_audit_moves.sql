-- The moves of what hangs on a job, found by where they came from
-- (opengewerk#946, #947). The scope of a device changes its value when a
-- record whose key pointed at something the device holds points elsewhere,
-- and `movesOf` in `database/device-scope.ts` asks the log for exactly that:
-- the changes of one key whose old value is among the records the device
-- holds. Without this index PostgreSQL would read every entry of the table on
-- every pull. Only the keys the scope follows are in it, ids each, so that no
-- long text of another field comes near the limit of an index entry.
CREATE INDEX "audit_entries_moves_idx" ON "audit_entries" USING btree ("tenant_id", "table_name", "field", "old_value")
	WHERE "operation" = 'update'
	  AND "field" IN ('appliance_id', 'appointment_id', 'assignee_user_id', 'attachment_id',
	                  'circuit_id', 'customer_id', 'defect_id', 'distribution_board_id',
	                  'document_id', 'installation_id', 'inverter_id', 'job_id', 'pv_string_id',
	                  'site_id', 'user_id');
