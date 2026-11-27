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
-- **Fits the version before it**: it links files as before, and a link it
-- refuses is one the deletion could never have taken back.
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
