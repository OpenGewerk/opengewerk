-- Every trigger function of the foundation that runs as the owner of the
-- tables is closed to every role but the owner (opengewerk#975). A function is
-- open to PUBLIC until somebody says otherwise, and any role may make a
-- temporary table in its session and hang a trigger function on it that it
-- may execute. Hung there, one of these would write the log, the counter or
-- the files of any tenant as the owner. Triggers already on the tables fire
-- as before: the right is asked when a trigger is made, not when it fires.
-- The functions are the foundation's (blocks `audit.sql`, `instance.sql`,
-- `attachments.sql`, `sync.sql`); the trigger functions of this application
-- were closed by the migrations that made them. And no role but the owner
-- creates in public any more, which PostgreSQL 15 took from every role and a
-- cluster upgraded from an older version still grants: what another role put
-- there first would be found by these functions (block `roles.sql`). The
-- rollback leaves that as it is.
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "close_audit_chain"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "record_change"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "audit_redaction_checked"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "audit_redaction_applied"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "record_instance_change"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "version_takes_its_files"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "close_sync_counter"() FROM PUBLIC;--> statement-breakpoint
-- And every function names the temporary schema last in its search path, as
-- the blocks do now (`roles.sql`): left out, it is searched first for tables
-- and types, and a type another role made there in its session would stand in
-- for one a function of the owner declares.
ALTER FUNCTION "absence_goes_with_its_year"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "access_request_contact_in_tenant"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "access_request_moves_on"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "application_attachment_may_go"(p_attachment uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "application_file_named_by_a_value"(p_tenant uuid, p_hash text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "article_import_writing"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "article_search_hits"(pattern text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "article_search_of_articles"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "article_search_of_supplier_articles"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "attachment_may_go"(p_attachment uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "attachment_named_by_signed_protocols"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "attachment_purging"(p_attachment uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "attachment_version_stays_as_written"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_chain_head"(tenant uuid, committed_place bigint, committed_hash text, OUT place bigint, OUT previous text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_entry_problem"(entry audit_entries) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_fingerprint"(entry audit_entries) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_redaction_applied"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_redaction_checked"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_value_commitment"(nonce text, value text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_value_digest"(value text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "audit_witness"(entry audit_entries) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "calendar_feed_for"(hash text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "close_audit_chain"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "contacts_follow_deletion"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "counter_address"(kind text, tenant uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "counter_hint"(kind text, tenant uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "create_first_tenant"(company text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "create_tenant"(company text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "customer_erasing"(p_customer uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "customer_of_row"(p_row jsonb) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "defect_changes"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "defect_photo_at_its_place"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "defects_from_acceptance"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "document_file_takes_its_file"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "early_start_for_service_call"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "erasure_counted_in_its_transaction"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "erasure_request_moves_on"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "every_tenant"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "file_goes_with_its_document"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "file_named_by_a_value"(p_tenant uuid, p_hash text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "file_naming_lock"(p_tenant uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "files_held"(candidates text[]) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "first_supplier_is_main"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "form_definition_stays"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "form_record_appliance_facts"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "form_record_stays_signed"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "goes_only_with_its_customer"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "goes_only_with_its_site"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "goes_with_the_file"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "instance_is_empty"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "invitation_for"(hash text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "job_follows_finished_job"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "keep_counter_hint"(kind text, tenant uuid, hint text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "keep_label_blocked"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "leave_goes_with_its_year"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "location_consent_goes_with_its_person"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "lock_audit_chain"(tenant uuid, OUT next_sequence bigint, OUT head_hash text, OUT opened_in xid8, OUT address tid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "lock_sync_counter"(tenant uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "main_supplier_follows"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "mark_structure_deleted"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "material_follows_deletion"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "on_call_shift_goes_with_its_year"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "person_erasing"(p_person uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "purge_attachment"(p_attachment uuid, p_title text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "pv_link_holds"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "pv_links_follow"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "qualification_keeps_its_replaced_certificate"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "qualification_takes_its_certificate"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "record_attachment_uploader"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "record_change"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "record_instance_change"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "record_note_author"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "record_task_author"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "record_time_owner"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "release_sources"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "replaced_certificate_takes_its_file"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "session_fits_its_credentials"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "signature_stays_as_written"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "site_accesses_follow_deletion"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "site_erasing"(p_site uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "site_of_row"(p_row jsonb) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "source_fits_invoice"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "staff_erasing"(p_kind text, p_record uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "staff_year_erasing"(p_person uuid, p_year integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "staff_year_key"(p_person uuid, p_year integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "stamp_closed_at"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "stamp_sync_columns"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "stays_as_written"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "successor_of_uncollected_report"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "take_defect_step"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "tenant_role_stays_whole"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "tenants_with_leads"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "time_entry_stays_as_written"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "time_entry_year"(p_entry uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "verify_audit_chain"(tenant uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "version_takes_its_files"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
-- And those that set none so far get one as well: they take the path of
-- whoever fires them otherwise, with the temporary schema searched first.
ALTER FUNCTION "audit_entry_stays"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "instance_change_stays"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "book_delivered_material"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "book_material_of"(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "book_report_material"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "cancellation_only_from_its_invoice"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "document_line_stays_fixed"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "document_lines_within_count"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "document_stays_fixed"() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION "sign_document"() SET search_path = pg_catalog, public, pg_temp;
