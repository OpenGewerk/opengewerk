-- The name the file of a certificate is shown by, beside its hash
-- (opengewerk#802): a column "Nachweis" in the file of a person names it, and
-- the access report hands it over under that name. Both or neither: a hash
-- without a name, or a name without a file, is no certificate. No row holds
-- a hash yet, since no route wrote one before this, so the check finds
-- nothing to refuse. The column and the checks are the foundation's
-- (`qualificationSchema`); every application adds them with a migration of
-- its own.
ALTER TABLE "qualifications" ADD COLUMN "certificate_name" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_certificate_named" CHECK (num_nonnulls("qualifications"."certificate_sha256", "qualifications"."certificate_name") in (0, 2));--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_certificate_name_fits" CHECK ("qualifications"."certificate_name" is null or char_length("qualifications"."certificate_name") between 1 and 200);
