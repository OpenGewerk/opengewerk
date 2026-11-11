import { createHash } from 'node:crypto'

import { newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitingFor } from '../api/test-hold.js'
import { connect, resetToMigrated } from './test-database.js'

// A file of the store goes for good once no key names it and no value does
// (opengewerk#911). The keys onto `files` hold their files by themselves; a
// value holds its file only if `application_file_named_by_a_value` asks it.
// So every column of type jsonb is placed here: how a row names a file in it,
// written as a row that does, or null where it names no file. A new column of
// the type stops this test until somebody has placed it, and the function has
// to find the file in every column that names one.

/** Writes a row of a tenant that names a file by its hash in the column. */
type NamingRow = (tenant: string, hash: string) => Promise<void>

const jsonbColumns: Readonly<Record<string, NamingRow | null>> = {
  // The files a price list import read, by their hash.
  'article_imports.files': async (tenant, hash) => {
    const { rows } = await admin.query<{ id: string }>(
      "insert into suppliers (tenant_id, name) values ($1, 'Hansa Elektro') returning id",
      [tenant],
    )

    await admin.query(
      `insert into article_imports (tenant_id, supplier_id, files, valid_from)
       values ($1, $2, $3, '2026-10-01')`,
      [tenant, rows[0]?.id, JSON.stringify([{ name: 'preise.001', sha256: hash, bytes: 3 }])],
    )
  },
  'article_imports.summary': null,
  // The logo of the letterhead a document was written with.
  'document_snapshots.content': async (tenant, hash) => {
    const { rows: customers } = await admin.query<{ id: string }>(
      "insert into customers (tenant_id, kind, name) values ($1, 'business', 'Logo GmbH') returning id",
      [tenant],
    )
    const { rows: documents } = await admin.query<{ id: string }>(
      `insert into documents (tenant_id, customer_id, kind, document_date)
       values ($1, $2, 'quote', '2026-10-01') returning id`,
      [tenant, customers[0]?.id],
    )

    await admin.query(
      'insert into document_snapshots (tenant_id, document_id, content) values ($1, $2, $3)',
      [
        tenant,
        documents[0]?.id,
        JSON.stringify({
          issuer: { logo: { fileId: newId(), sha256: hash, mediaType: 'image/png' } },
        }),
      ],
    )
  },
  'early_start_requests.wording': null,
  'funding_programs.evidence': null,
  'instance_settings.measures': null,
  'instance_settings.subprocessors': null,
  // The protocols of a handover, by their ids.
  'pv_handovers.content': null,
  // What a device wanted and the server found for a record that changed in
  // two places; a version of the archive never changes, so none is here.
  'sync_conflicts.found': null,
  'sync_conflicts.seen': null,
  'sync_conflicts.wanted': null,
}

let admin: Pool

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
})

afterAll(async () => {
  await admin.end()
})

describe('the values that name a file', () => {
  it('are placed for every column of type jsonb', async () => {
    const { rows } = await admin.query<{ name: string }>(
      `select table_name || '.' || column_name as name from information_schema.columns
        where table_schema = 'public' and data_type = 'jsonb' order by 1`,
    )

    expect(rows.map((row) => row.name)).toEqual(Object.keys(jsonbColumns).sort())
  })

  it('are each found by the application before a file goes for good', async () => {
    const tenant = newId<'tenant'>()
    const named = async (hash: string) =>
      (
        await admin.query<{ named: boolean }>(
          'select public.application_file_named_by_a_value($1, $2) as named',
          [tenant, hash],
        )
      ).rows[0]?.named

    await admin.query("insert into tenants (id, name) values ($1, 'Elektro West GmbH')", [tenant])

    for (const [column, write] of Object.entries(jsonbColumns)) {
      if (write !== null) {
        const hash = createHash('sha256').update(column).digest('hex')

        await write(tenant, hash)
        expect([column, await named(hash)]).toEqual([column, true])
      }
    }

    expect(await named('0'.repeat(64))).toBe(false)
  })

  it('are asked only once a transaction about to name the file is done, and then seen', async () => {
    const tenant = newId<'tenant'>()
    const hash = 'e'.repeat(64)

    await admin.query("insert into tenants (id, name) values ($1, 'Elektro Nord GmbH')", [tenant])

    const { rows: suppliers } = await admin.query<{ id: string }>(
      "insert into suppliers (tenant_id, name) values ($1, 'Hansa Elektro') returning id",
      [tenant],
    )
    const naming = await admin.connect()
    const taking = await admin.connect()

    try {
      // An import, about to name the file and not done yet.
      await naming.query('begin')
      await naming.query("select set_config('app.tenant_id', $1, true)", [tenant])
      await naming.query('select public.file_naming_lock($1)', [tenant])
      await naming.query(
        `insert into article_imports (tenant_id, supplier_id, files, valid_from)
         values ($1, $2, $3, '2026-10-01')`,
        [
          tenant,
          suppliers[0]?.id,
          JSON.stringify([{ name: 'preise.001', sha256: hash, bytes: 3 }]),
        ],
      )

      // A deletion asks whether a value names the file: only after the import.
      await taking.query('begin')

      const asking = taking.query<{ named: boolean }>(
        'select public.file_named_by_a_value($1, $2) as named',
        [tenant, hash],
      )

      await waitingFor(admin, naming, asking)
      await naming.query('commit')

      expect((await asking).rows).toEqual([{ named: true }])
    } finally {
      // The import first: a question still waiting for it ends with it.
      await naming.query('rollback').catch(() => undefined)
      await taking.query('rollback').catch(() => undefined)
      naming.release()
      taking.release()
    }
  })

  it('add no lock to a deletion that asks, so that nothing waits in a circle', async () => {
    const tenant = newId<'tenant'>()

    await admin.query("insert into tenants (id, name) values ($1, 'Elektro Süd GmbH')", [tenant])

    const deleting = await admin.connect()
    const writing = await admin.connect()
    let written: Promise<unknown> = Promise.resolve()

    try {
      // A deletion that has written its protocol: it holds the chain.
      await deleting.query('begin')
      await deleting.query("select set_config('app.tenant_id', $1, true)", [tenant])
      await deleting.query(
        `insert into audit_chains (tenant_id) values ($1)
         on conflict (tenant_id) do update set updated_at = now()`,
        [tenant],
      )

      // A change of a row that travels: the counter, then the chain, which
      // it waits for.
      await writing.query('begin')
      await writing.query("select set_config('app.tenant_id', $1, true)", [tenant])
      written = writing
        .query('select public.next_sync_sequence($1)', [tenant])
        .then(() => writing.query('select public.file_naming_lock($1)', [tenant]))

      await waitingFor(admin, deleting, written)

      // The deletion asks whether a value names a file: nothing it waits for.
      await deleting.query('select public.file_named_by_a_value($1, $2)', [tenant, 'f'.repeat(64)])
      await deleting.query('commit')
      await written
      await writing.query('commit')
    } finally {
      await deleting.query('rollback').catch(() => undefined)
      await written.catch(() => undefined)
      await writing.query('rollback').catch(() => undefined)
      deleting.release()
      writing.release()
    }
  })

  it('are locked only for the tenant of the transaction', async () => {
    const tenant = newId<'tenant'>()
    const other = newId<'tenant'>()
    const client = await admin.connect()

    try {
      await client.query('begin')
      await client.query("select set_config('app.tenant_id', $1, true)", [tenant])
      await expect(client.query('select public.file_naming_lock($1)', [other])).rejects.toThrow(
        'Gesperrt wird nur für den Mandanten der Transaktion.',
      )
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
