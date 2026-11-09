-- The count of an account's credentials, against a session written after
-- they were taken back. A sign in reads the password, checks it, and writes
-- its session a moment later; ending every session when a password changes
-- did not reach one written in that moment. From here every revocation counts
-- the account up in the transaction that ends its sessions, a sign in takes
-- the count as it begins, and a session carries it. The columns and the
-- trigger are the foundation's (`credentials.ts` and the block `setup.sql`);
-- every application adds them with a migration of its own.
--
-- **What the sessions of before get.** The count their account has, which is
-- the first one: nothing was revoked under it yet, and they stay signed in.
--
-- **A version from before.** It writes a session without a count in the
-- moment an update runs, before its image is replaced. The trigger takes it,
-- and the server does not let it in at its first request; whoever signed in
-- in that moment signs in once more.
--
-- Row level security is lifted on the sessions for the statement that fills
-- them, because as the owner under FORCE it would find no row and say
-- nothing. The accounts the owner reads anyway (`readable_by_the_owner`,
-- 0011).
ALTER TABLE "auth_sessions" ADD COLUMN "credential_generation" integer;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "credential_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "auth_sessions" s SET "credential_generation" = u."credential_generation"
	FROM "auth_users" u WHERE u."id" = s."user_id";--> statement-breakpoint
ALTER TABLE "auth_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE FUNCTION "session_fits_its_credentials"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	standing integer;
BEGIN
	SELECT u.credential_generation INTO standing
	  FROM public.auth_users u
	 WHERE u.id = NEW.user_id
	   FOR SHARE;

	IF NEW.credential_generation IS NOT NULL
	   AND (standing IS NULL OR NEW.credential_generation <> standing) THEN
		RAISE EXCEPTION 'Die Anmeldung begann vor einer Änderung der Zugangsdaten und gilt nicht. Bitte noch einmal anmelden.'
			USING ERRCODE = 'OG015';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "auth_sessions_fit_their_credentials" BEFORE INSERT OR UPDATE OF "credential_generation" ON "auth_sessions"
	FOR EACH ROW EXECUTE FUNCTION "session_fits_its_credentials"();
