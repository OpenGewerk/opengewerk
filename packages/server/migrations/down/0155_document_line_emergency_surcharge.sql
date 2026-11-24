-- Takes back 0155 (#1087). The mark goes with its column; the version before
-- leaves the line of the surcharge as the invoice got it.
ALTER TABLE "document_lines" DROP COLUMN "emergency_surcharge";
