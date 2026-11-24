import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { addDays, berlinClock, type EmergencyTariff, type TenantId } from '@opengewerk/domain'
import { Database, FileStore, newId, type Renderer } from '@opengewerk/platform-server'
import type { Pool, PoolClient } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import { refreshSurchargeLine } from '../service-calls/on-call.js'
import { ApiModule } from './api.module.js'
import { holdQuery, waitingFor } from './test-hold.js'
import { fingerprintAsHeld } from './test-signing.js'
import { as, testIdentities as identities } from './test-identity.js'
import { invoiceable, readyToInvoice } from './test-invoice.js'
import { changed, created, deleted, push } from './test-structure.js'

/**
 * The on-call service (#293): the on-call plan kept in the office, the service
 * call made on call with the narrow right and only in a time of the plan, and
 * the surcharge the invoice out of the report of an emergency call carries.
 */

const north = { id: newId<'tenant'>() as TenantId, name: 'Elektro Nord GmbH' }

let admin: Pool
let database: Database
let app: INestApplication
let storageRoot = ''

const standIn: Renderer = () => Promise.resolve(new TextEncoder().encode('%PDF-1.7'))
const office = () => as(north.id, 'office')
const owner = () => as(north.id, 'owner')
const jonas = () => JSON.stringify({ userId: 'jonas', tenantId: north.id, roles: ['technician'] })
const lena = () => JSON.stringify({ userId: 'lena', tenantId: north.id, roles: ['technician'] })
/** On call only in the times relative to now that the calls below are made in. */
const max = () => JSON.stringify({ userId: 'max', tenantId: north.id, roles: ['technician'] })
const scribble = 'M100,300L200,120L300,280'

/** Wednesday 28.10.2026, 02:14 in Germany. */
const atNight = '2026-10-28T01:14:00.000Z'
/** The same Wednesday at 10:00. */
const inTheDay = '2026-10-28T09:00:00.000Z'

function http() {
  return request(app.getHttpServer())
}

async function post(path: string, body: Record<string, unknown>, who = office(), status = 201) {
  const answer = await http().post(path).set('x-test-identity', who).send(body).expect(status)

  return answer.body as { id: string; message?: string }
}

/** A transaction of the business as the application opens one, given back if it fails to open. */
async function begun(): Promise<PoolClient> {
  const client = await admin.connect()

  try {
    await client.query('begin')
    await client.query("select set_config('app.tenant_id', $1, true)", [north.id])
    await client.query("select set_config('app.user_id', 'lena', true)")

    return client
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    client.release()
    throw error
  }
}

/**
 * A transaction of the business that has locked a draft the way issuing
 * does, before it writes anything the log records.
 */
async function lockedForIssuing(invoice: string): Promise<PoolClient> {
  const client = await begun()

  try {
    await client.query('select id from documents where id = $1 for update', [invoice])

    return client
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    client.release()
    throw error
  }
}

/** A change written past the routes, as a race would leave it, and committed. */
async function writtenPastTheRoutes(text: string, values: unknown[]): Promise<void> {
  const client = await begun()

  try {
    await client.query(text, values)
    await client.query('commit')
  } finally {
    await client.query('rollback').catch(() => undefined)
    client.release()
  }
}

/**
 * Waits until a statement waits for the database process `pid`, and fails
 * when `work` is through first or nothing waits in time.
 */
async function waitedFor(pid: number, work: Promise<unknown>): Promise<void> {
  let done = false

  work.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )

  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      'select count(*)::int as waiting from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [pid],
    )

    if ((rows[0]?.waiting ?? 0) > 0) {
      return
    }

    if (done) {
      throw new Error('The work was through without waiting')
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error('Nothing waited in time')
}

const deviceOf = (who: string) =>
  (JSON.parse(who) as { deviceId?: string }).deviceId ?? 'geraet-im-keller'

function aCall(fields: Record<string, unknown> = {}) {
  const id = newId<'job'>()

  return {
    id,
    operation: created('jobs', id, {
      customerId: customer,
      kind: 'service',
      status: 'active',
      designation: 'Heizung ohne Strom',
      emergencyAt: atNight,
      ...fields,
    }),
  }
}

async function aSignedReport(
  jobId: string,
  lines: readonly Record<string, unknown>[] = [
    { designation: 'Arbeitszeit', quantityMilli: 1000, unit: 'hour', unitPriceCents: 0 },
  ],
) {
  const report = (
    await post('/documents', {
      customerId: customer,
      jobId,
      kind: 'time_and_material_report',
      documentDate: '2026-10-28',
    })
  ).id

  for (const line of lines) {
    await post(`/documents/${report}/lines`, line)
  }

  const sent = await push(app, office(), [
    created('document_signatures', newId<'document-signature'>(), {
      documentId: report,
      signerName: 'Ayse Arslan',
      signedAt: new Date().toISOString(),
      deviceInfo: null,
      path: scribble,
      contentFingerprint: await fingerprintAsHeld(admin, report),
    }),
  ])

  expect(sent.receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])

  return report
}

/** The lines a document shows, a line taken away not among them. */
async function linesOf(documentId: string) {
  const { rows } = await admin.query<{
    designation: string
    unit_price_cents: number
    unit: string
  }>(
    'select designation, unit_price_cents, unit from document_lines where document_id = $1 and deleted_at is null order by position',
    [documentId],
  )

  return rows
}

async function setting(key: string, value: number) {
  await post('/settings/parameters', { key, from: '2026-01-01', value, note: null }, owner())
}

let customer = ''
let shift = ''

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2)', [north.id, north.name])
  await readyToInvoice(admin, north.id)
  await admin.query(
    "insert into auth_users (id, name, email) values ('jonas', 'Jonas Brandt', 'jonas@nord.example.de'), ('lena', 'Lena Hoffmann', 'lena@nord.example.de'), ('max', 'Max Becker', 'max@nord.example.de')",
  )
  await admin.query(
    "insert into memberships (tenant_id, user_id, roles) values ($1, 'jonas', '{technician}'), ($1, 'lena', '{technician}'), ($1, 'max', '{technician}')",
    [north.id],
  )

  storageRoot = mkdtempSync(join(tmpdir(), 'opengewerk-on-call-'))
  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [
      ApiModule.create(database, identities, {
        files: new FileStore(storageRoot),
        renderer: standIn,
      }),
    ],
  }).compile()

  app = built.createNestApplication()
  await app.init()

  customer = (await post('/customers', { kind: 'private', name: 'Familie Arslan', ...invoiceable }))
    .id
  // What the business charges at night and at the weekend, from the start of the year.
  await setting('emergency.night_flat_cents', 4500)
  await setting('emergency.weekend_basis_points', 5000)
  shift = (
    await post('/on-call-shifts', {
      userId: 'jonas',
      startsAt: '2026-10-26T16:00:00.000Z',
      endsAt: '2026-11-02T06:00:00.000Z',
      note: 'Woche 44',
    })
  ).id
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
  rmSync(storageRoot, { recursive: true, force: true })
})

describe('the on-call plan (#293)', () => {
  it('is kept in the office and listed by the span it overlaps', async () => {
    const answer = await http()
      .get('/on-call-shifts?from=2026-10-28T00:00:00.000Z&to=2026-10-29T00:00:00.000Z')
      .set('x-test-identity', jonas())
      .expect(200)

    expect(answer.body).toMatchObject([{ id: shift, userId: 'jonas', note: 'Woche 44' }])

    // The week after it is over.
    const after = await http()
      .get('/on-call-shifts?from=2026-11-03T00:00:00.000Z&to=2026-11-10T00:00:00.000Z')
      .set('x-test-identity', jonas())
      .expect(200)

    expect(after.body).toEqual([])
  })

  it('is not kept by a technician', async () => {
    await post(
      '/on-call-shifts',
      { userId: 'jonas', startsAt: '2026-11-10T16:00:00.000Z', endsAt: '2026-11-11T06:00:00.000Z' },
      jonas(),
      403,
    )
  })

  it('takes only somebody who works here, and an end after the beginning', async () => {
    const stranger = await post(
      '/on-call-shifts',
      {
        userId: 'niemand',
        startsAt: '2026-11-10T16:00:00.000Z',
        endsAt: '2026-11-11T06:00:00.000Z',
      },
      office(),
      422,
    )

    expect(stranger.message).toContain('wer im Betrieb arbeitet')

    const backwards = await post(
      '/on-call-shifts',
      { userId: 'jonas', startsAt: '2026-11-11T16:00:00.000Z', endsAt: '2026-11-11T06:00:00.000Z' },
      office(),
      422,
    )

    expect(backwards.message).toContain('nach ihrem Beginn')
  })

  it('swaps the people of two times, and the times stay', async () => {
    const later = (
      await post('/on-call-shifts', {
        userId: 'lena',
        startsAt: '2026-11-09T16:00:00.000Z',
        endsAt: '2026-11-16T06:00:00.000Z',
      })
    ).id

    await post(`/on-call-shifts/${later}/swap`, { with: shift })

    const { rows } = await admin.query<{ id: string; user_id: string }>(
      'select id, user_id from on_call_shifts where id = any($1) order by starts_at',
      [[shift, later]],
    )

    expect(rows).toEqual([
      { id: shift, user_id: 'lena' },
      { id: later, user_id: 'jonas' },
    ])

    // And back, for the tests below.
    await post(`/on-call-shifts/${shift}/swap`, { with: later })
    await http().delete(`/on-call-shifts/${later}`).set('x-test-identity', office()).expect(200)
  })

  it('reaches the device of the person it names, and no other technician', async () => {
    const hers = (
      await post('/on-call-shifts', {
        userId: 'lena',
        startsAt: '2026-11-23T16:00:00.000Z',
        endsAt: '2026-11-30T06:00:00.000Z',
      })
    ).id
    const pulled = async (who: string) => {
      const answer = await http().get('/sync?since=0').set('x-test-identity', who).expect(200)
      const changes = (answer.body as { changes: { entity: string; rows: { id: string }[] }[] })
        .changes

      return (
        changes.find((change) => change.entity === 'on_call_shifts')?.rows.map((row) => row.id) ??
        []
      )
    }

    expect(await pulled(jonas())).toContain(shift)
    expect(await pulled(jonas())).not.toContain(hers)
    expect(await pulled(lena())).toContain(hers)
    expect(await pulled(lena())).not.toContain(shift)
    expect(await pulled(office())).toEqual(expect.arrayContaining([shift, hers]))

    await http().delete(`/on-call-shifts/${hers}`).set('x-test-identity', office()).expect(200)
  })

  it('lists a technician their own times, the office the whole plan', async () => {
    const times = await Promise.all(
      ['jonas', 'lena'].map(
        async (userId, week) =>
          (
            await post('/on-call-shifts', {
              userId,
              startsAt: `2026-12-${String(7 + week * 7).padStart(2, '0')}T16:00:00.000Z`,
              endsAt: `2026-12-${String(14 + week * 7).padStart(2, '0')}T06:00:00.000Z`,
              note: `Woche ${String(50 + week)}`,
            })
          ).id,
      ),
    )
    const listed = async (who: string) =>
      (
        (
          await http()
            .get('/on-call-shifts?from=2026-12-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z')
            .set('x-test-identity', who)
            .expect(200)
        ).body as { id: string }[]
      ).map((time) => time.id)

    expect(await listed(jonas())).toEqual([times[0]])
    expect(await listed(lena())).toEqual([times[1]])
    expect(await listed(office())).toEqual(times)

    for (const id of times) {
      await http().delete(`/on-call-shifts/${id}`).set('x-test-identity', office()).expect(200)
    }
  })

  it('is not written over the sync, by the office neither', async () => {
    const id = newId<'on-call-shift'>()
    const sent = await push(app, office(), [
      created('on_call_shifts', id, {
        userId: 'jonas',
        startsAt: '2026-12-01T16:00:00.000Z',
        endsAt: '2026-12-02T06:00:00.000Z',
        note: null,
      }),
    ])

    expect(sent.receipts[0]).toMatchObject({ outcome: 'conflict', reason: 'online_only' })
    expect((await admin.query('select id from on_call_shifts where id = $1', [id])).rows).toEqual(
      [],
    )
  })
})

describe('a service call made on call', () => {
  /** A moment so many hours before now; negative hours lie ahead. */
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

  beforeAll(async () => {
    // Max is on call now, and was in a time two days ago, with a gap between.
    await post('/on-call-shifts', {
      userId: 'max',
      startsAt: hoursAgo(30),
      endsAt: hoursAgo(-12),
    })
    await post('/on-call-shifts', { userId: 'max', startsAt: hoursAgo(60), endsAt: hoursAgo(49) })
  })

  it('lands from the technician on call, with the moment of the call', async () => {
    const at = hoursAgo(1)
    const call = aCall({ emergencyAt: at })
    const sent = await push(app, max(), [call.operation])

    expect(sent.receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])

    const { rows } = await admin.query('select kind, emergency_at from jobs where id = $1', [
      call.id,
    ])

    expect(rows).toEqual([{ kind: 'service', emergency_at: new Date(at) }])
  })

  it('is refused as a conflict outside every time of the plan of that person', async () => {
    // Between the two times of Max.
    const between = await push(app, max(), [aCall({ emergencyAt: hoursAgo(40) }).operation])
    // Max is on call now, Lena is not.
    const somebodyElses = await push(app, lena(), [aCall({ emergencyAt: hoursAgo(1) }).operation])

    expect(
      [...between.receipts, ...somebodyElses.receipts].map((receipt) => [
        receipt.outcome,
        receipt.reason,
        receipt.fields,
      ]),
    ).toEqual([
      ['conflict', 'record_is_fixed', ['emergencyAt']],
      ['conflict', 'record_is_fixed', ['emergencyAt']],
    ])
  })

  it('is refused in a time the office took back', async () => {
    const taken = (
      await post('/on-call-shifts', { userId: 'lena', startsAt: hoursAgo(3), endsAt: hoursAgo(-1) })
    ).id

    await http().delete(`/on-call-shifts/${taken}`).set('x-test-identity', office()).expect(200)

    const sent = await push(app, lena(), [aCall({ emergencyAt: hoursAgo(1) }).operation])

    expect(sent.receipts.map((receipt) => receipt.outcome)).toEqual(['conflict'])
  })

  it('is refused without the moment of the call, more than two days back, and ahead of the clock', async () => {
    const without = await push(app, max(), [aCall({ emergencyAt: null }).operation])
    // In the earlier time of Max, but too long ago to be a call taken now.
    const old = await push(app, max(), [aCall({ emergencyAt: hoursAgo(50) }).operation])
    const ahead = await push(app, max(), [aCall({ emergencyAt: hoursAgo(-1) }).operation])
    // A clock that runs a minute fast is no reason to refuse.
    const fast = await push(app, max(), [
      aCall({ emergencyAt: new Date(Date.now() + 60_000).toISOString() }).operation,
    ])

    expect(
      [...without.receipts, ...old.receipts, ...ahead.receipts, ...fast.receipts].map(
        (receipt) => receipt.outcome,
      ),
    ).toEqual(['conflict', 'conflict', 'conflict', 'applied'])
  })

  it('is a running call of its own, no follow-up and nothing finished', async () => {
    const first = aCall({ emergencyAt: hoursAgo(1) })

    await push(app, office(), [first.operation])

    const finished = await push(app, max(), [
      aCall({ status: 'completed', emergencyAt: hoursAgo(1) }).operation,
    ])
    const followUp = await push(app, max(), [
      aCall({ predecessorJobId: first.id, emergencyAt: hoursAgo(1) }).operation,
    ])

    expect(
      [...finished.receipts, ...followUp.receipts].map((receipt) => [
        receipt.outcome,
        receipt.reason,
      ]),
    ).toEqual([
      ['conflict', 'record_is_fixed'],
      ['conflict', 'record_is_fixed'],
    ])
  })

  it('is no project: that takes the right to write jobs', async () => {
    const refused = await push(app, jonas(), [aCall({ kind: 'project' }).operation], 400)

    expect(refused.message).toContain('darf dieser Zugang nicht')
  })

  it('has a day and a time of the call, at the route and in the sync', async () => {
    const sentence = 'Der Notdiensteinsatz braucht Tag und Uhrzeit des Anrufs.'
    const atRoute = await post(
      '/jobs',
      { customerId: customer, kind: 'service', designation: 'Licht', emergencyAt: 'gestern' },
      office(),
      422,
    )
    const inSync = await push(app, office(), [aCall({ emergencyAt: 'gestern' }).operation], 400)

    expect([atRoute.message, inSync.message]).toEqual([sentence, sentence])
  })

  it('is no call before 2007, at the route and in the sync (#1085)', async () => {
    const sentence = 'Der Tag des Anrufs liegt vor 2007 und ist wohl vertippt.'
    const halfTyped = '0026-10-28T01:14:00.000Z'
    const atRoute = await post(
      '/jobs',
      { customerId: customer, kind: 'service', designation: 'Licht', emergencyAt: halfTyped },
      office(),
      422,
    )
    const inSync = await push(app, office(), [aCall({ emergencyAt: halfTyped }).operation], 400)

    expect([atRoute.message, inSync.message]).toEqual([sentence, sentence])
  })

  it('is marked at the route of the office, and changed there', async () => {
    const made = await post('/jobs', {
      customerId: customer,
      kind: 'service',
      designation: 'Licht im Treppenhaus',
      emergencyAt: atNight,
    })

    await http()
      .patch(`/jobs/${made.id}`)
      .set('x-test-identity', office())
      .send({ emergencyAt: inTheDay })
      .expect(200)

    const { rows } = await admin.query('select emergency_at from jobs where id = $1', [made.id])

    expect(rows).toEqual([{ emergency_at: new Date(inTheDay) }])
  })

  it('is made by the office at any time, without a time of the plan', async () => {
    const sent = await push(app, office(), [aCall({ emergencyAt: inTheDay }).operation])

    expect(sent.receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])
  })
})

describe('the surcharge of an emergency call', () => {
  it('is the last line of the invoice out of its report, for the kind of the call', async () => {
    const call = aCall()

    await push(app, office(), [call.operation])

    const report = await aSignedReport(call.id)
    const invoice = (await post(`/documents/${report}/successors`, { kind: 'final_invoice' })).id

    expect((await linesOf(invoice)).at(-1)).toEqual({
      designation: 'Notdienstzuschlag Nacht',
      unit_price_cents: 4500,
      unit: 'flat_rate',
    })
  })

  it('comes as a percentage on the working time and on nothing else', async () => {
    // Saturday 24.10.2026 at 10:00 in Germany.
    const call = aCall({ emergencyAt: '2026-10-24T08:00:00.000Z' })

    await push(app, office(), [call.operation])

    const report = await aSignedReport(call.id, [
      { designation: 'Arbeitszeit', quantityMilli: 2000, unit: 'hour', unitPriceCents: 6000 },
      { designation: 'Kabel', quantityMilli: 1000, unit: 'piece', unitPriceCents: 10_000 },
    ])
    const invoice = (await post(`/documents/${report}/successors`, { kind: 'final_invoice' })).id

    expect((await linesOf(invoice)).at(-1)).toEqual({
      designation: 'Notdienstzuschlag Wochenende',
      unit_price_cents: 6000,
      unit: 'flat_rate',
    })
  })

  it('is no line for a call in ordinary hours, nor for a job that is no emergency', async () => {
    const day = aCall({ emergencyAt: inTheDay })

    await push(app, office(), [day.operation])

    const ordinary = await post('/jobs', {
      customerId: customer,
      kind: 'service',
      designation: 'Steckdose',
    })
    const fromTheDay = (
      await post(`/documents/${await aSignedReport(day.id)}/successors`, { kind: 'final_invoice' })
    ).id
    const fromOrdinary = (
      await post(`/documents/${await aSignedReport(ordinary.id)}/successors`, {
        kind: 'final_invoice',
      })
    ).id

    expect((await linesOf(fromTheDay)).map((line) => line.designation)).toEqual(['Arbeitszeit'])
    expect((await linesOf(fromOrdinary)).map((line) => line.designation)).toEqual(['Arbeitszeit'])
  })

  it('comes once on the collective invoice of the call', async () => {
    const call = aCall()

    await push(app, office(), [call.operation])

    for (let day = 0; day < 2; day += 1) {
      const report = await aSignedReport(call.id)

      await post(`/documents/${report}/issue`, {})
    }

    const invoice = (await post(`/jobs/${call.id}/collective-invoice`, {})).id
    const designations = (await linesOf(invoice)).map((line) => line.designation)

    expect(designations.filter((one) => one === 'Arbeitszeit')).toHaveLength(2)
    expect(designations.filter((one) => one === 'Notdienstzuschlag Nacht')).toHaveLength(1)
    expect(designations.at(-1)).toBe('Notdienstzuschlag Nacht')
  })

  it('comes no second time where a report carries it as a position, on either invoice (#1098)', async () => {
    const hour = {
      designation: 'Arbeitszeit',
      quantityMilli: 1000,
      unit: 'hour',
      unitPriceCents: 0,
    }
    const typed = {
      designation: 'Notdienstzuschlag Nacht',
      quantityMilli: 1000,
      unit: 'flat_rate',
      unitPriceCents: 4500,
    }
    const single = aCall()
    const collected = aCall()

    await push(app, office(), [single.operation, collected.operation])

    const fromReport = (
      await post(`/documents/${await aSignedReport(single.id, [hour, typed])}/successors`, {
        kind: 'final_invoice',
      })
    ).id

    for (const lines of [[hour, typed], [hour]]) {
      await post(`/documents/${await aSignedReport(collected.id, lines)}/issue`, {})
    }

    const collective = (await post(`/jobs/${collected.id}/collective-invoice`, {})).id

    for (const invoice of [fromReport, collective]) {
      const { rows } = await admin.query<{ marks: number; shown: number; total: number }>(
        `select count(*) filter (where emergency_surcharge)::int as marks,
                count(*) filter (where deleted_at is null and designation like 'Notdienstzuschlag%')::int as shown,
                count(*) filter (where designation like 'Notdienstzuschlag%')::int as total
         from document_lines where document_id = $1`,
        [invoice],
      )

      // The one the report carried, and no line of the server, not even one taken away.
      expect(rows).toEqual([{ marks: 0, shown: 1, total: 1 }])
    }
  })

  it('locks the reports of a collective invoice in the order of their ids, as a transmission does', async () => {
    const call = aCall()

    await push(app, office(), [call.operation])

    const [first = '', second = ''] = [
      await aSignedReport(call.id),
      await aSignedReport(call.id),
    ].sort()

    // Issued the other way round: the smaller number on the larger id, so
    // that the reports listed oldest first are not in the order of their ids.
    await post(`/documents/${second}/issue`, {})
    await post(`/documents/${first}/issue`, {})

    const holding = await lockedForIssuing(first)
    let collecting: Promise<number> | undefined

    try {
      collecting = http()
        .post(`/jobs/${call.id}/collective-invoice`)
        .set('x-test-identity', office())
        .send({})
        .then((answer) => answer.status)
      await waitingFor(admin, holding, collecting)

      // Waiting at the first, it holds none of them yet: the second is free.
      const other = await begun()

      try {
        await other.query('select id from documents where id = $1 for update nowait', [second])
      } finally {
        await other.query('rollback').catch(() => undefined)
        other.release()
      }

      await holding.query('commit')
    } finally {
      await holding.query('rollback').catch(() => undefined)
      holding.release()
      await Promise.allSettled([collecting])
    }

    expect(await collecting).toBe(201)
  })
})

describe('the surcharge named before the order (#1081)', () => {
  async function invoiceOf(jobId: string) {
    return (
      await post(`/documents/${await aSignedReport(jobId)}/successors`, { kind: 'final_invoice' })
    ).id
  }

  it('is the most an invoice charges, and nothing named is nothing charged', async () => {
    // The settings charge 45,00 € at night.
    const lower = aCall({ emergencyNamedFlatCents: 3000, emergencyNamedBasisPoints: 0 })
    const higher = aCall({ emergencyNamedFlatCents: 9000, emergencyNamedBasisPoints: 0 })
    const none = aCall({ emergencyNamedFlatCents: 0, emergencyNamedBasisPoints: 0 })

    await push(app, office(), [lower.operation, higher.operation, none.operation])

    expect((await linesOf(await invoiceOf(lower.id))).at(-1)).toEqual({
      designation: 'Notdienstzuschlag Nacht',
      unit_price_cents: 3000,
      unit: 'flat_rate',
    })
    expect((await linesOf(await invoiceOf(higher.id))).at(-1)).toMatchObject({
      unit_price_cents: 4500,
    })
    expect((await linesOf(await invoiceOf(none.id))).map((line) => line.designation)).toEqual([
      'Arbeitszeit',
    ])
  })

  it('charges no more than was named on hours without a price yet, a percentage included', async () => {
    // Saturday 24.10.2026 at 10:00, where the settings charge 50 % on the working time.
    const saturday = '2026-10-24T08:00:00.000Z'
    const none = aCall({
      emergencyAt: saturday,
      emergencyNamedFlatCents: 0,
      emergencyNamedBasisPoints: 0,
    })
    const less = aCall({
      emergencyAt: saturday,
      emergencyNamedFlatCents: 0,
      emergencyNamedBasisPoints: 3000,
    })

    await push(app, office(), [none.operation, less.operation])

    const describedOn = async (jobId: string) =>
      (
        await admin.query<{ designation: string; description: string | null }>(
          'select designation, description from document_lines where document_id = $1 and deleted_at is null order by position',
          [await invoiceOf(jobId)],
        )
      ).rows.map((line) => line.description ?? line.designation)

    expect(await describedOn(none.id)).toEqual(['Arbeitszeit'])
    expect(await describedOn(less.id)).toEqual(['Arbeitszeit', '30 % auf die Arbeitszeit'])
  })

  it('takes the percentage of the day on hours without a price yet, which costs nothing (#1087)', async () => {
    const flat = aCall({
      emergencyAt: '2026-10-24T08:00:00.000Z',
      emergencyNamedFlatCents: 3000,
      emergencyNamedBasisPoints: 0,
    })

    await push(app, office(), [flat.operation])

    // 50 % on nothing is less than the 30,00 € named; the draft works it out
    // again once the office prices the hours.
    expect((await linesOf(await invoiceOf(flat.id))).at(-1)).toEqual({
      designation: 'Notdienstzuschlag Wochenende',
      unit_price_cents: 0,
      unit: 'flat_rate',
    })
  })

  it('takes the percentage of the day where an hour is given free or priced by hand', async () => {
    const hour = async (number: string, unitPriceCents: number) =>
      (
        await post('/articles', {
          number,
          designation: `Arbeitsstunde ${number}`,
          unit: 'hour',
          price: { unitPriceCents, validFrom: '2026-01-01' },
        })
      ).id
    const paid = await hour('AS-1081-1', 1000)
    const free = await hour('AS-1081-2', 0)
    // Saturday 24.10.2026 at 10:00: the settings charge 50 % on the working time.
    const named = {
      emergencyAt: '2026-10-24T08:00:00.000Z',
      emergencyNamedFlatCents: 3000,
      emergencyNamedBasisPoints: 0,
    }
    const single = aCall(named)
    const collected = aCall(named)
    const byHand = aCall(named)
    const lines = [
      {
        designation: 'Arbeitszeit',
        quantityMilli: 1000,
        unit: 'hour',
        unitPriceCents: 0,
        articleId: paid,
      },
      {
        designation: 'Kulanzstunde',
        quantityMilli: 1000,
        unit: 'hour',
        unitPriceCents: 0,
        articleId: free,
      },
    ]

    await push(app, office(), [single.operation, collected.operation, byHand.operation])

    const report = await aSignedReport(single.id, lines)

    await post(`/documents/${await aSignedReport(collected.id, lines)}/issue`, {})

    const invoices = [
      (await post(`/documents/${report}/successors`, { kind: 'final_invoice' })).id,
      (await post(`/jobs/${collected.id}/collective-invoice`, {})).id,
      (
        await post(
          `/documents/${await aSignedReport(byHand.id, [
            { designation: 'Arbeitszeit', quantityMilli: 1000, unit: 'hour', unitPriceCents: 1000 },
          ])}/successors`,
          { kind: 'final_invoice' },
        )
      ).id,
    ]
    const last = []

    for (const invoice of invoices) {
      const { rows } = await admin.query<{ description: string | null; net_cents: number }>(
        'select description, net_cents from document_lines where document_id = $1 order by position',
        [invoice],
      )

      last.push(rows.at(-1))
    }

    expect(last).toEqual([
      { description: '50 % auf die Arbeitszeit', net_cents: 500 },
      { description: '50 % auf die Arbeitszeit', net_cents: 500 },
      { description: '50 % auf die Arbeitszeit', net_cents: 500 },
    ])
  })

  it('comes from the device that took the call on call, with the job', async () => {
    // Max is on call now (see above); the call came an hour ago.
    const call = aCall({
      emergencyAt: new Date(Date.now() - 3_600_000).toISOString(),
      emergencyNamedFlatCents: 4500,
      emergencyNamedBasisPoints: 0,
    })
    const answer = await push(app, max(), [call.operation])

    expect(answer.receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])
    expect(
      (
        await admin.query(
          'select emergency_named_flat_cents, emergency_named_basis_points from jobs where id = $1',
          [call.id],
        )
      ).rows,
    ).toEqual([{ emergency_named_flat_cents: 4500, emergency_named_basis_points: 0 }])
  })

  it('is refused in one part, out of bounds, or on a job that is no emergency', async () => {
    const half = aCall({ emergencyNamedFlatCents: 3000 })
    const negative = aCall({ emergencyNamedFlatCents: -1, emergencyNamedBasisPoints: 0 })
    const ordinary = aCall({
      emergencyAt: null,
      emergencyNamedFlatCents: 3000,
      emergencyNamedBasisPoints: 0,
    })
    // A transfer with a record against the rules is refused as a whole, with the sentence.
    const messages = []

    for (const call of [half, negative, ordinary]) {
      messages.push((await push(app, office(), [call.operation], 400)).message)
    }

    expect(messages).toEqual([
      expect.stringMatching(/beide oder keinen/),
      expect.stringMatching(/ganze Zahl/),
      expect.stringMatching(/nur ein Notdiensteinsatz/),
    ])

    await post(
      '/jobs',
      {
        customerId: customer,
        kind: 'service',
        designation: 'Steckdose',
        emergencyNamedFlatCents: 3000,
        emergencyNamedBasisPoints: 0,
      },
      office(),
      422,
    )
  })

  it('stays when the office changes something else of the job', async () => {
    const job = await post('/jobs', {
      customerId: customer,
      kind: 'service',
      designation: 'Licht im Flur',
      emergencyAt: atNight,
      emergencyNamedFlatCents: 3000,
      emergencyNamedBasisPoints: 0,
    })

    await http()
      .patch(`/jobs/${job.id}`)
      .set('x-test-identity', office())
      .send({ designation: 'Licht im Flur und Bad' })
      .expect(200)
    await http()
      .patch(`/jobs/${job.id}`)
      .set('x-test-identity', office())
      .send({ emergencyAt: null })
      .expect(422)
  })

  it('is taken by the office at its route, with the moment of the call', async () => {
    const job = await post('/jobs', {
      customerId: customer,
      kind: 'service',
      designation: 'Sicherung fliegt',
      emergencyAt: atNight,
      emergencyNamedFlatCents: 2500,
      emergencyNamedBasisPoints: 0,
    })

    expect((await linesOf(await invoiceOf(job.id))).at(-1)).toMatchObject({
      unit_price_cents: 2500,
    })
  })
})

/**
 * The line of the surcharge on a draft (#1087): worked out again from what it
 * depends on whenever that changes, in the office and over the sync, until
 * the office changes its text or amount by hand.
 */
describe('the line of the surcharge on a draft (#1087)', () => {
  // Saturday 24.10.2026 at 10:00: the settings charge 50 % on the working time.
  const saturday = '2026-10-24T08:00:00.000Z'

  async function lineOf(invoice: string, designation: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      'select id from document_lines where document_id = $1 and designation = $2 and deleted_at is null',
      [invoice, designation],
    )

    return rows[0]?.id ?? ''
  }

  async function draftOf(fields: Record<string, unknown> = {}) {
    const call = aCall({ emergencyAt: saturday, ...fields })

    await push(app, office(), [call.operation])

    const invoice = (
      await post(`/documents/${await aSignedReport(call.id)}/successors`, {
        kind: 'final_invoice',
      })
    ).id

    return { job: call.id, invoice, hour: await lineOf(invoice, 'Arbeitszeit') }
  }

  async function surchargeOf(invoice: string) {
    const { rows } = await admin.query<{
      id: string
      designation: string
      description: string | null
      net_cents: number
      emergency_surcharge: boolean
      deleted: boolean
    }>(
      `select id, designation, description, net_cents, emergency_surcharge, deleted_at is not null as deleted
       from document_lines where document_id = $1 and designation like 'Notdienstzuschlag %'
       order by deleted_at desc nulls first`,
      [invoice],
    )

    // At most one on the draft; one that went before it came back stays below.
    expect(rows.filter((row) => !row.deleted).length).toBeLessThanOrEqual(1)
    expect(rows.length).toBeGreaterThanOrEqual(1)

    return (
      rows[0] ?? {
        id: '',
        designation: '',
        description: null,
        net_cents: -1,
        emergency_surcharge: false,
        deleted: true,
      }
    )
  }

  async function patch(path: string, body: Record<string, unknown>) {
    await http().patch(path).set('x-test-identity', office()).send(body).expect(200)
  }

  async function sent(...operations: Parameters<typeof push>[2]) {
    const answer = await push(app, office(), operations)

    expect(answer.receipts.map((receipt) => receipt.outcome)).toEqual(
      operations.map(() => 'applied'),
    )
  }

  const price = (invoice: string, line: string, unitPriceCents: number) =>
    patch(`/documents/${invoice}/lines/${line}`, { unitPriceCents })

  const removeInOffice = async (invoice: string, line: string) => {
    await http()
      .delete(`/documents/${invoice}/lines/${line}`)
      .set('x-test-identity', office())
      .expect(200)
  }

  /** The lines of a draft that carry the mark, the ones gone included. */
  async function marksOf(invoice: string) {
    const { rows } = await admin.query<{ marks: number }>(
      'select count(*)::int as marks from document_lines where document_id = $1 and emergency_surcharge',
      [invoice],
    )

    return rows[0]?.marks
  }

  it('follows the hours the office prices, up to what was named before the order', async () => {
    const { invoice, hour } = await draftOf({
      emergencyNamedFlatCents: 3000,
      emergencyNamedBasisPoints: 0,
    })

    expect(await surchargeOf(invoice)).toMatchObject({
      designation: 'Notdienstzuschlag Wochenende',
      description: '50 % auf die Arbeitszeit',
      net_cents: 0,
      emergency_surcharge: true,
      deleted: false,
    })

    await price(invoice, hour, 1000)

    expect(await surchargeOf(invoice)).toMatchObject({
      description: '50 % auf die Arbeitszeit',
      net_cents: 500,
    })

    // 50 % of 100,00 € is more than the 30,00 € named: the named amount.
    await price(invoice, hour, 10_000)

    expect(await surchargeOf(invoice)).toMatchObject({ description: null, net_cents: 3000 })
  })

  it('follows lines of hours the office adds and removes', async () => {
    const { invoice } = await draftOf()
    const added = await post(`/documents/${invoice}/lines`, {
      designation: 'Fahrzeit',
      quantityMilli: 1000,
      unit: 'hour',
      unitPriceCents: 2000,
    })

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 1000 })

    await http()
      .delete(`/documents/${invoice}/lines/${added.id}`)
      .set('x-test-identity', office())
      .expect(200)

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 0 })
  })

  it('follows the hours a device changes, adds and removes', async () => {
    const { invoice, hour } = await draftOf()
    const added = newId<'document-line'>()

    await sent(changed('document_lines', hour, { unitPriceCents: { from: 0, to: 4000 } }))

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 2000 })

    await sent(
      created('document_lines', added, {
        documentId: invoice,
        kind: 'item',
        position: 9,
        designation: 'Fahrzeit',
        quantityMilli: 1000,
        unit: 'hour',
        unitPriceCents: 2000,
        vatRate: 'standard',
      }),
    )

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 3000 })

    await sent(deleted('document_lines', added))

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 2000 })
  })

  it('belongs to the office once its text or amount is changed by hand, in the office or on a device', async () => {
    const inOffice = await draftOf()
    const line = (await surchargeOf(inOffice.invoice)).id

    // Moved down the list, it is still the server's.
    await patch(`/documents/${inOffice.invoice}/lines/${line}`, { position: 9 })
    await price(inOffice.invoice, inOffice.hour, 1000)

    expect(await surchargeOf(inOffice.invoice)).toMatchObject({
      net_cents: 500,
      emergency_surcharge: true,
    })

    await patch(`/documents/${inOffice.invoice}/lines/${line}`, { unitPriceCents: 1234 })
    await price(inOffice.invoice, inOffice.hour, 2000)

    expect(await surchargeOf(inOffice.invoice)).toMatchObject({
      net_cents: 1234,
      emergency_surcharge: false,
    })

    const onDevice = await draftOf()
    const its = (await surchargeOf(onDevice.invoice)).id

    await sent(
      changed('document_lines', its, {
        designation: { from: 'Notdienstzuschlag Wochenende', to: 'Notdienstzuschlag Samstag' },
      }),
    )
    await price(onDevice.invoice, onDevice.hour, 2000)

    expect(await surchargeOf(onDevice.invoice)).toMatchObject({
      designation: 'Notdienstzuschlag Samstag',
      net_cents: 0,
      emergency_surcharge: false,
    })

    // The mark is the server's: a device that sets it meets a conflict.
    const answer = await push(app, office(), [
      changed('document_lines', its, { emergencySurcharge: { from: false, to: true } }),
    ])

    expect(answer.receipts[0]).toMatchObject({
      outcome: 'conflict',
      reason: 'set_by_server',
      fields: ['emergencySurcharge'],
    })
    expect(await surchargeOf(onDevice.invoice)).toMatchObject({ emergency_surcharge: false })
  })

  it('follows the call and the surcharge named for it, and goes where the call has none', async () => {
    const { job, invoice, hour } = await draftOf()

    await price(invoice, hour, 10_000)

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 5000 })

    await patch(`/jobs/${job}`, { emergencyNamedFlatCents: 2000, emergencyNamedBasisPoints: 0 })

    expect(await surchargeOf(invoice)).toMatchObject({ description: null, net_cents: 2000 })

    await sent(changed('jobs', job, { emergencyNamedFlatCents: { from: 2000, to: 1500 } }))

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 1500 })

    // Wednesday 28.10.2026 at 10:00 is no emergency.
    await patch(`/jobs/${job}`, { emergencyAt: inTheDay })

    expect(await surchargeOf(invoice)).toMatchObject({ deleted: true, emergency_surcharge: true })

    // The night before is one again, and the surcharge comes back, once.
    await sent(changed('jobs', job, { emergencyAt: { from: inTheDay, to: atNight } }))

    expect(await surchargeOf(invoice)).toMatchObject({
      designation: 'Notdienstzuschlag Nacht',
      net_cents: 1500,
      emergency_surcharge: true,
      deleted: false,
    })
    expect(await marksOf(invoice)).toBe(1)

    // Removed by the office after it came back, it stays removed.
    await removeInOffice(invoice, (await surchargeOf(invoice)).id)
    await price(invoice, hour, 20_000)

    expect(await surchargeOf(invoice)).toMatchObject({ deleted: true })
    expect(await marksOf(invoice)).toBe(0)
  })

  it('stays removed once the office or a device removes it', async () => {
    const inOffice = await draftOf()

    await removeInOffice(inOffice.invoice, (await surchargeOf(inOffice.invoice)).id)
    await price(inOffice.invoice, inOffice.hour, 1000)

    expect(await surchargeOf(inOffice.invoice)).toMatchObject({
      deleted: true,
      emergency_surcharge: false,
    })

    const onDevice = await draftOf()

    await sent(deleted('document_lines', (await surchargeOf(onDevice.invoice)).id))
    await price(onDevice.invoice, onDevice.hour, 1000)

    expect(await surchargeOf(onDevice.invoice)).toMatchObject({
      deleted: true,
      emergency_surcharge: false,
    })
  })

  it('moves with the draft to the job of another call, in the office and on a device', async () => {
    const { job, invoice, hour } = await draftOf()
    const night = aCall()

    await push(app, office(), [night.operation])
    await price(invoice, hour, 10_000)
    await patch(`/documents/${invoice}`, { jobId: night.id })

    expect(await surchargeOf(invoice)).toMatchObject({
      designation: 'Notdienstzuschlag Nacht',
      net_cents: 4500,
    })

    await sent(changed('documents', invoice, { jobId: { from: night.id, to: job } }))

    expect(await surchargeOf(invoice)).toMatchObject({
      designation: 'Notdienstzuschlag Wochenende',
      net_cents: 5000,
    })
  })

  it('comes on the collective invoice of the call and follows its hours', async () => {
    const call = aCall({ emergencyAt: saturday })

    await push(app, office(), [call.operation])
    await post(`/documents/${await aSignedReport(call.id)}/issue`, {})

    const invoice = (await post(`/jobs/${call.id}/collective-invoice`, {})).id

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 0, emergency_surcharge: true })

    await price(invoice, await lineOf(invoice, 'Arbeitszeit'), 3000)

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 1500 })
  })

  it('stays as it was issued', async () => {
    const { job, invoice, hour } = await draftOf()

    await price(invoice, hour, 10_000)
    await post(`/documents/${invoice}/issue`, {})
    await patch(`/jobs/${job}`, { emergencyNamedFlatCents: 2000, emergencyNamedBasisPoints: 0 })

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 5000, deleted: false })

    // Asked for directly, an issued invoice is found fixed and left as it is.
    await database.forTenant({ tenantId: north.id }, (tx) => refreshSurchargeLine(tx, invoice))

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 5000, deleted: false })
  })
  /** The lines of a surcharge a draft shows. */
  async function shownSurchargesOf(invoice: string) {
    const { rows } = await admin.query<{ designation: string; emergency_surcharge: boolean }>(
      `select designation, emergency_surcharge from document_lines
       where document_id = $1 and deleted_at is null
         and (designation = 'Notdienstzuschlag' or designation like 'Notdienstzuschlag %')`,
      [invoice],
    )

    return rows
  }

  it('is no line at all, not one taken away, on an invoice of a job that is no emergency', async () => {
    const { invoice } = await draftOf({ emergencyAt: null })
    const { rows } = await admin.query<{ lines: number }>(
      `select count(*)::int as lines from document_lines
       where document_id = $1 and designation like 'Notdienstzuschlag%'`,
      [invoice],
    )

    expect(rows).toEqual([{ lines: 0 }])
  })

  it('comes on a draft whose invoice had none, once the call has one', async () => {
    // Wednesday 28.10.2026 at 10:00: no surcharge when the invoice is made.
    const { job, invoice } = await draftOf({ emergencyAt: inTheDay })

    expect(await shownSurchargesOf(invoice)).toEqual([])

    // The office learns the call came in the night before.
    await patch(`/jobs/${job}`, { emergencyAt: atNight })

    expect(await shownSurchargesOf(invoice)).toEqual([
      { designation: 'Notdienstzuschlag Nacht', emergency_surcharge: true },
    ])
  })

  it.each(['Notdienstzuschlag Nacht', 'Notdienstzuschlag'])(
    'does not come back next to a surcharge the office typed in as „%s“',
    async (designation) => {
      const { job, invoice } = await draftOf()

      await patch(`/jobs/${job}`, { emergencyAt: inTheDay })
      await post(`/documents/${invoice}/lines`, {
        designation,
        quantityMilli: 1000,
        unit: 'flat_rate',
        unitPriceCents: 4500,
      })
      await sent(changed('jobs', job, { emergencyAt: { from: inTheDay, to: atNight } }))

      const { rows } = await admin.query<{ marked: number; shown: number }>(
        `select count(*) filter (where emergency_surcharge)::int as marked, count(*)::int as shown
         from document_lines where document_id = $1 and deleted_at is null and designation like 'Notdienstzuschlag%'`,
        [invoice],
      )

      expect(rows).toEqual([{ marked: 0, shown: 1 }])
      expect(await marksOf(invoice)).toBe(0)
    },
  )

  it('comes back next to a heading with the word in it', async () => {
    const { job, invoice } = await draftOf()

    await patch(`/jobs/${job}`, { emergencyAt: inTheDay })
    await post(`/documents/${invoice}/lines`, {
      kind: 'title',
      designation: 'Notdienstzuschlag Hinweis',
    })
    await sent(changed('jobs', job, { emergencyAt: { from: inTheDay, to: atNight } }))

    const { rows } = await admin.query<{ kind: string; designation: string }>(
      `select kind, designation from document_lines
       where document_id = $1 and deleted_at is null and emergency_surcharge`,
      [invoice],
    )

    expect(rows).toEqual([{ kind: 'item', designation: 'Notdienstzuschlag Nacht' }])
  })

  it('follows an hour a device moves from one draft to another, on both', async () => {
    const from = await draftOf()
    const to = await draftOf()

    await price(from.invoice, from.hour, 10_000)

    expect(await surchargeOf(from.invoice)).toMatchObject({ net_cents: 5000 })

    await sent(
      changed('document_lines', from.hour, { documentId: { from: from.invoice, to: to.invoice } }),
    )

    expect(await surchargeOf(from.invoice)).toMatchObject({ net_cents: 0, deleted: false })
    expect(await surchargeOf(to.invoice)).toMatchObject({ net_cents: 5000, deleted: false })
  })

  it('answers a move of its own line with the line as the refresh left it', async () => {
    const { job, invoice, hour } = await draftOf()

    await price(invoice, hour, 10_000)
    // 20,00 € named, past the routes: the line still says 50,00 €.
    await writtenPastTheRoutes(namedTwenty, [job])

    const answer = await http()
      .patch(`/documents/${invoice}/lines/${(await surchargeOf(invoice)).id}`)
      .set('x-test-identity', office())
      .send({ position: 9 })
      .expect(200)

    expect(answer.body).toMatchObject({ netCents: 2000, emergencySurcharge: true })
  })

  it('is no surcharge of a draft a device moves it to, and that draft charges it alone', async () => {
    const from = await draftOf()
    const to = await draftOf()
    const moved = (await surchargeOf(from.invoice)).id

    await sent(
      changed('document_lines', moved, { documentId: { from: from.invoice, to: to.invoice } }),
    )

    const { rows } = await admin.query<{ id: string; emergency_surcharge: boolean }>(
      `select id, emergency_surcharge from document_lines
       where document_id = $1 and designation like 'Notdienstzuschlag %' and deleted_at is null
       order by emergency_surcharge`,
      [to.invoice],
    )

    // The draft's own line stepped back for good: one surcharge, not two.
    expect(rows).toEqual([{ id: moved, emergency_surcharge: false }])
    expect(await marksOf(to.invoice)).toBe(0)
  })

  it.each(['Notdienstzuschlag Nacht', 'Notdienstzuschlag'])(
    'steps back for good next to a surcharge the office types in as „%s“',
    async (designation) => {
      const { job, invoice } = await draftOf()

      await post(`/documents/${invoice}/lines`, {
        designation,
        quantityMilli: 1000,
        unit: 'flat_rate',
        unitPriceCents: 4500,
      })

      expect(await shownSurchargesOf(invoice)).toEqual([
        { designation, emergency_surcharge: false },
      ])
      expect(await marksOf(invoice)).toBe(0)

      // Nor does it come back with the next change of the call.
      await patch(`/jobs/${job}`, { emergencyAt: atNight })

      expect(await shownSurchargesOf(invoice)).toEqual([
        { designation, emergency_surcharge: false },
      ])
    },
  )

  it('follows a call a device names in capitals', async () => {
    const { job, invoice } = await draftOf()

    await sent(
      changed('jobs', job.toUpperCase(), { emergencyAt: { from: saturday, to: inTheDay } }),
    )

    expect(await surchargeOf(invoice)).toMatchObject({ deleted: true, emergency_surcharge: true })
  })

  /**
   * Two drafts, a transmission that writes first and then changes the hour of
   * the first, held at the lock of the documents it read, and the hour moved
   * to the second draft by another device meanwhile.
   */
  async function aLineMovedMeanwhile() {
    const from = await draftOf()
    const to = await draftOf()
    // Made first, so that it comes first in the outbox: it writes, and the
    // transmission holds the log from then on.
    const write = aCall().operation
    const change = changed('document_lines', from.hour, {
      description: { from: null, to: 'Anfahrt inbegriffen' },
    })
    const transmit = () =>
      http()
        .post('/sync')
        .set('x-test-identity', office())
        .send({ deviceId: deviceOf(office()), operations: [write, change] })
        .then((answer) => ({
          status: answer.status,
          outcomes: ((answer.body as { receipts?: { outcome: string }[] }).receipts ?? []).map(
            (receipt) => receipt.outcome,
          ),
        }))
    // Held at the lock of the documents it read, before it locked them.
    const held = holdQuery(
      (text, values) =>
        /from "documents".*order by.*for no key update/i.test(text) &&
        values.includes(from.invoice),
    )
    // And at its first write, which takes the log.
    const writing = holdQuery((text) => text.startsWith('insert into "jobs"'))
    const changing = transmit()

    try {
      await held.reached
      await sent(
        changed('document_lines', from.hour, {
          documentId: { from: from.invoice, to: to.invoice },
        }),
      )
    } catch (error) {
      held.release()
      writing.release()
      await Promise.allSettled([changing])
      throw error
    }

    return { to, write, transmit, held, writing, changing }
  }

  it('locks the draft a line went to meanwhile before it writes', async () => {
    const { to, held, writing, changing } = await aLineMovedMeanwhile()
    let other: PoolClient | undefined

    try {
      other = await begun()
      held.release()
      await writing.reached

      // About to write, the transmission holds the draft the hour is on now.
      await expect(
        other.query('select id from documents where id = $1 for no key update nowait', [
          to.invoice,
        ]),
      ).rejects.toMatchObject({ code: '55P03' })
    } finally {
      held.release()
      writing.release()
      await other?.query('rollback').catch(() => undefined)
      other?.release()
      await Promise.allSettled([changing])
    }

    expect(await changing).toEqual({ status: 201, outcomes: ['applied', 'applied'] })
  })

  it('waits for no draft it comes to late, and goes through when sent again', async () => {
    const { to, write, transmit, held, writing, changing } = await aLineMovedMeanwhile()
    let issuing: PoolClient | undefined
    let answered: unknown

    try {
      issuing = await lockedForIssuing(to.invoice)
      writing.release()
      held.release()
      // Issuing holds the draft the hour went to: waiting for it out of the
      // order of the ids could wait in a circle, so the transmission gives up
      // before it writes, and a device sends it again.
      answered = await Promise.race([
        changing,
        new Promise((resolve) => setTimeout(() => resolve('waited'), 3000)),
      ])
      await issuing.query("update jobs set description = 'Zähler prüfen' where id = $1", [to.job])
      await issuing.query('commit')
    } finally {
      writing.release()
      held.release()
      await issuing?.query('rollback').catch(() => undefined)
      issuing?.release()
      await Promise.allSettled([changing])
    }

    expect(answered).toEqual({ status: 503, outcomes: [] })

    const { rows } = await admin.query('select id from jobs where id = $1', [write.recordId])

    expect(rows).toEqual([])
    expect(await transmit()).toEqual({ status: 201, outcomes: ['applied', 'applied'] })
  })

  it('locks an invoice with its report in the order of their ids, as a transmission does', async () => {
    const { invoice } = await draftOf()
    const { rows } = await admin.query<{ report: string }>(
      'select predecessor_document_id as report from documents where id = $1',
      [invoice],
    )
    const report = rows[0]?.report ?? ''

    expect(report < invoice).toBe(true)

    // A transmission that comes to the report first and to the invoice next.
    const transmission = await begun()
    let issuing: Promise<number> | undefined

    try {
      await transmission.query('select id from documents where id = $1 for no key update', [report])
      issuing = http()
        .post(`/documents/${invoice}/issue`)
        .set('x-test-identity', office())
        .send({})
        .then((answer) => answer.status)
      await waitingFor(admin, transmission, issuing)
      await transmission.query('select id from documents where id = $1 for no key update', [
        invoice,
      ])
      await transmission.query('commit')
    } finally {
      await transmission.query('rollback').catch(() => undefined)
      transmission.release()
      await Promise.allSettled([issuing])
    }

    expect(await issuing).toBe(201)
  })

  it('stays removed when the office removes it while a refresh waits for the draft', async () => {
    const { invoice, hour } = await draftOf()

    await price(invoice, hour, 10_000)

    // The office holds the draft, as its line route does, and removes the line.
    const removing = await lockedForIssuing(invoice)
    const refreshing = database.forTenant({ tenantId: north.id }, (tx) =>
      refreshSurchargeLine(tx, invoice),
    )

    try {
      await waitingFor(admin, removing, refreshing)
      await removing.query(
        'update document_lines set deleted_at = now(), emergency_surcharge = false where document_id = $1 and emergency_surcharge',
        [invoice],
      )
      await removing.query('commit')
    } finally {
      await removing.query('rollback').catch(() => undefined)
      removing.release()
      await Promise.allSettled([refreshing])
    }

    await refreshing

    expect(await surchargeOf(invoice)).toMatchObject({
      deleted: true,
      emergency_surcharge: false,
    })
  })

  const namedTwenty =
    'update jobs set emergency_named_flat_cents = 2000, emergency_named_basis_points = 0 where id = $1'

  it('is worked out once more when the invoice is issued', async () => {
    const { job, invoice, hour } = await draftOf()

    await price(invoice, hour, 10_000)
    // 20,00 € named, past the routes as a race would leave it: the draft still says 50,00 €.
    await writtenPastTheRoutes(namedTwenty, [job])

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 5000 })

    await post(`/documents/${invoice}/issue`, {})

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 2000, deleted: false })

    const { rows } = await admin.query<{ frozen: boolean }>(
      `select jsonb_path_exists(content, '$.** ? (@.designation starts with "Notdienstzuschlag" && @.netCents == 2000)') as frozen
       from document_snapshots where document_id = $1`,
      [invoice],
    )

    expect(rows).toEqual([{ frozen: true }])
  })

  it('waits for issuing that has read the lines, and leaves the issued line as it was frozen', async () => {
    const { job, invoice, hour } = await draftOf()

    await price(invoice, hour, 10_000)

    // The report first, so that issuing the invoice writes nothing before its number.
    const { rows } = await admin.query<{ report: string }>(
      'select predecessor_document_id as report from documents where id = $1',
      [invoice],
    )

    await post(`/documents/${rows[0]?.report ?? ''}/issue`, {})

    // Issuing has locked the draft, worked its line out, read its lines and
    // draws its number next.
    const held = holdQuery((text) => text.startsWith('insert into "number_ranges"'))
    const issuing = http()
      .post(`/documents/${invoice}/issue`)
      .set('x-test-identity', office())
      .send({})
      .then((answer) => answer.status)
    let refreshing: Promise<unknown> | undefined

    try {
      await held.reached
      // A refresh that did not wait would write 20,00 € into the line issuing froze at 50,00 €.
      await writtenPastTheRoutes(namedTwenty, [job])
      refreshing = database.forTenant({ tenantId: north.id }, (tx) =>
        refreshSurchargeLine(tx, invoice),
      )
      await waitedFor(held.holder(), refreshing)
    } finally {
      held.release()
      // Both done before the next test, even where the wait above failed.
      await Promise.allSettled([issuing, refreshing])
    }

    expect(await issuing).toBe(201)

    await refreshing

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 5000, deleted: false })
  })

  it('lets a draft be issued whose surcharge the office typed, however large the hours', async () => {
    const { job, invoice } = await draftOf()
    const anHour = {
      designation: 'Fahrzeit',
      quantityMilli: 1000,
      unit: 'hour',
      unitPriceCents: 2_000_000_000,
    }

    await patch(`/jobs/${job}`, { emergencyAt: inTheDay })
    await post(`/documents/${invoice}/lines`, {
      designation: 'Notdienstzuschlag',
      quantityMilli: 1000,
      unit: 'flat_rate',
      unitPriceCents: 10_000,
    })

    for (let hours = 0; hours < 3; hours += 1) {
      await post(`/documents/${invoice}/lines`, anHour)
    }

    // The Saturday again: 50 % of 60 million € would be too large, but the
    // office has typed its own surcharge, and that is the draft's.
    await patch(`/jobs/${job}`, { emergencyAt: saturday })
    await post(`/documents/${invoice}/issue`, {})

    expect(await marksOf(invoice)).toBe(0)
  })

  it('does not bring back a surcharge more than a line holds', async () => {
    const { job, invoice } = await draftOf()

    await patch(`/jobs/${job}`, { emergencyAt: inTheDay })

    for (let hours = 0; hours < 3; hours += 1) {
      await post(`/documents/${invoice}/lines`, {
        designation: 'Fahrzeit',
        quantityMilli: 1000,
        unit: 'hour',
        unitPriceCents: 2_000_000_000,
      })
    }

    // The Saturday again: 50 % of 60 million € do not fit a line; the change
    // goes through, the surcharge stays away, and issuing says why.
    await patch(`/jobs/${job}`, { emergencyAt: saturday })

    expect(await shownSurchargesOf(invoice)).toEqual([])

    const refused = await http()
      .post(`/documents/${invoice}/issue`)
      .set('x-test-identity', office())
      .send({})
      .expect(409)

    expect((refused.body as { message?: string }).message).toContain('größer')
  })

  it('makes the invoice out of a full report with its surcharge waiting for room', async () => {
    const call = aCall({ emergencyAt: saturday })

    await push(app, office(), [call.operation])

    const report = (
      await post('/documents', {
        customerId: customer,
        jobId: call.id,
        kind: 'time_and_material_report',
        documentDate: '2026-10-28',
      })
    ).id

    await writtenPastTheRoutes(
      `insert into document_lines (tenant_id, document_id, position, designation, quantity_milli, unit, unit_price_cents, net_cents)
       select $1, $2, n, 'Arbeitszeit', 1000, 'hour', 0, 0 from generate_series(1, 2000) n`,
      [north.id, report],
    )
    await push(app, office(), [
      created('document_signatures', newId<'document-signature'>(), {
        documentId: report,
        signerName: 'Ayse Arslan',
        signedAt: new Date().toISOString(),
        deviceInfo: null,
        path: scribble,
        contentFingerprint: await fingerprintAsHeld(admin, report),
      }),
    ])

    const invoice = (await post(`/documents/${report}/successors`, { kind: 'final_invoice' })).id

    expect(await marksOf(invoice)).toBe(1)
    expect(await shownSurchargesOf(invoice)).toEqual([])

    const refused = await http()
      .post(`/documents/${invoice}/issue`)
      .set('x-test-identity', office())
      .send({})
      .expect(409)

    expect((refused.body as { message?: string }).message).toContain('kein Platz')
  })

  it('leaves a surcharge more than a line holds off, and issuing says so', async () => {
    const { invoice, hour } = await draftOf()
    const twentyMillion = 2_000_000_000
    const anHour = {
      designation: 'Fahrzeit',
      quantityMilli: 1000,
      unit: 'hour',
      unitPriceCents: twentyMillion,
    }

    await price(invoice, hour, twentyMillion)
    await post(`/documents/${invoice}/lines`, anHour)

    // 50 % of 40 million € fit a line.
    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 2_000_000_000 })

    // 50 % of 60 million € do not: the line is written, the surcharge stays.
    await post(`/documents/${invoice}/lines`, anHour)
    await sent(
      created('document_lines', newId<'document-line'>(), {
        documentId: invoice,
        kind: 'item',
        position: 20,
        ...anHour,
        vatRate: 'standard',
      }),
    )

    expect(await surchargeOf(invoice)).toMatchObject({ net_cents: 2_000_000_000 })

    const refused = await http()
      .post(`/documents/${invoice}/issue`)
      .set('x-test-identity', office())
      .send({})
      .expect(409)

    expect((refused.body as { message?: string }).message).toContain('größer')
  })

  it('waits on a full draft until the office makes room', async () => {
    const { job, invoice } = await draftOf()

    await patch(`/jobs/${job}`, { emergencyAt: inTheDay })

    expect(await surchargeOf(invoice)).toMatchObject({ deleted: true, emergency_surcharge: true })

    const { rows } = await admin.query<{ lines: number }>(
      'select count(*)::int as lines from document_lines where document_id = $1 and deleted_at is null',
      [invoice],
    )

    await writtenPastTheRoutes(
      `insert into document_lines (tenant_id, document_id, position, designation, quantity_milli, unit, unit_price_cents, net_cents)
       select $1, $2, 100 + n, 'Kleinmaterial', 1000, 'piece', 0, 0 from generate_series(1, $3::int) n`,
      [north.id, invoice, 2000 - (rows[0]?.lines ?? 0)],
    )

    // The night again: the change goes through, and the line waits.
    await patch(`/jobs/${job}`, { emergencyAt: atNight })

    expect(await surchargeOf(invoice)).toMatchObject({ deleted: true, emergency_surcharge: true })

    // Issued now, the invoice would go out without the surcharge that is due.
    const refused = await http()
      .post(`/documents/${invoice}/issue`)
      .set('x-test-identity', office())
      .send({})
      .expect(409)

    expect((refused.body as { message?: string }).message).toContain('Notdienstzuschlag')

    const { rows: room } = await admin.query<{ id: string }>(
      "select id from document_lines where document_id = $1 and designation = 'Kleinmaterial' limit 1",
      [invoice],
    )

    await removeInOffice(invoice, room[0]?.id ?? '')

    expect(await surchargeOf(invoice)).toMatchObject({
      designation: 'Notdienstzuschlag Nacht',
      emergency_surcharge: true,
      deleted: false,
    })
  })
})

describe('the tariffs of an emergency call (#1024)', () => {
  const today = berlinClock(new Date()).day

  async function tariffs(who = jonas()) {
    return (await http().get('/on-call-shifts/tariffs').set('x-test-identity', who).expect(200))
      .body as EmergencyTariff[]
  }

  it('say what the business charges from today on, as far as a time on call reaches', async () => {
    expect(await tariffs()).toEqual([
      {
        on: today,
        until: addDays(today, 28),
        night: { fromMinute: 20 * 60, untilMinute: 6 * 60 },
        surcharges: {
          night: { flatCents: 4500, basisPoints: 0 },
          weekend: { flatCents: 0, basisPoints: 5000 },
          holiday: { flatCents: 0, basisPoints: 0 },
        },
        vatBasisPoints: 1900,
        holidays: [],
      },
    ])
  })

  it('begin anew on the day a new value of a surcharge begins', async () => {
    await http()
      .post('/settings/parameters')
      .set('x-test-identity', owner())
      .send({ key: 'emergency.night_flat_cents', from: addDays(today, 3), value: 6000, note: null })
      .expect(201)

    expect(
      (await tariffs()).map((one) => [one.on, one.until, one.surcharges.night.flatCents]),
    ).toEqual([
      [today, addDays(today, 2), 4500],
      [addDays(today, 3), addDays(today, 28), 6000],
    ])
  })

  it('take the public holidays of the business of this year and the next', async () => {
    await http()
      .put('/holidays')
      .set('x-test-identity', owner())
      .send({ state: 'DE-BW', local: [] })
      .expect(200)

    const holidays = (await tariffs(office()))[0]?.holidays ?? []
    const year = Number(today.slice(0, 4))

    expect(holidays).toContain(`${String(year)}-12-25`)
    expect(holidays).toContain(`${String(year + 1)}-01-01`)
  })

  it('begin on another day where the office notes a call down afterwards (#1080)', async () => {
    const from = addDays(today, -26)
    const answer = (
      await http()
        .get(`/on-call-shifts/tariffs?from=${from}`)
        .set('x-test-identity', office())
        .expect(200)
    ).body as EmergencyTariff[]

    expect(answer[0]).toMatchObject({
      on: from,
      until: addDays(from, 28),
      surcharges: { night: { flatCents: 4500, basisPoints: 0 } },
    })

    const year = Number(today.slice(0, 4))

    for (const day of [
      '2026-02-30',
      '2026-13-01',
      '28.10.2026',
      `${String(year - 2)}-01-01`,
      `${String(year + 2)}-01-01`,
      '0001-01-01',
      '9999-12-31',
    ]) {
      await http()
        .get(`/on-call-shifts/tariffs?from=${day}`)
        .set('x-test-identity', office())
        .expect(400)
    }
  })

  it('name no tax for a business that claims section 19 UStG', async () => {
    await setting('small_business.claimed', 1)

    const answer = await tariffs()

    expect(answer.length).toBeGreaterThan(0)
    expect(answer.every((one) => one.vatBasisPoints === null)).toBe(true)
  })
})

/**
 * Last in this file, because it changes the settings of every call after it:
 * a draft follows a new value of a surcharge and the public holidays (#1087).
 */
describe('the line of the surcharge on a draft, after the settings (#1087)', () => {
  it('follows a setting of the surcharges and the public holidays of the business', async () => {
    // Saturday 31.10.2026 at 10:00, Reformation Day in Lower Saxony.
    const call = aCall({ emergencyAt: '2026-10-31T09:00:00.000Z' })

    await push(app, office(), [call.operation])

    const invoice = (
      await post(`/documents/${await aSignedReport(call.id)}/successors`, {
        kind: 'final_invoice',
      })
    ).id
    const surcharge = async () =>
      (
        await admin.query<{ designation: string; net_cents: number }>(
          `select designation, net_cents from document_lines
           where document_id = $1 and emergency_surcharge and deleted_at is null`,
          [invoice],
        )
      ).rows
    const { rows } = await admin.query<{ id: string }>(
      "select id from document_lines where document_id = $1 and designation = 'Arbeitszeit'",
      [invoice],
    )

    await http()
      .patch(`/documents/${invoice}/lines/${rows[0]?.id ?? ''}`)
      .set('x-test-identity', office())
      .send({ unitPriceCents: 10_000 })
      .expect(200)

    expect(await surcharge()).toEqual([
      { designation: 'Notdienstzuschlag Wochenende', net_cents: 5000 },
    ])

    await post(
      '/settings/parameters',
      { key: 'emergency.weekend_basis_points', from: '2026-10-31', value: 2500, note: null },
      owner(),
    )

    expect(await surcharge()).toEqual([
      { designation: 'Notdienstzuschlag Wochenende', net_cents: 2500 },
    ])

    await setting('emergency.holiday_flat_cents', 2000)
    await http()
      .put('/holidays')
      .set('x-test-identity', owner())
      .send({ state: 'DE-NI', local: [] })
      .expect(200)

    expect(await surcharge()).toEqual([
      { designation: 'Notdienstzuschlag Feiertag', net_cents: 2000 },
    ])
  })

  /** A draft out of the signed report of a call on Saturday 24.10.2026 at 10:00. */
  async function aDraft() {
    const call = aCall({ emergencyAt: '2026-10-24T08:00:00.000Z' })

    await push(app, office(), [call.operation])

    const invoice = (
      await post(`/documents/${await aSignedReport(call.id)}/successors`, {
        kind: 'final_invoice',
      })
    ).id

    const { rows } = await admin.query<{ id: string }>(
      "select id from document_lines where document_id = $1 and designation = 'Arbeitszeit'",
      [invoice],
    )

    return { job: call.id, invoice, hour: rows[0]?.id ?? '' }
  }

  /** One transmission of the office's device, answered as it comes. */
  const transmitted = (operations: unknown[]) =>
    http()
      .post('/sync')
      .set('x-test-identity', office())
      .send({ deviceId: deviceOf(office()), operations })

  const toTheNight = (job: string) =>
    changed('jobs', job, { emergencyAt: { from: '2026-10-24T08:00:00.000Z', to: atNight } })

  type Draft = Awaited<ReturnType<typeof aDraft>>

  it.each([
    [
      'the office changes the call',
      ({ job }: Draft) =>
        http()
          .patch(`/jobs/${job}`)
          .set('x-test-identity', office())
          .send({ emergencyNamedFlatCents: 2000, emergencyNamedBasisPoints: 0 }),
      200,
      [],
    ],
    [
      'a device changes the call',
      ({ job }: Draft) => transmitted([toTheNight(job)]),
      201,
      ['applied'],
    ],
    [
      // The first operation writes, and the transmission holds the log from then on.
      'a device changes the call after another write',
      ({ job }: Draft) => transmitted([aCall().operation, toTheNight(job)]),
      201,
      ['applied', 'applied'],
    ],
    [
      'a device prices a line of the draft after another write',
      ({ hour }: Draft) =>
        transmitted([
          aCall().operation,
          changed('document_lines', hour, { unitPriceCents: { from: 0, to: 1000 } }),
        ]),
      201,
      ['applied', 'applied'],
    ],
    [
      'a setting of the surcharges',
      (_draft: Draft) =>
        http().post('/settings/parameters').set('x-test-identity', owner()).send({
          key: 'emergency.weekend_basis_points',
          from: '2026-11-02',
          value: 3000,
          note: null,
        }),
      201,
      [],
    ],
    [
      'the public holidays',
      (_draft: Draft) =>
        http().put('/holidays').set('x-test-identity', owner()).send({ state: 'DE-NI', local: [] }),
      200,
      [],
    ],
  ] as const)(
    '%s waits for a draft that is being issued, and does not deadlock',
    async (_, change, status, outcomes) => {
      const draft = await aDraft()
      const issuing = await lockedForIssuing(draft.invoice)
      const changing = change(draft).then((answer) => ({
        status: answer.status,
        receipts: (answer.body as { receipts?: { outcome: string }[] }).receipts ?? [],
      }))

      try {
        await waitingFor(admin, issuing, changing)
        // Issuing writes now, as it does after its lock.
        await issuing.query(
          "update documents set subject = coalesce(subject, 'Rechnung') where id = $1",
          [draft.invoice],
        )
        await issuing.query('commit')
      } finally {
        await issuing.query('rollback').catch(() => undefined)
        issuing.release()
        await Promise.allSettled([changing])
      }

      const answer = await changing

      expect(answer.status).toBe(status)
      // A transmission gets a receipt for every operation, each applied.
      expect(answer.receipts.map((receipt) => receipt.outcome)).toEqual(outcomes)
    },
  )

  it('signs a report after another write while the report is being issued, without a deadlock', async () => {
    const call = aCall({ emergencyAt: '2026-10-24T08:00:00.000Z' })

    await push(app, office(), [call.operation])

    const report = (
      await post('/documents', {
        customerId: customer,
        jobId: call.id,
        kind: 'time_and_material_report',
        documentDate: '2026-10-28',
      })
    ).id

    await post(`/documents/${report}/lines`, {
      designation: 'Arbeitszeit',
      quantityMilli: 1000,
      unit: 'hour',
      unitPriceCents: 0,
    })

    // Made first, so that it comes first in the outbox: it writes, and the
    // transmission holds the log from then on.
    const write = aCall().operation
    const signature = created('document_signatures', newId<'document-signature'>(), {
      documentId: report,
      signerName: 'Ayse Arslan',
      signedAt: new Date().toISOString(),
      deviceInfo: null,
      path: scribble,
      contentFingerprint: await fingerprintAsHeld(admin, report),
    })
    const issuing = await lockedForIssuing(report)
    const signing = transmitted([write, signature]).then((answer) => ({
      status: answer.status,
      outcomes: ((answer.body as { receipts?: { outcome: string }[] }).receipts ?? []).map(
        (receipt) => receipt.outcome,
      ),
    }))

    try {
      await waitingFor(admin, issuing, signing)
      // A logged write that leaves what the signature covers as it is.
      await issuing.query("update jobs set description = 'Zähler prüfen' where id = $1", [call.id])
      await issuing.query('commit')
    } finally {
      await issuing.query('rollback').catch(() => undefined)
      issuing.release()
      await Promise.allSettled([signing])
    }

    expect(await signing).toEqual({ status: 201, outcomes: ['applied', 'applied'] })
  })
})
