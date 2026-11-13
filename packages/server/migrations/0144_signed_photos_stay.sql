-- A file a signed protocol names as a photo stays where it hung (opengewerk#934).
-- The page of a signed protocol shows the photo its field names without asking
-- where the file hangs now, so that a later move does not change the page; the
-- sync refuses a signature whose photo does not hang at what the protocol is
-- about (`signedPhotos` in `database/sync.ts`), and this keeps it there after.
-- Which field of a definition is a photo only the application knows; here a
-- signed protocol of the same installation, appliance or job names the file
-- when its values hold the id of the file as a whole JSON string, which errs
-- only towards keeping a file in place. SECURITY DEFINER is not needed: the
-- protocols of a tenant are visible to the application role as a whole.
CREATE FUNCTION "attachment_named_by_signed_protocols"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF old.installation_id IS NOT DISTINCT FROM new.installation_id
	   AND old.appliance_id IS NOT DISTINCT FROM new.appliance_id
	   AND old.job_id IS NOT DISTINCT FROM new.job_id THEN
		RETURN new;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public.form_records f
		WHERE f.tenant_id = old.tenant_id
		  AND f.status = 'signed'
		  AND (f.installation_id = old.installation_id
		       OR f.appliance_id = old.appliance_id
		       OR f.job_id = old.job_id)
		  AND strpos(f."values", '"' || old.id::text || '"') > 0
	) THEN
		RAISE EXCEPTION 'Diese Datei ist das Foto eines unterschriebenen Protokolls und bleibt, wo sie hängt.'
			USING ERRCODE = 'OG001';
	END IF;

	RETURN new;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "attachments_named_by_signed_protocols"
	BEFORE UPDATE OF "installation_id", "appliance_id", "job_id" ON "attachments"
	FOR EACH ROW EXECUTE FUNCTION "attachment_named_by_signed_protocols"();
