-- Takes back 0152 (#1046). A declaration for the zero rate given with a
-- signature is the proof the business keeps for a line at 0 percent: while
-- there is one, this rollback stops.

DO $$
BEGIN
	ALTER TABLE document_signatures NO FORCE ROW LEVEL SECURITY;

	IF EXISTS (SELECT 1 FROM document_signatures WHERE zero_rate_declaration IS NOT NULL) THEN
		RAISE EXCEPTION 'Es gibt schon Unterschriften mit einer Erklärung zum Nullsteuersatz. Die Rücknahme von 0152 würde sie löschen und bricht deshalb ab.';
	END IF;

	ALTER TABLE document_signatures FORCE ROW LEVEL SECURITY;
	-- In the same block as the check: however the rollback runs its
	-- statements, the column goes only when the check passed.
	ALTER TABLE document_signatures DROP COLUMN zero_rate_declaration;
END
$$;
