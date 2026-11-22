-- The declaration for the zero rate of section 12 (3) UStG that a customer
-- gives with the signature under a report (#1046), as the page showed it.
-- Every signature from before has none, as no report carried one.
ALTER TABLE "document_signatures" ADD COLUMN "zero_rate_declaration" text;