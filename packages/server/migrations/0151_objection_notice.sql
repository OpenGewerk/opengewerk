-- The address for which the office confirmed that a customer of section
-- 7 (3) UWG was told about the objection when it was collected (#1026).
-- Every customer stored as one before has none and is not reminded until
-- the office confirms it; a new address needs it again.
ALTER TABLE "customers" ADD COLUMN "objection_notice_address" text;