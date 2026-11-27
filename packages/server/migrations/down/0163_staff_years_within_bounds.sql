-- Takes back 0163 (GHSA-9f85-85g8-g7w3). A record of time and a time on
-- call take any year again, as before, and the triggers are as 0162 wrote
-- them; nothing of the staff is deleted or changed.
--
-- Run as the superuser, like every rollback.
CREATE OR REPLACE FUNCTION "time_entry_takes_its_chain_year"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	v_person uuid;
	v_account text := nullif(current_setting('app.user_id', true), '');
BEGIN
	new.chain_year := coalesce(
		(SELECT t.chain_year FROM public.time_entries t
		  WHERE t.tenant_id = new.tenant_id AND t.id = new.corrects_entry_id),
		extract(year FROM (new.started_at AT TIME ZONE 'Europe/Berlin'))::integer);

	-- The account first, so that a link of a file to it waits for this record
	-- or this record for the link, and the file below is the one after it.
	IF v_account IS NOT NULL THEN
		PERFORM pg_advisory_xact_lock_shared(hashtextextended('staff-account:' || v_account, 0));
	END IF;

	-- Whose entry it is, as `record_time_owner` writes it after this one.
	FOR v_person IN SELECT p.id FROM public.people p
	                 WHERE p.user_id = v_account
	                 ORDER BY p.id LOOP
		PERFORM public.staff_year_stays_kept(v_person, new.chain_year);
	END LOOP;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "on_call_shift_stays_in_kept_years"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	v_person uuid;
BEGIN
	-- A row that stays with its person in its year takes no lock of the year:
	-- it holds its row already, and the deletion holds the rows of the year
	-- after its lock, so that waiting for the lock here would close a ring.
	-- The row orders itself against the deletion as before 0161.
	IF tg_op = 'UPDATE' AND new.user_id = old.user_id
	   AND extract(year FROM (new.starts_at AT TIME ZONE 'Europe/Berlin')) = extract(year FROM (old.starts_at AT TIME ZONE 'Europe/Berlin')) THEN
		RETURN new;
	END IF;

	-- The account first, as for a record of time.
	PERFORM pg_advisory_xact_lock_shared(hashtextextended('staff-account:' || new.user_id::text, 0));

	FOR v_person IN SELECT p.id FROM public.people p WHERE p.user_id = new.user_id ORDER BY p.id LOOP
		PERFORM public.staff_year_stays_kept(v_person, extract(year FROM (new.starts_at AT TIME ZONE 'Europe/Berlin'))::integer);
	END LOOP;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "people_link_only_kept_years"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	v_year integer;
BEGIN
	IF new.user_id IS NULL OR new.user_id IS NOT DISTINCT FROM old.user_id THEN
		RETURN new;
	END IF;

	-- Alone, so that a record the account writes meanwhile is either written
	-- and found below or waits and finds this file.
	PERFORM pg_advisory_xact_lock(hashtextextended('staff-account:' || new.user_id::text, 0));

	FOR v_year IN
		SELECT t.chain_year FROM public.time_entries t WHERE t.user_id = new.user_id
		UNION
		SELECT extract(year FROM (s.starts_at AT TIME ZONE 'Europe/Berlin'))::integer
		  FROM public.on_call_shifts s WHERE s.user_id = new.user_id
		ORDER BY 1
	LOOP
		PERFORM public.staff_year_stays_kept(new.id, v_year);
	END LOOP;

	RETURN new;
END;
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS "staff_year_stays_kept_within"(uuid, integer);--> statement-breakpoint
DROP FUNCTION IF EXISTS "staff_year_within_bounds"(integer);--> statement-breakpoint
DROP FUNCTION IF EXISTS "staff_year_in_bounds"(integer);
