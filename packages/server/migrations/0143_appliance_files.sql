-- A file can hang on an appliance of the register (opengewerk#817): the photo
-- of what is wrong with it, taken at its test after DGUV Vorschrift 3, as the
-- photo of a defect at a circuit hangs on its installation. The new column is
-- empty in every row, so the key checks nothing that is there; the check that
-- a file has a home counts the appliance as one place more.
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_have_a_home";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "appliance_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_appliance_in_tenant" FOREIGN KEY ("tenant_id","appliance_id") REFERENCES "public"."appliances"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_appliance_idx" ON "attachments" USING btree ("tenant_id","appliance_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_have_a_home" CHECK (num_nonnulls("attachments"."customer_id", "attachments"."site_id", "attachments"."installation_id", "attachments"."appliance_id", "attachments"."job_id") >= 1);