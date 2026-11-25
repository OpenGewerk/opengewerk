-- How an update from the area of the instance ended stands in the log of the
-- instance and in the log of every business on it (opengewerk#1093).
--
-- **`instance_updates`**: a row per run, outside any business. The trigger of
-- the instance writes it into `instance_changes`.
--
-- **`update_notices`**: a row per run in every business, and its
-- audit trigger writes it into the log of the business, beside a change of the
-- mail server of the instance.
--
-- Both say from which version to which, and whether the run went through or
-- in which step it stopped. Both tables are the foundation's; everything down
-- to the policies comes from the schema. What follows them is written by hand:
-- FORCE, the grant and the trigger of each table. A row says how a run ended,
-- so the grant stops at INSERT.
--
-- Nothing is written and no row is touched. A version of the application from
-- before this migration runs on unchanged; it writes no such rows.
CREATE TABLE "instance_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_version" text NOT NULL,
	"from_version" text,
	"succeeded" boolean NOT NULL,
	"stopped_in" text,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "instance_updates_stopped_somewhere" CHECK ("instance_updates"."succeeded" = ("instance_updates"."stopped_in" is null))
);
--> statement-breakpoint
ALTER TABLE "instance_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "update_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"to_version" text NOT NULL,
	"from_version" text,
	"succeeded" boolean NOT NULL,
	"stopped_in" text,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "update_notices_once" UNIQUE("tenant_id","run_id"),
	CONSTRAINT "update_notices_stopped_somewhere" CHECK ("update_notices"."succeeded" = ("update_notices"."stopped_in" is null))
);
--> statement-breakpoint
ALTER TABLE "update_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "update_notices" ADD CONSTRAINT "update_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "outside_any_tenant" ON "instance_updates" AS PERMISSIVE FOR ALL TO "opengewerk_app" USING (nullif(current_setting('app.tenant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.tenant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "update_notices" AS PERMISSIVE FOR ALL TO "opengewerk_app" USING ("update_notices"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("update_notices"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "instance_updates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON "instance_updates" TO "opengewerk_app";--> statement-breakpoint
CREATE TRIGGER "instance_changes" AFTER INSERT OR UPDATE OR DELETE ON "instance_updates"
	FOR EACH ROW EXECUTE FUNCTION "record_instance_change"();--> statement-breakpoint

ALTER TABLE "update_notices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON "update_notices" TO "opengewerk_app";--> statement-breakpoint
CREATE TRIGGER "audit_changes" AFTER INSERT OR UPDATE OR DELETE ON "update_notices"
	FOR EACH ROW EXECUTE FUNCTION "record_change"();
