-- Takes back 0136 (opengewerk#896): whose a mail to a customer is. Only that
-- goes; the mails stay, and the deletion of a customer finds them again
-- through what they name, a reminder through its cause. A job given to
-- another customer since a mail was written is then no longer noticed when
-- the mail goes out. Run as the superuser, like every rollback.

DROP INDEX "mail_outbox_customer_idx";
ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_customer_in_tenant";
ALTER TABLE "mail_outbox" DROP COLUMN "customer_id";
