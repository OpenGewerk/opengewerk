-- The mark of the line of the surcharge of an emergency call (#293), by which
-- the server works the line out again from the hours of its draft whenever
-- they change (#1087). A change of its text or amount by hand takes it away.
--
-- A draft from before gets the mark on the line its invoice was given, where
-- nobody has changed that line since (version 1), it is the only surcharge on
-- the draft (a position of the word alone or with its kind after it, as the
-- server tells one the office typed; a heading is none) and the draft's job is
-- an emergency call. Given means made in the
-- transaction that made the invoice, so with its `created_at`, which is the
-- start of that transaction. Not a line copied in that transaction from the
-- report or a source of the collective invoice, which has a line of the same
-- name there, nor one of an article. A line the office changed or typed itself
-- stays the office's, even one that looks like it. An installation migrates as
-- the owner of the tables, under FORCE, where the update would meet no row:
-- the four tables go without FORCE for it and get it back right after.
ALTER TABLE "document_lines" ADD COLUMN "emergency_surcharge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_lines" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_sources" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
SELECT set_config('app.reason', 'migration', true);--> statement-breakpoint
UPDATE "document_lines" l
	SET "emergency_surcharge" = true
	FROM "documents" d, "jobs" j
	WHERE d.tenant_id = l.tenant_id AND d.id = l.document_id
		AND j.tenant_id = d.tenant_id AND j.id = d.job_id
		AND d.kind = 'final_invoice' AND d.status = 'draft' AND d.deleted_at IS NULL
		AND j.emergency_at IS NOT NULL
		AND l.deleted_at IS NULL AND l.version = 1 AND l.kind = 'item' AND l.unit = 'flat_rate'
		AND l.created_at = d.created_at
		AND l.article_id IS NULL
		AND NOT EXISTS (
			SELECT 1 FROM "document_lines" p
			WHERE p.tenant_id = l.tenant_id AND p.deleted_at IS NULL AND p.designation = l.designation
				AND (
					p.document_id = d.predecessor_document_id
					OR p.document_id IN (
						SELECT s.source_document_id FROM "document_sources" s
						WHERE s.tenant_id = d.tenant_id AND s.document_id = d.id
					)
				)
		)
		AND l.quantity_milli = 1000 AND l.price_base = 1
		AND l.designation IN ('Notdienstzuschlag Nacht', 'Notdienstzuschlag Wochenende', 'Notdienstzuschlag Feiertag')
		AND (
			SELECT count(*) FROM "document_lines" o
			WHERE o.tenant_id = l.tenant_id AND o.document_id = l.document_id
				AND o.deleted_at IS NULL AND o.kind = 'item'
				AND (o.designation = 'Notdienstzuschlag' OR o.designation LIKE 'Notdienstzuschlag %')
		) = 1;--> statement-breakpoint
SELECT set_config('app.reason', '', true);--> statement-breakpoint
ALTER TABLE "document_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_lines" FORCE ROW LEVEL SECURITY;
