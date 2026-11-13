-- Takes back 0144: a file a signed protocol names as a photo can be moved
-- again. Run as the superuser, like every rollback.
DROP TRIGGER "attachments_named_by_signed_protocols" ON "attachments";--> statement-breakpoint
DROP FUNCTION "attachment_named_by_signed_protocols"();
