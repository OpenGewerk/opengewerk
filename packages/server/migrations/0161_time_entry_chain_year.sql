-- The years of the staff under the deletion concept, held fast (#1043, #1044).
--
-- **The year of a chain** (#1044): every record of time keeps the year its
-- chain of corrections began in, `chain_year`. The trigger
-- `chain_year_of_time_entries` writes it when the entry is made: the year it
-- starts in, in Germany, or that of the entry it corrects. `time_entry_year` (0131)
-- reads the column now, instead of walking up the chain a hundred links at
-- most; past that a correction counted with the year of another link, and two
-- years could hold each other so that neither ever went. The entries already
-- there get the year of the chain they are in, however long, and keep their
-- moment of writing: the triggers of the table are off for that statement,
-- so that neither `stamp_sync_columns` nor the protocol nor
-- `time_entries_stay_as_written` sees it. Under FORCE the owner that migrates
-- would find no row, so the table is without it for that statement too.
--
-- **A year that went takes nothing more** (#1043): a year of a person has one
-- line of the protocol (`erasures_once`), and a record that came into it
-- afterwards could never go. The triggers `…_stay_in_kept_years` refuse a
-- record of time, a time on call, an absence or days of leave in such a year,
-- also where a time on call, an absence or days of leave are moved into it.
-- They take the lock of the year that its deletion takes first
-- (`staff-year:<key>`, `erasure.ts`), so that a record that comes while its
-- year goes waits and is refused then. A lock of the year and not of the
-- person: a record of another year, or one while the file of the person goes,
-- waits for nothing (#1033). The records take it shared and the deletion
-- alone, so that two writes of one year never wait for each other here. Each fires before `stamp_sync_columns`, since
-- triggers of one event fire in the order of their names: that one takes the
-- counter of the business, which the deletion takes after the lock of the
-- year, and a record that held the counter while it waited for the lock would
-- hold up the deletion that holds the lock. Whose a record of time is, the
-- trigger reads from the request, as `time_entries_record_owner` writes it
-- after it. A row changed that stays with its person in its year takes no
-- lock of the year: it holds its row, which the deletion holds after the
-- lock. Where a transmission wrote before and so holds the counter already,
-- PostgreSQL breaks the deletion or the transmission off as a deadlock;
-- nothing went, the deletion says so (`ErasureBusy`), and either comes again.
--
-- **Fits the version before it**: it writes no `chain_year`, and the trigger
-- writes it for every entry it makes; `time_entry_year` answers as before for
-- every chain shorter than a hundred links, the only ones it accepted.
ALTER TABLE "time_entries" ADD COLUMN "chain_year" integer;--> statement-breakpoint
ALTER TABLE "time_entries" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_entries" DISABLE TRIGGER "stamp_sync_columns";--> statement-breakpoint
ALTER TABLE "time_entries" DISABLE TRIGGER "audit_changes";--> statement-breakpoint
ALTER TABLE "time_entries" DISABLE TRIGGER "time_entries_stay_as_written";--> statement-breakpoint
WITH RECURSIVE chains AS (
	SELECT t.id, extract(year FROM (t.started_at AT TIME ZONE 'Europe/Berlin'))::integer AS year
	  FROM "time_entries" t
	 WHERE t.corrects_entry_id IS NULL
	UNION ALL
	SELECT t.id, c.year
	  FROM "time_entries" t
	  JOIN chains c ON t.corrects_entry_id = c.id
)
UPDATE "time_entries" t SET "chain_year" = c.year FROM chains c WHERE t.id = c.id;--> statement-breakpoint
-- An entry no first entry reaches, one that would correct itself, keeps the
-- year it starts in, as `time_entry_year` had it.
UPDATE "time_entries"
   SET "chain_year" = extract(year FROM (started_at AT TIME ZONE 'Europe/Berlin'))::integer
 WHERE "chain_year" IS NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ENABLE TRIGGER "time_entries_stay_as_written";--> statement-breakpoint
ALTER TABLE "time_entries" ENABLE TRIGGER "audit_changes";--> statement-breakpoint
ALTER TABLE "time_entries" ENABLE TRIGGER "stamp_sync_columns";--> statement-breakpoint
ALTER TABLE "time_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_entries" ALTER COLUMN "chain_year" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "time_entries_chain_year_idx" ON "time_entries" USING btree ("tenant_id","user_id","chain_year");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "time_entry_year"(p_entry uuid) RETURNS integer
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public, pg_temp
AS $$
	SELECT t.chain_year FROM public.time_entries t WHERE t.id = p_entry
$$;--> statement-breakpoint
CREATE FUNCTION "staff_year_stays_kept"(p_person uuid, p_year integer) RETURNS void
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
	-- The lock the deletion of the year takes first: a record that comes while
	-- its year goes waits for the deletion, and then sees its line. Shared, so
	-- that two writes of the same year pass each other; only the deletion
	-- takes it alone.
	PERFORM pg_advisory_xact_lock_shared(hashtextextended('staff-year:' || public.staff_year_key(p_person, p_year)::text, 0));

	IF EXISTS (
		SELECT 1 FROM public.erasures e
		 WHERE e.kind::text = 'staff_year'
		   AND e.record_id = public.staff_year_key(p_person, p_year)) THEN
		RAISE EXCEPTION 'Das Jahr % dieser Person ist nach dem Löschkonzept gelöscht. Für dieses Jahr nimmt OpenGewerk nichts mehr an.', p_year
			USING ERRCODE = 'OG001';
	END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "time_entry_takes_its_chain_year"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
	v_person uuid;
BEGIN
	new.chain_year := coalesce(
		(SELECT t.chain_year FROM public.time_entries t
		  WHERE t.tenant_id = new.tenant_id AND t.id = new.corrects_entry_id),
		extract(year FROM (new.started_at AT TIME ZONE 'Europe/Berlin'))::integer);

	-- Whose entry it is, as `record_time_owner` writes it after this one.
	FOR v_person IN SELECT p.id FROM public.people p
	                 WHERE p.user_id = nullif(current_setting('app.user_id', true), '')
	                 ORDER BY p.id LOOP
		PERFORM public.staff_year_stays_kept(v_person, new.chain_year);
	END LOOP;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "on_call_shift_stays_in_kept_years"() RETURNS trigger
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

	FOR v_person IN SELECT p.id FROM public.people p WHERE p.user_id = new.user_id ORDER BY p.id LOOP
		PERFORM public.staff_year_stays_kept(v_person, extract(year FROM (new.starts_at AT TIME ZONE 'Europe/Berlin'))::integer);
	END LOOP;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "absence_stays_in_kept_years"() RETURNS trigger
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

	PERFORM public.staff_year_stays_kept(new.person_id, extract(year FROM new.first_day)::integer);

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "leave_stays_in_kept_years"() RETURNS trigger
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

	PERFORM public.staff_year_stays_kept(new.person_id, new.year);

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "chain_year_of_time_entries" BEFORE INSERT ON "time_entries"
	FOR EACH ROW EXECUTE FUNCTION "time_entry_takes_its_chain_year"();--> statement-breakpoint
CREATE TRIGGER "on_call_shifts_stay_in_kept_years" BEFORE INSERT OR UPDATE OF "user_id", "starts_at" ON "on_call_shifts"
	FOR EACH ROW EXECUTE FUNCTION "on_call_shift_stays_in_kept_years"();--> statement-breakpoint
CREATE TRIGGER "absences_stay_in_kept_years" BEFORE INSERT OR UPDATE OF "person_id", "first_day" ON "absences"
	FOR EACH ROW EXECUTE FUNCTION "absence_stays_in_kept_years"();--> statement-breakpoint
CREATE TRIGGER "leave_entitlements_stay_in_kept_years" BEFORE INSERT OR UPDATE OF "person_id", "year" ON "leave_entitlements"
	FOR EACH ROW EXECUTE FUNCTION "leave_stays_in_kept_years"();
