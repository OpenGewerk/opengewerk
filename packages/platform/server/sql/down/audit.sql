-- Takes the block `audit.sql` back out, before the tables it stands on.
--
-- A chain the transaction has open is written first, so that its trigger can
-- go (opengewerk#953).
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_chain_closes') THEN
		SET CONSTRAINTS "audit_chain_closes" IMMEDIATE;
	END IF;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_chain_closes" ON "audit_chains";--> statement-breakpoint
DROP FUNCTION IF EXISTS "close_audit_chain"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_chain_head"(uuid, bigint, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS "lock_audit_chain"(uuid);--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_entries_stay_on_truncate" ON "audit_entries";--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_entries_stay" ON "audit_entries";--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_entry_stays"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_redaction_applied" ON "audit_redactions";--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_redaction_checked" ON "audit_redactions";--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_redaction_applied"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_redaction_checked"();--> statement-breakpoint

-- The same question to the catalogue as for the sync columns: the trigger
-- goes wherever it hangs.
DO $$
DECLARE
	target text;
BEGIN
	FOR target IN
		SELECT c.relname
		  FROM pg_trigger t
		  JOIN pg_class c ON c.oid = t.tgrelid
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public'
		   AND t.tgname = 'audit_changes'
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS "audit_changes" ON %I', target);
	END LOOP;
END
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS "verify_audit_chain"(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS "record_change"();--> statement-breakpoint

-- Before the table, not after it. The fingerprint, the witness and the check
-- of one entry take a row of audit_entries as their argument, so the table type
-- is part of their signatures and PostgreSQL refuses to drop the table while
-- they exist.
DROP FUNCTION IF EXISTS "audit_entry_problem"(public.audit_entries);--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_witness"(public.audit_entries);--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_fingerprint"(public.audit_entries);--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_value_commitment"(text, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_value_digest"(text);
