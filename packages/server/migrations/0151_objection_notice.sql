-- The confirmation that a customer of section 7 (3) UWG was told about the
-- objection when the address was collected (#1026). Every customer stored
-- as one before has none and is not reminded until the office confirms it.
ALTER TABLE "customers" ADD COLUMN "objection_notice_confirmed" boolean DEFAULT false NOT NULL;