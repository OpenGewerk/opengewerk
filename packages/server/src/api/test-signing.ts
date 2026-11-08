import { lineUnits, signedContentFingerprint } from '@opengewerk/domain'
import type { Pool } from 'pg'

/**
 * The fingerprint a device works out for a document as it holds it, read
 * here through the pool of a test, which sees every row. For a test whose
 * signature has to land and that is not about the fingerprint itself; the
 * tests of the fingerprint name what goes into it on their own.
 */
export async function fingerprintAsHeld(pool: Pool, documentId: string): Promise<string> {
  const { rows: documents } = await pool.query<{
    subject: string | null
    document_date: string
    customer_id: string
    job_id: string | null
    intro_text: string | null
    field_values: string | null
    fields_version: number | null
  }>(
    `select subject, to_char(document_date, 'YYYY-MM-DD') as document_date, customer_id,
            job_id, intro_text, field_values::text as field_values, fields_version
       from documents where id = $1`,
    [documentId],
  )
  const document = documents[0]

  if (!document) {
    throw new Error(`No document ${documentId} to sign`)
  }

  const { rows: lines } = await pool.query<{
    id: string
    position: number
    kind: 'item' | 'title'
    designation: string
    description: string | null
    quantity_milli: string
    unit: string
  }>(
    `select id, position, kind, designation, description, quantity_milli, unit
       from document_lines where document_id = $1 and deleted_at is null`,
    [documentId],
  )

  return signedContentFingerprint({
    subject: document.subject,
    documentDate: document.document_date,
    customerId: document.customer_id,
    jobId: document.job_id,
    introText: document.intro_text,
    fields: document.field_values,
    fieldsVersion: document.fields_version,
    lines: lines.map((line) => ({
      id: line.id,
      position: line.position,
      kind: line.kind,
      designation: line.designation,
      description: line.description,
      quantityMilli: Number(line.quantity_milli),
      unit: lineUnits.find((unit) => unit === line.unit) ?? 'piece',
    })),
  })
}
