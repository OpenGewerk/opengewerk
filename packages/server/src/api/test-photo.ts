import { type FileStore, newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'

/**
 * A photo among the files of an installation, its bytes in the store and its
 * rows in the tables, as a protocol may name it (#935). Written before the
 * protocol that names it, so that a signed one shows it.
 */
export async function aStoredPhoto(
  admin: Pool,
  store: FileStore,
  tenant: string,
  installation: string,
  label: string,
  sizeBytes?: number,
): Promise<{ readonly id: string; readonly base64: string }> {
  const bytes = Buffer.from(`PNG ${label}`)
  const { sha256 } = await store.put(bytes)
  // A size as the store recorded it, for a bound, the bytes staying small.
  const size = sizeBytes ?? bytes.length
  const id = newId<'attachment'>()

  await admin.query(
    `insert into files (tenant_id, sha256, size_bytes, media_type) values ($1, $2, $3, 'image/png')
     on conflict do nothing`,
    [tenant, sha256, size],
  )
  await admin.query(
    'insert into attachments (id, tenant_id, title, installation_id) values ($1, $2, $3, $4)',
    [id, tenant, label, installation],
  )
  await admin.query(
    `insert into attachment_versions (tenant_id, attachment_id, sha256, file_name, media_type, size_bytes)
     values ($1, $2, $3, $4, 'image/png', $5)`,
    [tenant, id, sha256, `${label}.png`, size],
  )

  return { id, base64: bytes.toString('base64') }
}
