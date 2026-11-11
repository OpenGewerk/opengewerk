-- Whether the content of a written document names a file as its logo is asked
-- for every file a deletion takes (`application_file_named_by_a_value`, 0140,
-- opengewerk#911), while the chain of the log of the tenant is locked and with
-- it every logged change of the tenant. Without an index, each question read
-- every document of the tenant: some 245 ms at 60,000 documents, 0.7 ms with
-- it. The index carries the expression the question asks.
CREATE INDEX "document_snapshots_logo" ON "document_snapshots" USING btree ("tenant_id",("content" #>> '{issuer,logo,sha256}'));
