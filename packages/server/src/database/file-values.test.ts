import { newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitingForALock } from '../api/test-hold.js'
import { connect, resetToMigrated } from './test-database.js'

// A file of the store goes for good once no key names it and no value does
// (opengewerk#911). The keys onto `files` hold their files by themselves; a
// value holds its file only if `application_file_named_by_a_value` asks it.
// So every column of type jsonb is placed here: what a value in it names, or
// null where it names no file. A new column of the type stops this test until
// somebody has placed it, and one that names files adds its table to the
// function in a migration.

const jsonbColumns: Readonly<Record<string, string | null>> = {
  'article_imports.files': 'the files a price list import read, by their hash',
  'article_imports.summary': null,
  'document_snapshots.content':
    'the logo of the letterhead it was written with, issuer.logo.sha256',
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

  it('are each asked by the application before a file goes for good', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `select pg_get_functiondef('public.application_file_named_by_a_value(uuid,text)'::regprocedure) as definition`,
    )
    const definition = rows[0]?.definition ?? ''

    for (const [column, names] of Object.entries(jsonbColumns)) {
      if (names !== null) {
        expect([column, definition.includes(`public.${column.split('.')[0] ?? ''}`)]).toEqual([
          column,
          true,
        ])
      }
    }
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

      await waitingForALock(admin, asking)
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

  it('are locked in the order a change of a row that travels takes the locks, so that nothing waits in a circle', async () => {
    const tenant = newId<'tenant'>()

    await admin.query("insert into tenants (id, name) values ($1, 'Elektro Süd GmbH')", [tenant])

    const writing = await admin.connect()
    const naming = await admin.connect()
    let named: Promise<unknown> = Promise.resolve()

    try {
      // A change of a row that travels: stamped first, which locks the counter.
      await writing.query('begin')
      await writing.query("select set_config('app.tenant_id', $1, true)", [tenant])
      await writing.query('select public.next_sync_sequence($1)', [tenant])

      // About to name a file, and to write a row that travels after.
      await naming.query('begin')
      await naming.query("select set_config('app.tenant_id', $1, true)", [tenant])

      named = naming
        .query('select public.file_naming_lock($1)', [tenant])
        .then(() => naming.query('select public.next_sync_sequence($1)', [tenant]))

      await waitingForALock(admin, named)

      // The change is logged: the chain, which the lock must not hold yet.
      await writing.query(
        `insert into audit_chains (tenant_id) values ($1)
         on conflict (tenant_id) do update set updated_at = now()`,
        [tenant],
      )
      await writing.query('commit')
      await named
      await naming.query('commit')
    } finally {
      // The change first: the lock still waiting for it ends with it.
      await writing.query('rollback').catch(() => undefined)
      await named.catch(() => undefined)
      await naming.query('rollback').catch(() => undefined)
      writing.release()
      naming.release()
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
