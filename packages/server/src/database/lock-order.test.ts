import { newId } from '@opengewerk/platform-server'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitingFor } from '../api/test-hold.js'
import { connect, resetToMigrated } from './test-database.js'

// Two rows of a tenant are locked by its transactions that write: the counter
// of the sync (`sync_sequences`) and the chain of the log (`audit_chains`).
// Every logged change takes the counter before the chain (opengewerk#914), so
// that two transactions of a tenant wait for each other at most in a line and
// never in a circle; PostgreSQL would break one of them off.

let admin: Pool

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
})

afterAll(async () => {
  await admin.end()
})

/** A tenant of its own for a test. */
async function tenantOfItsOwn(): Promise<string> {
  const tenant = newId<'tenant'>()

  await admin.query("insert into tenants (id, name) values ($1, 'Elektro Ost GmbH')", [tenant])

  return tenant
}

/** A transaction of a tenant, as the application opens one. */
async function begin(tenant: string): Promise<PoolClient> {
  const client = await admin.connect()

  await client.query('begin')
  await client.query("select set_config('app.tenant_id', $1, true)", [tenant])
  await client.query("select set_config('app.user_id', 'lena', true)")

  return client
}

/** Ends both transactions and gives their connections back, whatever happened. */
async function done(first: PoolClient, second: PoolClient, waiting: Promise<unknown>) {
  await first.query('rollback').catch(() => undefined)
  await waiting.catch(() => undefined)
  await second.query('rollback').catch(() => undefined)
  first.release()
  second.release()
}

/** A logged change of a row that does not travel: a line of the deletion concept. */
const protocolLine = (client: PoolClient, tenant: string) =>
  client.query(
    `insert into erasures (tenant_id, kind, record_id, label, automatic, redactions, created_by)
     values ($1, 'sickness', $2, 'Krankheit, letzter Tag 14.10.2025', false, 0, 'lena')`,
    [tenant, newId<'absence'>()],
  )

/** A logged change of a row that travels: a customer. */
const customer = (client: PoolClient, tenant: string) =>
  client.query(
    "insert into customers (tenant_id, kind, name) values ($1, 'private', 'Ingrid Vossberg')",
    [tenant],
  )

describe('the locks of a tenant that writes', () => {
  it('are taken counter first by every logged change, also by one of a row that does not travel', async () => {
    const tenant = await tenantOfItsOwn()
    const erasing = await begin(tenant)
    const writing = await begin(tenant)
    let written: Promise<unknown> = Promise.resolve()

    try {
      // A deletion writes its protocol first, a row that does not travel.
      await protocolLine(erasing, tenant)

      // A change of a customer meanwhile, which has to wait for the deletion.
      written = customer(writing, tenant)
      await waitingFor(admin, erasing, written)

      // The deletion goes on to a row that travels: it must not wait for the
      // change, or the two would wait for each other.
      await customer(erasing, tenant)
      await erasing.query('commit')
      await written
      await writing.query('commit')
    } finally {
      await done(erasing, writing, written)
    }

    expect(
      (await admin.query('select count(*)::int as n from customers where tenant_id = $1', [tenant]))
        .rows,
    ).toEqual([{ n: 2 }])
  })

  it.each([
    ['file_naming_lock', 'select public.file_naming_lock($1)'],
    ['file_named_by_a_value', "select public.file_named_by_a_value($1, repeat('f', 64))"],
  ])('are taken counter first by %s as well', async (_name, statement) => {
    const tenant = await tenantOfItsOwn()
    const writing = await begin(tenant)
    const locking = await begin(tenant)
    let locked: Promise<unknown> = Promise.resolve()

    try {
      // A change of a row that travels, stamped: it holds the counter.
      await writing.query('select public.next_sync_sequence($1)', [tenant])

      locked = locking.query(statement, [tenant])
      await waitingFor(admin, writing, locked)

      // The change is logged and takes the chain, which the lock must not
      // hold while it waits for the counter.
      await protocolLine(writing, tenant)
      await writing.query('commit')
      await locked
      await locking.query('commit')
    } finally {
      await done(writing, locking, locked)
    }
  })

  it('are taken counter first by a redaction, before it locks its entry', async () => {
    const tenant = await tenantOfItsOwn()

    // Lena leads the tenant and may black out values; a customer renamed
    // once leaves an entry with a value of before and of after.
    await admin.query(
      `insert into auth_users (id, name, email) values ('lena', 'Lena', 'lena@example.org')
         on conflict (id) do nothing;
       insert into tenant_roles (tenant_id, key, label, rights, leads, second_factor)
         values ('${tenant}', 'owner', 'Inhaber', '{}', true, false);
       insert into memberships (tenant_id, user_id, roles) values ('${tenant}', 'lena', '{owner}');`,
    )

    const setup = await begin(tenant)

    await customer(setup, tenant)
    await setup.query("update customers set name = 'Ingrid Vossberg-Kraft' where tenant_id = $1", [
      tenant,
    ])
    await setup.query('commit')
    setup.release()

    const { rows } = await admin.query<{ id: string }>(
      `select id from audit_entries where tenant_id = $1 and table_name = 'customers'
          and operation = 'update' and old_value is not null and new_value is not null limit 1`,
      [tenant],
    )
    const entry = rows[0]?.id
    const redaction = (client: PoolClient, side: 'old' | 'new') =>
      client.query(
        `insert into audit_redactions (tenant_id, entry_id, side, reason, redacted_by)
         values ($1, $2, $3, 'Auf Löschanfrage', 'lena')`,
        [tenant, entry, side],
      )
    const erasing = await begin(tenant)
    const redacting = await begin(tenant)
    let redacted: Promise<unknown> = Promise.resolve()

    try {
      // A deletion that has written its protocol and goes on to black out
      // the entries of what it deletes.
      await protocolLine(erasing, tenant)

      // A redaction of the same entry by hand, meanwhile.
      redacted = redaction(redacting, 'new')
      await waitingFor(admin, erasing, redacted)

      // The deletion blacks out the other value of the entry: it must not
      // wait for a redaction that waits for it.
      await redaction(erasing, 'old')
      await erasing.query('commit')
      await redacted
      await redacting.query('commit')
    } finally {
      await done(erasing, redacting, redacted)
    }

    expect(
      (await admin.query('select old_value, new_value from audit_entries where id = $1', [entry]))
        .rows,
    ).toEqual([{ old_value: null, new_value: null }])
  })

  it.each([
    ['a logged change', (client: PoolClient, tenant: string) => protocolLine(client, tenant)],
    [
      'file_naming_lock',
      (client: PoolClient, tenant: string) =>
        client.query('select public.file_naming_lock($1)', [tenant]),
    ],
    [
      'file_named_by_a_value',
      (client: PoolClient, tenant: string) =>
        client.query("select public.file_named_by_a_value($1, repeat('f', 64))", [tenant]),
    ],
  ])('leave the first number of the sync at 1 when %s makes the counter', async (_name, lock) => {
    const tenant = await tenantOfItsOwn()

    // The tenant itself was logged when it came, which made its counter.
    await admin.query('delete from sync_sequences where tenant_id = $1', [tenant])

    const client = await begin(tenant)

    try {
      await lock(client, tenant)
      expect(
        (
          await client.query<{ next_value: string }>(
            'select next_value from sync_sequences where tenant_id = $1',
            [tenant],
          )
        ).rows,
      ).toEqual([{ next_value: '0' }])

      await customer(client, tenant)
      expect(
        (
          await client.query<{ change_sequence: string }>(
            'select change_sequence from customers where tenant_id = $1',
            [tenant],
          )
        ).rows,
      ).toEqual([{ change_sequence: '1' }])
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })
})
