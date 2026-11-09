-- Takes back 0135: the wording a request for an early start was signed under.
-- It is part of what the customer signed, and this rollback deletes none.
-- While a request carries one, it stops. Which they are, this shows:
--
--   select id, job_id, signed_at from early_start_requests where wording is not null;
--
-- Run as the superuser, like every rollback.

-- The table is locked first and stays locked until the column is gone, in
-- one transaction: a request that lands meanwhile waits, and one being
-- written as the rollback starts is through before the check looks.
DO $$
BEGIN
	LOCK TABLE "early_start_requests" IN ACCESS EXCLUSIVE MODE;

	IF EXISTS (SELECT 1 FROM "early_start_requests" WHERE "wording" IS NOT NULL) THEN
		RAISE EXCEPTION 'Ein Verlangen auf vorzeitigen Beginn trägt den Wortlaut, unter dem es unterschrieben wurde. Die Rücknahme würde ihn löschen und hält an.';
	END IF;

	ALTER TABLE "early_start_requests" DROP COLUMN "wording";
END
$$;
