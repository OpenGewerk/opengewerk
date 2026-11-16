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

  it('write the last entry as the head at the commit, whatever the hint says by then', async () => {
    for (const hint of ['opened', 'an earlier entry']) {
      const before = await chainOf(north.id)

      await inTenant(north.id, async (tx) => {
        await shelves(tx, north.id, 3, hint)

        if (hint === 'opened') {
          await setHint(tx, 'audit_head', north.id, 'opened')
        } else {
          const { rows } = await tx.execute<{ id: string }>(sql`
            select id from audit_entries
             where tenant_id = ${north.id}::uuid
               and sequence = ${Number(before?.next_sequence ?? 1)}`)

          await setHint(tx, 'audit_head', north.id, String(rows[0]?.id))
        }
      })

      await expectHeadAtTheLastEntry(north.id)
    }

    // And the next change finds its place free.
    await inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Danach'))

    await expectHeadAtTheLastEntry(north.id)
  })

  it('go by the key when a hint names an address no row can have', async () => {
    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 1)
      await setHint(tx, 'sync', north.id, '(1,99999)')
      await setHint(tx, 'audit', north.id, '(9999999999,1)')
      await shelves(tx, north.id, 2, 'Danach')
    })

    await expectHeadAtTheLastEntry(north.id)
    expect((await counterOf(north.id))?.next_value).toBe('3')
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

/**
 * The numbers of the sync come from a sequence of the tenant (opengewerk#965).
 * The row of the counter is opened by the first number of a transaction and
 * written once, before the commit; the sequence is set to the last number
 * committed at every opening, and is the owner's alone.
 */
describe('the numbers of the sync', () => {
  const sequenceOf = (tenantId: TenantId) => `sync_counters.t${tenantId.replaceAll('-', '')}`

  async function numbersOf(tenantId: TenantId, label?: string) {
    const { rows } = await admin.query<{ change_sequence: string }>(
      `select change_sequence from shelves
        where tenant_id = $1 and ($2::text is null or label like $2 || '%')
        order by change_sequence`,
      [tenantId, label ?? null],
    )

    return rows.map((row) => Number(row.change_sequence))
  }

  async function openedOf(tenantId: TenantId) {
    const { rows } = await admin.query<{ next_value: string; opened_in: string | null }>(
      'select next_value, opened_in from sync_sequences where tenant_id = $1',
      [tenantId],
    )

    return rows[0]
  }

  it('move the row of the counter once for all the numbers of a transaction', async () => {
    const moved = await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 300)

      const { rows } = await tx.execute<{ moved: string }>(sql`
        select n_tup_upd as moved
          from pg_stat_xact_user_tables where relname = 'sync_sequences'`)

      return Number(rows[0]?.moved)
    })

    // The opening; the closing comes at the commit.
    expect(moved).toBe(1)
    expect(await numbersOf(north.id)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1))
    expect(await openedOf(north.id)).toEqual({ next_value: '300', opened_in: null })
  })

  it('go on from the last number committed, whatever a transaction that rolled back took', async () => {
    await inTenant(north.id, (tx) => shelves(tx, north.id, 3, 'Vorher'))

    await expect(
      inTenant(north.id, async (tx) => {
        await shelves(tx, north.id, 2, 'Zurück')
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')

    await inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Danach'))

    expect(await numbersOf(north.id)).toEqual([1, 2, 3, 4])
    expect(await openedOf(north.id)).toEqual({ next_value: '4', opened_in: null })
  })

  it('hand out no number twice when the sequence of the tenant is behind or gone', async () => {
    await inTenant(north.id, (tx) => shelves(tx, north.id, 3, 'Vorher'))

    // Behind, as after a restore that took the rows from a later state.
    await admin.query('select setval($1::regclass, 1)', [sequenceOf(north.id)])
    await inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Hinterher'))

    // Gone altogether.
    await admin.query(`drop sequence ${sequenceOf(north.id)}`)
    await inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Neu'))

    expect(await numbersOf(north.id)).toEqual([1, 2, 3, 4, 5])
    expect(await openedOf(north.id)).toEqual({ next_value: '5', opened_in: null })
  })

  it('open the counter again after its number was written early', async () => {
    await inTenant(north.id, async (tx) => {
      await shelves(tx, north.id, 3)
      await tx.execute(sql`set constraints all immediate`)
      await shelves(tx, north.id, 3, 'Danach')
    })

    expect(await numbersOf(north.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await openedOf(north.id)).toEqual({ next_value: '6', opened_in: null })
  })

  it('take back an opening with its savepoint, and nothing of a number before it', async () => {
    await inTenant(north.id, async (tx) => {
      // The opening itself under a savepoint that is rolled back.
      await tx.execute(sql`savepoint first`)
      await shelves(tx, north.id, 2, 'Zurück')
      await tx.execute(sql`rollback to savepoint first`)
      await shelves(tx, north.id, 2, 'Erste')

      // Numbers under a savepoint after the opening.
      await tx.execute(sql`savepoint later`)
      await shelves(tx, north.id, 2, 'Zurück')
      await tx.execute(sql`rollback to savepoint later`)
      await shelves(tx, north.id, 1, 'Zweite')
    })

    expect(await numbersOf(north.id, 'Erste')).toEqual([1, 2])

    const [last] = await numbersOf(north.id, 'Zweite')

    // Above the numbers under the second savepoint, which are not used again.
    expect(last).toBe(5)
    expect(await openedOf(north.id)).toEqual({ next_value: '5', opened_in: null })
  })

  it.each([
    ['a number', (tx: TenantTransaction) => shelves(tx, north.id, 1, 'Erste')],
    // The lock alone, as whoever names a file takes it (opengewerk#911): the
    // row is locked and not changed, and nothing but the lock holds the
    // second back.
    [
      'the lock alone',
      (tx: TenantTransaction) => tx.execute(sql`select file_naming_lock(${north.id}::uuid)`),
    ],
  ])(
    'number two transactions of a tenant in the order they commit, the first holding %s',
    async (_start, start) => {
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let opened = () => {}
      const isOpen = new Promise<void>((resolve) => {
        opened = resolve
      })

      // A counter that is there and committed, so that it is the lock on its
      // row that holds the second back, and not the row the first is making.
      await inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Vorher'))

      const first = inTenant(north.id, async (tx) => {
        await start(tx)
        opened()
        await held
        await shelves(tx, north.id, 2, 'Erste')
      })

      await isOpen

      const second = inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Zweite'))

      try {
        // The second waits for the counter the first has open.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await numbersOf(north.id)).toEqual([1])
      } finally {
        // Let the first go in any case, so that a failing check leaves no
        // transaction holding the counter behind it.
        release()
        await Promise.allSettled([first, second])
      }
      await Promise.all([first, second])

      const firsts = await numbersOf(north.id, 'Erste')

      // Every number of the first below the one of the second, none twice.
      expect(firsts).toEqual(Array.from({ length: firsts.length }, (_, i) => i + 2))
      expect(await numbersOf(north.id, 'Zweite')).toEqual([firsts.length + 2])
    },
  )

  it('leave the sequence of a tenant and its opening to the owner of the tables', async () => {
    await inTenant(north.id, (tx) => shelves(tx, north.id, 1))

    for (const statement of [
      sql`select nextval(${sequenceOf(north.id)}::regclass)`,
      sql`select setval(${sequenceOf(north.id)}::regclass, 1)`,
      sql`select take_sync_numbers(${north.id}::uuid, 1)`,
      sql`create sequence sync_counters.t00000000000000000000000000000000`,
    ]) {
      await expect(inTenant(north.id, (tx) => tx.execute(statement))).rejects.toMatchObject({
        cause: { code: '42501' },
      })
    }

    await inTenant(north.id, (tx) => shelves(tx, north.id, 1, 'Danach'))

    expect(await numbersOf(north.id)).toEqual([1, 2])
  })
})
