-- Takes back 0161 (#1043, #1044). The triggers that keep a deleted year empty
-- go, and so does the year of the chain: `time_entry_year` walks up the chain
-- again, a hundred links at most, as 0131 wrote it and 0150 gave it its path.
-- Nothing of the staff is deleted or changed.
--
-- Run as the superuser, like every rollback.
DROP TRIGGER IF EXISTS "leave_entitlements_stay_in_kept_years" ON "leave_entitlements";--> statement-breakpoint
DROP TRIGGER IF EXISTS "absences_stay_in_kept_years" ON "absences";--> statement-breakpoint
DROP TRIGGER IF EXISTS "on_call_shifts_stay_in_kept_years" ON "on_call_shifts";--> statement-breakpoint
DROP TRIGGER IF EXISTS "chain_year_of_time_entries" ON "time_entries";--> statement-breakpoint
DROP FUNCTION IF EXISTS "leave_stays_in_kept_years"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "absence_stays_in_kept_years"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "on_call_shift_stays_in_kept_years"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "time_entry_takes_its_chain_year"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "staff_year_stays_kept"(uuid, integer);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "time_entry_year"(p_entry uuid) RETURNS integer
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public, pg_temp
AS $$
	WITH RECURSIVE chain AS (
		SELECT t.id, t.corrects_entry_id, t.started_at, 0 AS depth
		  FROM public.time_entries t WHERE t.id = p_entry
		UNION ALL
		SELECT t.id, t.corrects_entry_id, t.started_at, c.depth + 1
		  FROM public.time_entries t JOIN chain c ON t.id = c.corrects_entry_id
		 WHERE c.depth < 100
	)
	SELECT extract(year FROM (started_at AT TIME ZONE 'Europe/Berlin'))::integer
	  FROM chain ORDER BY depth DESC LIMIT 1
$$;--> statement-breakpoint
DROP INDEX IF EXISTS "time_entries_chain_year_idx";--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN IF EXISTS "chain_year";
