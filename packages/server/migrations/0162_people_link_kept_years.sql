-- A file linked to an account brings nothing into a year that went (#1132).
--
-- Since 0161 a year of a person under the deletion concept takes no record of
-- time, time on call, absence or days of leave once it went. The records of
-- time and the times on call of an account count with the file that names the
-- account (`people.user_id`), so a file linked to an account afterwards, one
-- with records in a year of the file that went, would bring them into that
-- year: it held something again, a second deletion broke on `erasures_once`,
-- and the file kept its name because a year seemed kept.
--
-- The trigger `people_link_only_kept_years` refuses such a link, with the
-- sentence of `staff_year_stays_kept` (0161), which it asks for every year of
-- the account, in their order, and which takes the lock of each year shared
-- first: a link that comes while one of them goes waits and is refused then.
-- It fires before `stamp_sync_columns`, for the order of the locks against the
-- deletion that 0161 describes. The row of the file it holds already; a
-- deletion of a year whose file went holds that row after the lock of the
-- year, and where the two meet PostgreSQL breaks one off, and nothing went.
--
-- A link and a record the account writes meanwhile meet in a lock of the
-- account (`staff-account:<user_id>`): the link takes it alone before it looks
-- for the years of the account, and the two triggers of 0161 that find the
-- file of a record by its account take it shared before they look for the
-- file, so both are replaced here. Whichever comes second waits for the first
-- to end and then sees what it wrote: the record the file and with it the year
-- that went, the link the record and with it its year. Without the lock
-- neither saw the other, and both went through. A transmission that wrote
-- something else first holds the counter of the business, which the link
-- waits for after the lock; the two meet in a ring, PostgreSQL breaks one of
-- them off, and nothing went.
--
-- **Fits the version before it**: it links files and takes records as before,
-- and a link it refuses is one the deletion could never have taken back.
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
CREATE FUNCTION "people_link_only_kept_years"() RETURNS trigger
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
CREATE TRIGGER "people_link_only_kept_years" BEFORE UPDATE OF "user_id" ON "people"
	FOR EACH ROW EXECUTE FUNCTION "people_link_only_kept_years"();
