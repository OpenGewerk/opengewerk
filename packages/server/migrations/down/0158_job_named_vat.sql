-- Takes back 0158 (#1083). The tax goes with its column; the version before
-- holds the named amount net.
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_emergency_named_vat";
ALTER TABLE "jobs" DROP COLUMN "emergency_named_vat_basis_points";
