-- Takes the count of the credentials out again, back to how 0136 left
-- things: a session is ended by deleting its row, as before. Run as the
-- superuser, like every rollback.
DROP TRIGGER IF EXISTS "auth_sessions_fit_their_credentials" ON "auth_sessions";--> statement-breakpoint
DROP FUNCTION IF EXISTS "session_fits_its_credentials"();--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP COLUMN IF EXISTS "credential_generation";--> statement-breakpoint
ALTER TABLE "auth_users" DROP COLUMN IF EXISTS "credential_generation";
