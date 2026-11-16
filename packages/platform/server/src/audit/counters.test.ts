import type { TenantId } from '@opengewerk/platform-domain'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { type ProbeFoundation, probeFoundation } from '../authentication/probe-application.js'
import { Database, type TenantTransaction } from '../database/database.js'
import { newId } from '../database/identifier.js'
import { probeSyncMade } from '../sync/probe-sync.js'

/**
 * The counter of the sync and the chain of the log when one transaction
 * changes a great deal (opengewerk#953). Every logged change moved both rows
 * and found them again through their keys, past every version the transaction
 * had written; the thousandth change walked a thousand versions. Now the
 * counter is moved through the address the transaction holds, and the chain
 * is written once, before the commit, with the head the transaction finds
 * among its own entries. Shelves of the probe application are logged and
 * travel, so that each one moves both.
 */

const north = { id: newId<'tenant'>(), name: 'Mandant Nord' }
const south = { id: newId<'tenant'>(), name: 'Mandant Süd' }

let foundation: ProbeFoundation
let admin: Pool
let database: Database

function inTenant<Result>(
  tenantId: TenantId,
  work: (tx: TenantTransaction) => Promise<Result>,
): Promise<Result> {
  return database.forTenant({ tenantId, reason: 'probe.write' }, work)
}

const shelves = (tx: TenantTransaction, tenantId: TenantId, count: number, label = 'Regal') =>
  tx.execute(sql`
    insert into shelves (tenant_id, label)
    select ${tenantId}::uuid, ${label} || ' ' || g from generate_series(1, ${count}) g`)

/** The name of the setting a transaction keeps a hint of the given kind in. */
const hintOf = (kind: string, tenantId: TenantId) =>
  `opengewerk_${kind}.t${tenantId.replaceAll('-', '')}`

const setHint = (tx: TenantTransaction, kind: string, tenantId: TenantId, hint: string) =>
  tx.execute(sql`select set_config(${hintOf(kind, tenantId)}, ${hint}, true)`)

async function chainOf(tenantId: TenantId) {
  const { rows } = await admin.query<{
    next_sequence: string
    head_hash: string | null
    opened_in: string | null
  }>('select next_sequence, head_hash, opened_in from audit_chains where tenant_id = $1', [
    tenantId,
  ])

  return rows[0]
}

async function lastEntryOf(tenantId: TenantId) {
  const { rows } = await admin.query<{ id: string; sequence: string; hash: string }>(
    'select id, sequence, hash from audit_entries where tenant_id = $1 order by sequence desc limit 1',
    [tenantId],
  )

  return rows[0]
}

async function brokenAt(tenantId: TenantId) {
  const { rows } = await admin.query<{ broken_at: string | null }>(
    'select broken_at from verify_audit_chain($1)',
    [tenantId],
  )

  return rows[0]?.broken_at ?? null
}

/** The chain is sound, and its row names the last entry as its head. */
async function expectHeadAtTheLastEntry(tenantId: TenantId) {
  const [chain, last] = await Promise.all([chainOf(tenantId), lastEntryOf(tenantId)])

  expect(await brokenAt(tenantId)).toBeNull()
  expect(chain).toEqual({
    next_sequence: String(Number(last?.sequence) + 1),
    head_hash: last?.hash,
    opened_in: null,
  })
}

async function counterOf(tenantId: TenantId) {
  const { rows } = await admin.query<{ next_value: string; address: string }>(
    'select next_value, ctid::text as address from sync_sequences where tenant_id = $1',
    [tenantId],
  )

  return rows[0]
}

beforeAll(async () => {
  foundation = await probeFoundation(probeSyncMade)
  admin = await foundation.kit.connect()
  database = Database.connect(foundation.kit.applicationDatabaseUrl())
}, 60_000)

beforeEach(async () => {
  await foundation.empty()
  await foundation.tenants(admin, [north, south])
})

afterAll(async () => {
  await database.close()
  await admin.end()
  foundation.remove()
})

describe('many logged changes in one transaction', () => {
  it('write the head of the chain once, before the commit', async () => {
    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 300)
      await tx.execute(
        sql`update shelves set label = label || ' neu' where tenant_id = ${north.id}::uuid`,
      )
    })

    await expectHeadAtTheLastEntry(north.id)

    // The next transaction goes on from there.
    await inTenant(north.id, (tx) => shelves(tx, north.id, 2, 'Danach'))

    await expectHeadAtTheLastEntry(north.id)
  })

  it('keep the head where it is when a savepoint is rolled back', async () => {
    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 5)
      await tx.execute(sql`savepoint later`)
      await tx.execute(sql`update shelves set label = 'Zurück' where tenant_id = ${north.id}::uuid`)
      await tx.execute(sql`rollback to savepoint later`)
      await shelves(tx, north.id, 3, 'Danach')
    })

    await expectHeadAtTheLastEntry(north.id)

    const { rows } = await admin.query<{ label: string }>(
      'select distinct new_value as label from audit_entries where tenant_id = $1 and field = $2',
      [north.id, 'label'],
    )

    expect(rows.map((row) => row.label)).not.toContain('Zurück')
  })

  it('open the chain again after its head was written early', async () => {
    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 3)
      await tx.execute(sql`set constraints all immediate`)
      await shelves(tx, north.id, 3, 'Danach')
    })

    await expectHeadAtTheLastEntry(north.id)
  })

  it('take no hint that names the rows or entries of another tenant', async () => {
    await inTenant(south.id, (tx) => shelves(tx, south.id, 4, 'Süd'))

    const southCounter = await counterOf(south.id)
    const southChain = await chainOf(south.id)
    const southEntry = await lastEntryOf(south.id)
    const { rows: chainAddress } = await admin.query<{ address: string }>(
      'select ctid::text as address from audit_chains where tenant_id = $1',
      [south.id],
    )

    const misleading = async (tx: TenantTransaction) => {
      await setHint(tx, 'sync', north.id, String(southCounter?.address))
      await setHint(tx, 'audit', north.id, String(chainAddress[0]?.address))
      await setHint(tx, 'audit_head', north.id, String(southEntry?.id))
    }

    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 1)

      // The lock alone, as whoever names a file takes it (opengewerk#911),
      // and then the counter and the chain of a change.
      await misleading(tx)
      await tx.execute(sql`select file_naming_lock(${north.id}::uuid)`)
      await misleading(tx)
      await shelves(tx, north.id, 2, 'Danach')

      // Nor does it hold them: South writes on while North is still open.
      for (const table of ['sync_sequences', 'audit_chains']) {
        await expect(
          admin.query(`select 1 from ${table} where tenant_id = $1 for update nowait`, [south.id]),
        ).resolves.toBeDefined()
      }
    })

    expect((await counterOf(south.id))?.next_value).toBe(southCounter?.next_value)
    expect(await chainOf(south.id)).toEqual(southChain)
    await expectHeadAtTheLastEntry(north.id)
    await expectHeadAtTheLastEntry(south.id)

    // North numbered its three shelves itself, one after the other.
    const { rows: numbers } = await admin.query<{ change_sequence: string }>(
      'select change_sequence from shelves where tenant_id = $1 order by change_sequence',
      [north.id],
    )

    expect(numbers.map((row) => Number(row.change_sequence))).toEqual([1, 2, 3])
  })

  it('answer a hint below the head of the chain with the head itself', async () => {
    await inTenant(north.id, (tx) => shelves(tx, north.id, 3))

    const { rows: early } = await admin.query<{ id: string }>(
      'select id from audit_entries where tenant_id = $1 order by sequence limit 1',
      [north.id],
    )

    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 1, 'Danach')
      await setHint(tx, 'audit_head', north.id, String(early[0]?.id))
      await shelves(tx, north.id, 1, 'Zuletzt')
    })

    await expectHeadAtTheLastEntry(north.id)
  })

  it('stop at a hint that names an earlier entry of the same transaction, and fork nothing', async () => {
    await inTenant(north.id, (tx) => shelves(tx, north.id, 1))

    const before = await chainOf(north.id)

    await expect(
      inTenant(north.id, async (tx) => {
        await shelves(tx, north.id, 2, 'Danach')

        // The first entry this transaction wrote: not its last, so that the
        // place after it is taken.
        const { rows } = await tx.execute<{ id: string }>(sql`
          select id from audit_entries
           where tenant_id = ${north.id}::uuid and sequence = ${Number(before?.next_sequence)}`)

        await setHint(tx, 'audit_head', north.id, String(rows[0]?.id))
        await shelves(tx, north.id, 1, 'Zuletzt')
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } })

    expect(await chainOf(north.id)).toEqual(before)
    await expectHeadAtTheLastEntry(north.id)
  })

  it('take about as long each for the last of 20 000 as for the first', async () => {
    const chunks: number[] = []

    await inTenant(north.id, async (tx) => {
      for (let chunk = 0; chunk < 10; chunk += 1) {
        const started = performance.now()

        await shelves(tx, north.id, 2000, `Teil ${String(chunk)}`)
        chunks.push(performance.now() - started)
      }
    })

    // The first part runs while plans are made; the second is the measure.
    // A walk past every version written before makes each part longer than
    // the one before it.
    const [, second] = chunks
    const last = chunks.at(-1)

    expect(Number(last) / Number(second)).toBeLessThan(2)
    await expectHeadAtTheLastEntry(north.id)
  }, 180_000)

  it('hand out the last of 20 000 numbers of the sync about as quickly as the first', async () => {
    // The counter alone, without the log, whose entries take most of the time
    // of a change and would hide a walk here.
    const before = Number((await counterOf(north.id))?.next_value ?? 0)
    const chunks: number[] = []

    await inTenant(north.id, async (tx) => {
      for (let chunk = 0; chunk < 10; chunk += 1) {
        const started = performance.now()

        await tx.execute(
          sql`select count(next_sync_sequence(${north.id}::uuid)) from generate_series(1, 2000)`,
        )
        chunks.push(performance.now() - started)
      }
    })

    const [, second] = chunks
    const last = chunks.at(-1)

    expect(Number(last) / Number(second)).toBeLessThan(2)
    expect(Number((await counterOf(north.id))?.next_value)).toBe(before + 20_000)
  }, 180_000)
})
