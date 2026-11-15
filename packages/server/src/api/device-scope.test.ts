import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { RoleKey, TenantId } from '@opengewerk/domain'
import { Database, newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { deviceScope, fieldsMovedAway } from '../database/device-scope.js'
import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import { ApiModule } from './api.module.js'
import { type Somebody, testIdentities as identities } from './test-identity.js'
import { changed, created, push, type Value } from './test-structure.js'

/**
 * Each device holds its part of the business, #140. A technician's device
 * gets the jobs the office put them on, with what hangs on them, and what
 * they created themselves; a closed job stays thirty days. The owner and the
 * office keep the whole business.
 */

const north = { id: newId<'tenant'>() as TenantId, name: 'Elektro Nord GmbH' }

const people = {
  britta: { name: 'Britta Büro', roles: ['office'] },
  max: { name: 'Max Monteur', roles: ['technician'] },
  toni: { name: 'Toni Techniker', roles: ['technician'] },
  gesperrt: { name: 'Gerd Gesperrt', roles: ['technician'] },
  // Past the last day of the access, without a block (opengewerk-haustechnik#339).
  beendet: { name: 'Bea Beendet', roles: ['technician'] },
  // On more jobs than one statement has parameters for each id of them.
  viele: { name: 'Vera Viele', roles: ['technician'] },
  // Who blacks out a value of the log, as a deletion does.
  olga: { name: 'Olga Owner', roles: ['owner'] },
} as const

type Person = keyof typeof people

let admin: Pool
let database: Database
let app: INestApplication

function http() {
  return request(app.getHttpServer())
}

function as(person: Person): string {
  return JSON.stringify({
    userId: person,
    tenantId: north.id,
    roles: [...people[person].roles] as RoleKey[],
  } satisfies Somebody)
}

async function post(path: string, body: Record<string, unknown>, who: Person = 'britta') {
  const answer = await http().post(path).set('x-test-identity', as(who)).send(body).expect(201)

  return String((answer.body as { id: string }).id)
}

async function assign(
  jobId: string,
  userIds: readonly string[],
  expected = 200,
  who: Person = 'britta',
) {
  const answer = await http()
    .put(`/jobs/${jobId}/assignees`)
    .set('x-test-identity', as(who))
    .send({ userIds })
    .expect(expected)

  return answer.body as { userIds?: string[]; message?: string }
}

interface Pulled {
  readonly changes: { entity: string; rows: Record<string, unknown>[] }[]
  readonly narrowed: Record<string, string>
}

async function pull(who: Person) {
  const answer = await http().get('/sync?since=0').set('x-test-identity', as(who)).expect(200)

  return answer.body as Pulled
}

/** The ids a pull brought of one entity, deleted ones left out. */
function idsOf(pulled: Pulled, entity: string): string[] {
  return (pulled.changes.find((change) => change.entity === entity)?.rows ?? [])
    .filter((row) => row['deletedAt'] === null)
    .map((row) => String(row['id']))
}

/** One customer with a site, an installation and a running job there. */
async function household(name: string) {
  const customer = await post('/customers', { kind: 'private', name })
  const site = await post('/sites', { customerId: customer, designation: `Haus ${name}` })
  const installation = await post('/installations', {
    siteId: site,
    kind: 'meter_cabinet',
    designation: 'Zählerschrank',
  })
  const job = await post('/jobs', {
    customerId: customer,
    siteId: site,
    installationId: installation,
    kind: 'service',
    status: 'active',
    designation: `Auftrag ${name}`,
  })

  return { customer, site, installation, job }
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2)', [north.id, north.name])

  for (const [userId, person] of Object.entries(people)) {
    await admin.query('insert into auth_users (id, name, email) values ($1, $2, $3)', [
      userId,
      person.name,
      `${userId}@example.de`,
    ])
    await admin.query(
      `insert into memberships (tenant_id, user_id, roles, blocked_at, last_day)
       values ($1, $2, $3, $4, case when $2 = 'beendet' then current_date - 2 end)`,
      [north.id, userId, [...person.roles], userId === 'gesperrt' ? new Date() : null],
    )
  }

  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [ApiModule.create(database, identities)],
  }).compile()

  app = built.createNestApplication()
  await app.init()
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
})

describe('the device of a technician', () => {
  it('holds the jobs its person is on, with what hangs on them, and nothing else', async () => {
    const berg = await household('Berg')
    const kramer = await household('Kramer')

    await assign(berg.job, ['max'])

    const quote = await post('/documents', {
      customerId: berg.customer,
      jobId: berg.job,
      kind: 'quote',
      documentDate: '2026-09-21',
    })
    const elsewhere = await post('/documents', {
      customerId: kramer.customer,
      jobId: kramer.job,
      kind: 'quote',
      documentDate: '2026-09-21',
    })
    const contact = await post('/contacts', { customerId: berg.customer, familyName: 'Berg' })
    const theirs = await post('/contacts', { customerId: kramer.customer, familyName: 'Kramer' })

    const pulled = await pull('max')

    expect(idsOf(pulled, 'jobs')).toContain(berg.job)
    expect(idsOf(pulled, 'jobs')).not.toContain(kramer.job)
    expect(idsOf(pulled, 'customers')).toContain(berg.customer)
    expect(idsOf(pulled, 'customers')).not.toContain(kramer.customer)
    expect(idsOf(pulled, 'sites')).toEqual([berg.site])
    expect(idsOf(pulled, 'installations')).toEqual([berg.installation])
    expect(idsOf(pulled, 'documents')).toContain(quote)
    expect(idsOf(pulled, 'documents')).not.toContain(elsewhere)
    expect(idsOf(pulled, 'contacts')).toContain(contact)
    expect(idsOf(pulled, 'contacts')).not.toContain(theirs)
    expect(pulled.narrowed['jobs']).toMatch(/^jobs:[0-9a-f]{16}$/)
    expect(pulled.narrowed['customers']).toBe(pulled.narrowed['jobs'])
  })

  it('holds the notes of the jobs its person is on (#220)', async () => {
    const berg = await household('Berg')
    const kramer = await household('Kramer')

    await assign(berg.job, ['max'])
    await assign(kramer.job, ['toni'])

    const mine = newId<'job-note'>()
    const theirs = newId<'job-note'>()
    const at = new Date().toISOString()

    await push(app, as('max'), [
      created('job_notes', mine, { jobId: berg.job, text: 'Plombe fehlt.', writtenAt: at }),
    ])
    await push(app, as('toni'), [
      created('job_notes', theirs, { jobId: kramer.job, text: 'Hund im Hof.', writtenAt: at }),
    ])

    const pulled = await pull('max')

    expect(idsOf(pulled, 'job_notes')).toContain(mine)
    expect(idsOf(pulled, 'job_notes')).not.toContain(theirs)
    expect(pulled.narrowed['job_notes']).toBe(pulled.narrowed['jobs'])
    // The office reads every note at the job it belongs to.
    expect(idsOf(await pull('britta'), 'job_notes')).toEqual(expect.arrayContaining([mine, theirs]))
  })

  it('holds the jobs its person has an appointment at, with the appointments and who goes (#290)', async () => {
    const lindner = await household('Lindner')
    const sommer = await household('Sommer')
    const appoint = async (jobId: string, userIds: readonly string[]) => {
      const answer = await http()
        .post('/appointments')
        .set('x-test-identity', as('britta'))
        .send({
          jobId,
          startsAt: '2031-11-07T06:00:00Z',
          endsAt: '2031-11-07T14:00:00Z',
          userIds,
        })
        .expect(201)

      return (answer.body as { appointment: { id: string } }).appointment.id
    }

    // Nobody put Max on the job by hand: the appointment does.
    const his = await appoint(lindner.job, ['max', 'toni'])
    const theirs = await appoint(sommer.job, ['toni'])
    const pulled = await pull('max')

    expect(idsOf(pulled, 'jobs')).toContain(lindner.job)
    expect(idsOf(pulled, 'jobs')).not.toContain(sommer.job)
    expect(idsOf(pulled, 'appointments')).toEqual([his])
    expect(
      (pulled.changes.find((change) => change.entity === 'appointment_people')?.rows ?? [])
        .map((row) => [row['appointmentId'], row['userId']])
        .sort(),
    ).toEqual([
      [his, 'max'],
      [his, 'toni'],
    ])
    expect(pulled.narrowed['appointments']).toBe(pulled.narrowed['jobs'])
    expect(idsOf(await pull('britta'), 'appointments')).toEqual(
      expect.arrayContaining([his, theirs]),
    )
  })

  it('holds a task handed to its person, wherever the task hangs', async () => {
    const kramer = await household('Kramer')
    // Tasks are written through the outbox, on site as in the office.
    const task = newId<'task'>()

    await push(app, as('britta'), [
      created('tasks', task, {
        title: 'Zählerstand ablesen',
        dueOn: '2026-09-30',
        assigneeUserId: 'max',
        status: 'open',
        customerId: kramer.customer,
        jobId: kramer.job,
      }),
    ])

    expect(idsOf(await pull('max'), 'tasks')).toContain(task)
    expect(idsOf(await pull('toni'), 'tasks')).not.toContain(task)
  })

  it('holds what its person created, before it is on any job', async () => {
    const id = newId<'customer'>()

    await push(app, as('toni'), [
      created('customers', id, { kind: 'private', name: 'Neu entdeckter Bauherr' }),
    ])

    expect(idsOf(await pull('toni'), 'customers')).toContain(id)
    expect(idsOf(await pull('max'), 'customers')).not.toContain(id)
  })

  it('keeps a closed job thirty days, and then lets it go', async () => {
    const lang = await household('Lang')

    await assign(lang.job, ['toni'])
    await http()
      .patch(`/jobs/${lang.job}`)
      .set('x-test-identity', as('britta'))
      .send({ status: 'completed' })
      .expect(200)

    const now = new Date()
    const soon = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000)
    const later = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000)
    const scopes = await database.forTenant({ tenantId: north.id }, async (tx) => ({
      today: await deviceScope(tx, 'toni', now),
      soon: await deviceScope(tx, 'toni', soon),
      later: await deviceScope(tx, 'toni', later),
    }))

    expect(scopes.today.jobIds).toContain(lang.job)
    expect(scopes.soon.jobIds).toContain(lang.job)
    expect(scopes.later.jobIds).not.toContain(lang.job)
    expect(scopes.later.value).not.toBe(scopes.today.value)
  })

  it('is narrowed to something else once its person is put on another job', async () => {
    const before = await pull('toni')
    const neu = await household('Neu')

    await assign(neu.job, ['toni'])

    const after = await pull('toni')

    expect(after.narrowed['jobs']).not.toBe(before.narrowed['jobs'])
    expect(idsOf(after, 'jobs')).toContain(neu.job)
  })
})

/** A change of fields as the office sends it, every operation applied. */
async function move(
  entity: string,
  id: string,
  fields: Record<string, { from: Value; to: Value }>,
) {
  const { receipts } = await push(app, as('britta'), [changed(entity, id, fields)])

  expect(receipts.map((receipt) => [receipt.outcome, receipt.reason])).toEqual([['applied', null]])
}

/** Records the office creates through the sync, every operation applied. */
async function make(operations: unknown[]) {
  const { receipts } = await push(app, as('britta'), operations)

  expect(receipts.map((receipt) => receipt.outcome)).toEqual(operations.map(() => 'applied'))
}

describe('the device of a technician, when something moves', () => {
  // Each key of the job by itself: its customer, its site and its
  // installation each decide what the device holds.
  it.each(['customerId', 'siteId', 'installationId'] as const)(
    'is narrowed to something else once a job of its person changes its %s (#946)',
    async (key) => {
      const weber = await household(`Weber ${key}`)
      const other = await household(`Neumann ${key}`)
      const job = await post('/jobs', {
        customerId: weber.customer,
        ...(key === 'customerId'
          ? {}
          : { [key]: weber[key === 'siteId' ? 'site' : 'installation'] }),
        kind: 'service',
        status: 'active',
        designation: `Umzug ${key}`,
      })
      const target =
        other[key === 'customerId' ? 'customer' : key === 'siteId' ? 'site' : 'installation']
      const plan = newId<'attachment'>()

      await make([created('attachments', plan, { [key]: target, title: 'Lageplan' })])
      await assign(job, ['toni'])

      const before = await pull('toni')

      expect(idsOf(before, 'attachments')).not.toContain(plan)

      await http()
        .patch(`/jobs/${job}`)
        .set('x-test-identity', as('britta'))
        .send({ [key]: target })
        .expect(200)

      const after = await pull('toni')

      expect(after.narrowed['attachments']).not.toBe(before.narrowed['attachments'])
      expect(idsOf(after, 'attachments')).toContain(plan)
    },
  )

  it('is narrowed to something else once what never moved moves away from its site (#946)', async () => {
    const schulz = await household('Schulz')
    const lager = await post('/sites', { customerId: schulz.customer, designation: 'Lager Schulz' })
    const appliance = newId<'appliance'>()

    await make([
      created('appliances', appliance, {
        siteId: schulz.site,
        inventoryNumber: '101',
        designation: 'Verlängerung',
        protectionClass: 'I',
        mobility: 'portable',
      }),
    ])
    await assign(schulz.job, ['toni'])

    const before = await pull('toni')

    expect(idsOf(before, 'appliances')).toContain(appliance)

    await move('appliances', appliance, { siteId: { from: schulz.site, to: lager } })

    const away = await pull('toni')

    expect(away.narrowed['appliances']).not.toBe(before.narrowed['appliances'])
    expect(idsOf(away, 'appliances')).not.toContain(appliance)

    // An installation that is not the one of the job goes as well.
    const keller = await post('/installations', {
      siteId: schulz.site,
      kind: 'meter_cabinet',
      designation: 'Kellerverteilung',
    })
    const held = await pull('toni')

    await move('installations', keller, { siteId: { from: schulz.site, to: lager } })

    const gone = await pull('toni')

    expect(gone.narrowed['installations']).not.toBe(held.narrowed['installations'])
    expect(idsOf(gone, 'installations')).not.toContain(keller)
  })

  it('stays narrowed as it was when something moves between sites it does not hold', async () => {
    const roth = await household('Roth')
    const fremd = await household('Fremd')
    const nebenan = await post('/sites', { customerId: fremd.customer, designation: 'Nebenan' })
    const appliance = newId<'appliance'>()
    const task = newId<'task'>()

    await make([
      created('appliances', appliance, {
        siteId: fremd.site,
        inventoryNumber: '102',
        designation: 'Leiter',
        protectionClass: 'I',
        mobility: 'portable',
      }),
      created('tasks', task, {
        title: 'Angebot nachfassen',
        dueOn: '2026-12-01',
        assigneeUserId: 'max',
        status: 'open',
        customerId: fremd.customer,
      }),
    ])
    await assign(roth.job, ['toni'])

    const before = await pull('toni')

    await move('appliances', appliance, { siteId: { from: fremd.site, to: nebenan } })
    await move('installations', fremd.installation, { siteId: { from: fremd.site, to: nebenan } })
    // A key that was empty and is set counts no more than any other.
    await move('tasks', task, { jobId: { from: null, to: fremd.job } })

    const after = await pull('toni')

    expect(after.narrowed['appliances']).toBe(before.narrowed['appliances'])
  })

  it('is narrowed to something else once a task of its person is handed to somebody else', async () => {
    const otto = await household('Otto')
    const task = newId<'task'>()

    await make([
      created('tasks', task, {
        title: 'Rückruf',
        dueOn: '2026-11-30',
        assigneeUserId: 'toni',
        status: 'open',
        customerId: otto.customer,
      }),
    ])

    const before = await pull('toni')

    expect(idsOf(before, 'tasks')).toContain(task)

    await move('tasks', task, { assigneeUserId: { from: 'toni', to: 'max' } })

    const after = await pull('toni')

    expect(after.narrowed['tasks']).not.toBe(before.narrowed['tasks'])
    expect(idsOf(after, 'tasks')).not.toContain(task)
  })

  it('is narrowed to something else once a file moves onto or away from what it holds', async () => {
    const kraus = await household('Kraus')
    const fremd = await household('Woanders')
    const here = newId<'appliance'>()
    const there = newId<'appliance'>()
    const label = newId<'attachment'>()
    const plan = newId<'attachment'>()

    await make([
      created('appliances', here, {
        siteId: kraus.site,
        inventoryNumber: '201',
        designation: 'Kabeltrommel',
        protectionClass: 'I',
        mobility: 'portable',
      }),
      created('appliances', there, {
        siteId: fremd.site,
        inventoryNumber: '202',
        designation: 'Flex',
        protectionClass: 'II',
        mobility: 'portable',
      }),
    ])
    await make([
      created('attachments', label, { applianceId: here, title: 'Typenschild' }),
      created('attachments', plan, { installationId: fremd.installation, title: 'Schaltplan' }),
    ])
    await assign(kraus.job, ['toni'])

    const before = await pull('toni')

    expect(idsOf(before, 'attachments')).toContain(label)

    await move('attachments', label, { applianceId: { from: here, to: there } })

    const away = await pull('toni')

    expect(away.narrowed['attachments']).not.toBe(before.narrowed['attachments'])
    expect(idsOf(away, 'attachments')).not.toContain(label)

    await move('attachments', plan, {
      installationId: { from: fremd.installation, to: kraus.installation },
    })

    const into = await pull('toni')

    expect(into.narrowed['attachments']).not.toBe(away.narrowed['attachments'])
    expect(idsOf(into, 'attachments')).toContain(plan)
  })

  it('is narrowed to something else once a move away is blacked out by a deletion', async () => {
    const lenz = await household('Lenz')
    const fremd = await household('Lenzfremd')
    const appliance = newId<'appliance'>()

    await make([
      created('appliances', appliance, {
        siteId: lenz.site,
        inventoryNumber: '301',
        designation: 'Staubsauger',
        protectionClass: 'II',
        mobility: 'portable',
      }),
    ])
    await assign(lenz.job, ['toni'])

    const before = await pull('toni')

    await move('appliances', appliance, { siteId: { from: lenz.site, to: fremd.site } })

    // The site it went to is deleted before the device asks again, and the
    // deletion blacks out the old value of the move with the rest.
    const { rows } = await admin.query<{ id: string }>(
      `select id from audit_entries where table_name = 'appliances' and record_id = $1
          and field = 'site_id' and operation = 'update'`,
      [appliance],
    )
    // Olga leads the business, which a redaction asks of whoever writes it.
    await admin.query(
      `insert into tenant_roles (tenant_id, key, label, rights, leads, second_factor)
       values ($1, 'owner', 'Inhaber', '{}', true, false) on conflict do nothing`,
      [north.id],
    )

    const redact = async (entryId: string | undefined, side: 'old' | 'new') => {
      const client = await admin.connect()

      try {
        await client.query('begin')
        await client.query("select set_config('app.tenant_id', $1, true)", [north.id])
        await client.query("select set_config('app.user_id', 'olga', true)")
        await client.query(
          `insert into audit_redactions (tenant_id, entry_id, side, reason, redacted_by)
           values ($1, $2, $3, 'Löschkonzept', 'olga')`,
          [north.id, entryId, side],
        )
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    await redact(rows[0]?.id, 'old')

    const after = await pull('toni')

    expect(after.narrowed['appliances']).not.toBe(before.narrowed['appliances'])
    expect(idsOf(after, 'appliances')).not.toContain(appliance)

    // The side of that redaction blacked out in its turn: the value does not
    // fall back to the one the device held before the move.
    const { rows: sides } = await admin.query<{ id: string }>(
      `select e.id from audit_entries e
         join audit_redactions r on r.id = e.record_id
        where e.table_name = 'audit_redactions' and e.field = 'side' and r.entry_id = $1`,
      [rows[0]?.id],
    )

    await redact(sides[0]?.id, 'new')

    const later = await pull('toni')

    expect(later.narrowed['appliances']).not.toBe(before.narrowed['appliances'])
  })

  it('is narrowed to something else once an inverter moves into a system it holds (#947)', async () => {
    const vogel = await household('Vogel')
    const fremd = await household('Anders')
    const system = (siteId: string) =>
      post('/installations', { siteId, kind: 'pv_system', designation: 'PV-Anlage' })
    const mine = await system(vogel.site)
    const theirs = await system(fremd.site)
    const inverter = newId<'inverter'>()
    const string = newId<'pv-string'>()

    await make([
      created('inverters', inverter, {
        installationId: theirs,
        designation: 'WR 1',
        ratedPowerW: 10_000,
        position: 0,
      }),
      created('pv_strings', string, {
        inverterId: inverter,
        designation: 'String 1',
        mppInput: 1,
        position: 0,
      }),
    ])
    await assign(vogel.job, ['toni'])

    const before = await pull('toni')

    expect(idsOf(before, 'pv_strings')).not.toContain(string)

    await move('inverters', inverter, { installationId: { from: theirs, to: mine } })

    const into = await pull('toni')

    expect(into.narrowed['pv_strings']).not.toBe(before.narrowed['pv_strings'])
    expect(idsOf(into, 'pv_strings')).toContain(string)

    // And back out: the device lets go of it again.
    await move('inverters', inverter, { installationId: { from: mine, to: theirs } })

    const out = await pull('toni')

    expect(out.narrowed['pv_strings']).not.toBe(into.narrowed['pv_strings'])
    expect(idsOf(out, 'pv_strings')).not.toContain(string)
  })

  it('is narrowed to something else once a board moves into an installation it holds (#947)', async () => {
    const kuhn = await household('Kuhn')
    const fremd = await household('Anderswo')
    const board = newId<'distribution-board'>()
    const circuit = newId<'circuit'>()

    await make([
      created('distribution_boards', board, {
        installationId: fremd.installation,
        kind: 'sub_distribution',
        designation: 'UV Garage',
        position: 0,
      }),
      created('circuits', circuit, { distributionBoardId: board, designation: 'F1' }),
    ])
    await assign(kuhn.job, ['toni'])

    const before = await pull('toni')

    expect(idsOf(before, 'circuits')).not.toContain(circuit)

    await move('distribution_boards', board, {
      installationId: { from: fremd.installation, to: kuhn.installation },
    })

    const after = await pull('toni')

    expect(after.narrowed['circuits']).not.toBe(before.narrowed['circuits'])
    expect(idsOf(after, 'circuits')).toContain(circuit)
  })
})

describe('the moves away from what a device holds', () => {
  it('are asked for a person on more jobs than a statement has parameters', async () => {
    // A business of its own, so that the jobs stay out of every other pull.
    const south = newId<'tenant'>()
    const { rows } = await admin.query<{ customer: string; site: string }>(
      `with tenant as (insert into tenants (id, name) values ($1, 'Elektro Süd GmbH') returning id),
            member as (insert into memberships (tenant_id, user_id, roles)
                       select id, 'viele', '{technician}' from tenant),
            customer as (insert into customers (tenant_id, kind, name)
                         select id, 'private', 'Familie Viele' from tenant returning id, tenant_id),
            site as (insert into sites (tenant_id, customer_id, designation)
                     select tenant_id, id, 'Haus Viele' from customer returning id)
       select customer.id as customer, site.id as site from customer, site`,
      [south],
    )

    await admin.query(
      `with made as (
         insert into jobs (tenant_id, customer_id, site_id, kind, status, designation)
         select $1, $2, $3, 'service', 'active', 'Auftrag ' || n from generate_series(1, 900) n
         returning id)
       insert into job_assignments (tenant_id, job_id, user_id)
       select $1, id, 'viele' from made`,
      [south, rows[0]?.customer, rows[0]?.site],
    )

    const answer = await http()
      .get('/sync?since=0')
      .set(
        'x-test-identity',
        JSON.stringify({
          userId: 'viele',
          tenantId: south,
          roles: ['technician'],
        } satisfies Somebody),
      )
      .expect(200)

    expect((answer.body as Pulled).narrowed['jobs']).toMatch(/^jobs:[0-9a-f]{16}/)
  })

  it('are each read through the partial index of the log', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'audit_entries_moves_idx'",
    )

    expect(rows).toHaveLength(1)

    for (const field of fieldsMovedAway()) {
      expect(rows[0]?.indexdef).toContain(`'${field}'::text`)
    }
  })
})

describe('the device of the office', () => {
  it('holds the whole business', async () => {
    const berg = await household('Berg')
    const kramer = await household('Kramer')
    const pulled = await pull('britta')

    expect(idsOf(pulled, 'jobs')).toEqual(expect.arrayContaining([berg.job, kramer.job]))
    expect(pulled.narrowed['jobs']).toBe('all')
  })
})

describe('who is on a job', () => {
  it('is set as a whole list, and a person taken off is marked, not removed', async () => {
    const job = (await household('Liste')).job

    expect(await assign(job, ['toni', 'max', 'max'])).toEqual({ userIds: ['max', 'toni'] })
    expect(await assign(job, ['max'])).toEqual({ userIds: ['max'] })

    const { rows } = await admin.query<{ user_id: string; deleted_at: Date | null }>(
      'select user_id, deleted_at from job_assignments where job_id = $1 order by user_id',
      [job],
    )

    expect(rows.map((row) => [row.user_id, row.deleted_at === null])).toEqual([
      ['max', true],
      ['toni', false],
    ])
  })

  it('is only somebody who works in the business and is not shut out', async () => {
    const job = (await household('Fremd')).job

    expect((await assign(job, ['niemand'], 422)).message).toContain('arbeitet')
    expect((await assign(job, ['gesperrt'], 422)).message).toContain('gesperrt')
    expect((await assign(job, ['beendet'], 422)).message).toContain('gesperrt')
  })

  it('is decided in the office, not on site', async () => {
    const job = (await household('Baustelle')).job

    await assign(job, ['max'], 403, 'max')
  })

  it('is asked of a job that is there', async () => {
    await assign(newId<'job'>(), ['max'], 404)
  })
})

describe('the day a job was closed', () => {
  it('is set when it is finished, kept, and emptied when it is taken up again', async () => {
    const job = (await household('Tag')).job
    const closedAt = async () =>
      (
        await admin.query<{ closed_at: Date | null }>('select closed_at from jobs where id = $1', [
          job,
        ])
      ).rows[0]?.closed_at ?? null

    expect(await closedAt()).toBeNull()

    await http()
      .patch(`/jobs/${job}`)
      .set('x-test-identity', as('britta'))
      .send({ status: 'completed' })
      .expect(200)

    const first = await closedAt()

    expect(first).toBeInstanceOf(Date)

    // Written by hand, it stays what the status made it.
    await admin.query("update jobs set closed_at = '2020-01-01' where id = $1", [job])
    expect((await closedAt())?.getTime()).toBe(first?.getTime())

    await http()
      .patch(`/jobs/${job}`)
      .set('x-test-identity', as('britta'))
      .send({ status: 'active' })
      .expect(200)

    expect(await closedAt()).toBeNull()
  })
})
