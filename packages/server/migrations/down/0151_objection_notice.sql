-- Takes back 0151 (#1026). A confirmation of the notice on the objection is a
-- record the business keeps for its customers of section 7 (3) UWG: while
-- there is one, this rollback stops. Without them the version before counts
-- every such customer as confirmed, which is what it did.

DO $$
BEGIN
	ALTER TABLE customers NO FORCE ROW LEVEL SECURITY;

	IF EXISTS (SELECT 1 FROM customers WHERE objection_notice_confirmed) THEN
		RAISE EXCEPTION 'Es gibt schon bestätigte Hinweise auf den Widerspruch bei Bestandskunden. Die Rücknahme von 0151 würde sie löschen und bricht deshalb ab.';
	END IF;

	ALTER TABLE customers FORCE ROW LEVEL SECURITY;
	-- In the same block as the check: however the rollback runs its
	-- statements, the column goes only when the check passed.
	ALTER TABLE customers DROP COLUMN objection_notice_confirmed;
END
$$;
