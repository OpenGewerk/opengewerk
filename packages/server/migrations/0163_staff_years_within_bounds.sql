-- A record of time and a time on call lie in a year from 1970 to the one
-- after this (GHSA-9f85-85g8-g7w3).
--
-- Since 0161 a record of time and a time on call of a person take the lock of
-- their year, shared, and hold it until their transaction ends. The year had
-- no bound: a transmission of records of time spread over a thousand years
-- took a thousand locks, out of the one table of locks every session of the
-- instance shares, and together with others it could fill that table for
-- everybody. A year outside the bound is no year a business keeps records of
-- time for either. Absences and days of leave keep the years 2000 to 2100 of
-- the domain (`absenceLimits`), and no transmission brings them.
--
-- `staff_year_within_bounds` refuses such a year with a sentence, before the
-- two triggers take any lock and before they look for the file. The year
-- after this one stays open for what is planned ahead. A link (0162) asks
-- every year an account has records in; one outside the bound, from before
-- this migration, it asks without the lock.
--
-- **Fits the version before it**: it takes every record of a year within the
-- bound as before. A device of the version before that sends one outside it
-- is told why, and keeps the operation until somebody lets it go.
CREATE FUNCTION "staff_year_in_bounds"(p_year integer) RETURNS boolean
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public, pg_temp
AS $$
	SELECT p_year BETWEEN 1970 AND extract(year FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer + 1;
$$;--> statement-breakpoint
CREATE FUNCTION "staff_year_within_bounds"(p_year integer) RETURNS void
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
	IF NOT public.staff_year_in_bounds(p_year) THEN
		RAISE EXCEPTION 'OpenGewerk nimmt Arbeitszeit und Rufbereitschaft für die Jahre 1970 bis % an, nicht für %.', extract(year FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer + 1, p_year USING ERRCODE = 'OG001';
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
		-- A year outside the bound comes only from before 0163, and asking it
		-- takes no lock: a link would otherwise take one for every such year.
		-- Such a year that went is refused all the same; only a deletion of
		-- it at the very same moment is not waited for.
		IF public.staff_year_in_bounds(v_year) THEN
			PERFORM public.staff_year_stays_kept(new.id, v_year);
		ELSIF EXISTS (SELECT 1 FROM public.erasures e
		               WHERE e.kind::text = 'staff_year' AND e.record_id = public.staff_year_key(new.id, v_year)) THEN
			RAISE EXCEPTION 'Das Jahr % dieser Person ist nach dem Löschkonzept gelöscht. Für dieses Jahr nimmt OpenGewerk nichts mehr an.', v_year USING ERRCODE = 'OG001';
		END IF;
	END LOOP;

	RETURN new;
END;
$$;
