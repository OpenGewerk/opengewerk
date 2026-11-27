-- A record of the staff lies in a year from 1970 to the one after this
-- (GHSA-9f85-85g8-g7w3).
--
-- Since 0161 a record of time, a time on call, an absence or days of leave of
-- a person takes the lock of its year, shared, and holds it until its
-- transaction ends. The year had no bound: a transmission of records spread
-- over a thousand years took a thousand locks, out of the one table of locks
-- every session of the instance shares, and together with others it could
-- empty that table for everybody. A year outside the bound is no year a
-- business keeps records for either.
--
-- `staff_year_within_bounds` refuses such a year with a sentence, before the
-- four triggers take any lock, and before they look for the file. The year
-- after this one stays open for what is planned ahead, leave above all.
-- `staff_year_stays_kept` takes no bound: a link (0162) asks it for every
-- year an account has records in, and records from before stay as they are.
--
-- **Fits the version before it**: it takes every record of a year within the
-- bound as before. A device of the version before that sends one outside it
-- is told why, and keeps the operation until somebody lets it go.
CREATE FUNCTION "staff_year_within_bounds"(p_year integer) RETURNS void
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	v_last integer := extract(year FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer + 1;
BEGIN
	IF p_year < 1970 OR p_year > v_last THEN
		RAISE EXCEPTION 'OpenGewerk nimmt Arbeitszeit, Rufbereitschaft, Abwesenheit und Urlaub für die Jahre 1970 bis % an, nicht für %.', v_last, p_year USING ERRCODE = 'OG001';
	END IF;
END;
$$;--> statement-breakpoint
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

	-- Within the years OpenGewerk takes, before any lock (0163).
	PERFORM public.staff_year_within_bounds(new.chain_year);

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

	-- Within the years OpenGewerk takes, before any lock (0163).
	PERFORM public.staff_year_within_bounds(extract(year FROM (new.starts_at AT TIME ZONE 'Europe/Berlin'))::integer);

	-- The account first, as for a record of time.
	PERFORM pg_advisory_xact_lock_shared(hashtextextended('staff-account:' || new.user_id::text, 0));

	FOR v_person IN SELECT p.id FROM public.people p WHERE p.user_id = new.user_id ORDER BY p.id LOOP
		PERFORM public.staff_year_stays_kept(v_person, extract(year FROM (new.starts_at AT TIME ZONE 'Europe/Berlin'))::integer);
	END LOOP;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "absence_stays_in_kept_years"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
	-- A row that stays with its person in its year takes no lock of the year:
	-- it holds its row already, and the deletion holds the rows of the year
	-- after its lock, so that waiting for the lock here would close a ring.
	-- The row orders itself against the deletion as before 0161.
	IF tg_op = 'UPDATE' AND new.person_id = old.person_id
	   AND extract(year FROM new.first_day) = extract(year FROM old.first_day) THEN
		RETURN new;
	END IF;

	-- Within the years OpenGewerk takes, before any lock (0163).
	PERFORM public.staff_year_within_bounds(extract(year FROM new.first_day)::integer);

	PERFORM public.staff_year_stays_kept(new.person_id, extract(year FROM new.first_day)::integer);

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "leave_stays_in_kept_years"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
	-- A row that stays with its person in its year takes no lock of the year:
	-- it holds its row already, and the deletion holds the rows of the year
	-- after its lock, so that waiting for the lock here would close a ring.
	-- The row orders itself against the deletion as before 0161.
	IF tg_op = 'UPDATE' AND new.person_id = old.person_id AND new.year = old.year THEN
		RETURN new;
	END IF;

	-- Within the years OpenGewerk takes, before any lock (0163).
	PERFORM public.staff_year_within_bounds(new.year);

	PERFORM public.staff_year_stays_kept(new.person_id, new.year);

	RETURN new;
END;
$$;
