-- Whether the line of the emergency surcharge of a draft follows the call of
-- its job (#1097). Until now a marked line held that, gone or not, and a
-- draft without one never got the surcharge by itself: one whose job became
-- an emergency call after the invoice was made, one moved to such a job, one
-- from before 0155. The field is set on every invoice out of a report and on
-- every collective invoice, and the server adds the line once a surcharge is
-- due.
--
-- A draft from before follows where it has a marked line, or where it came
-- out of a report or is a collective invoice, unless it carries a surcharge
-- the office typed in (a position of the word alone or with its kind after
-- it, without the mark): that one stays the draft's. Such a draft gets its
-- line with the next change that works it out, at the latest when it is
-- issued. An installation migrates as the owner of the tables, under FORCE,
-- where the update would meet no row: the three tables go without FORCE for
-- it and get it back right after.
ALTER TABLE "documents" ADD COLUMN "follows_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_lines" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_sources" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_entries" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
SELECT set_config('app.reason', 'migration', true);--> statement-breakpoint
UPDATE "documents" d
	SET "follows_call" = true
	WHERE d.kind = 'final_invoice' AND d.status = 'draft' AND d.deleted_at IS NULL
		AND (
			EXISTS (
				SELECT 1 FROM "document_lines" l
				WHERE l.tenant_id = d.tenant_id AND l.document_id = d.id AND l.emergency_surcharge
			)
			OR EXISTS (
				SELECT 1 FROM "documents" p
				WHERE p.tenant_id = d.tenant_id AND p.id = d.predecessor_document_id
					AND p.kind = 'time_and_material_report'
			)
			OR EXISTS (
				SELECT 1 FROM "document_sources" s
				WHERE s.tenant_id = d.tenant_id AND s.document_id = d.id
			)
		)
		AND NOT EXISTS (
			SELECT 1 FROM "document_lines" o
			WHERE o.tenant_id = d.tenant_id AND o.document_id = d.id
				AND o.kind = 'item' AND NOT o.emergency_surcharge
				AND (o.designation = 'Notdienstzuschlag' OR o.designation LIKE 'Notdienstzuschlag %')
		)
		AND NOT EXISTS (
			SELECT 1 FROM "document_lines" o
			JOIN "audit_entries" a
				ON a.tenant_id = o.tenant_id AND a.table_name = 'document_lines' AND a.record_id = o.id
			WHERE o.tenant_id = d.tenant_id AND o.document_id = d.id AND NOT o.emergency_surcharge
				AND a.field = 'emergency_surcharge' AND a.old_value = 'true' AND a.new_value = 'false'
		)
		-- A line of the server the office renamed before 0155 marked it, in a
		-- version that had no mark yet: its log keeps the name it had.
		AND NOT EXISTS (
			SELECT 1 FROM "document_lines" o
			JOIN "audit_entries" a
				ON a.tenant_id = o.tenant_id AND a.table_name = 'document_lines' AND a.record_id = o.id
			WHERE o.tenant_id = d.tenant_id AND o.document_id = d.id AND NOT o.emergency_surcharge
				AND a.field = 'designation'
				AND (a.old_value = 'Notdienstzuschlag' OR a.old_value LIKE 'Notdienstzuschlag %')
		)
		-- A line of the server whose rate of tax the office set by hand, which
		-- kept its mark then: the server writes only the standard rate.
		AND NOT EXISTS (
			SELECT 1 FROM "document_lines" o
			WHERE o.tenant_id = d.tenant_id AND o.document_id = d.id AND o.emergency_surcharge
				AND o.vat_rate <> 'standard'
		);--> statement-breakpoint
SELECT set_config('app.reason', '', true);--> statement-breakpoint
ALTER TABLE "audit_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
