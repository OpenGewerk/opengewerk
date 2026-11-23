-- The surcharge named to a consumer before the order of an emergency call
-- (#1081): a flat amount in cents or a percentage on the working time, as the
-- device named it; both zero where it could name none. Section 312e BGB lets
-- the business charge no more than that, so the invoice takes the lower of
-- this and the surcharge of the day. Every job from before has neither and is
-- billed by the settings of the day, as it was.
ALTER TABLE "jobs" ADD COLUMN "emergency_named_flat_cents" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "emergency_named_basis_points" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_emergency_named" CHECK (("jobs"."emergency_named_flat_cents" is null) = ("jobs"."emergency_named_basis_points" is null)
        and ("jobs"."emergency_named_flat_cents" is null or ("jobs"."emergency_at" is not null
          and "jobs"."emergency_named_flat_cents" between 0 and 100000000
          and "jobs"."emergency_named_basis_points" between 0 and 100000)));