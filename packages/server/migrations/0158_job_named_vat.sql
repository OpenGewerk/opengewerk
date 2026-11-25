-- The tax a surcharge was named with before the order (#1083), in basis
-- points, 0 under section 19 UStG. The invoice charges no more than the
-- amount with this tax, whatever tax it has itself. A call from before has
-- none recorded, and its amount counts net, as until now.
ALTER TABLE "jobs" ADD COLUMN "emergency_named_vat_basis_points" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_emergency_named_vat" CHECK ("jobs"."emergency_named_vat_basis_points" is null or ("jobs"."emergency_named_flat_cents" is not null
        and "jobs"."emergency_named_vat_basis_points" between 0 and 10000));