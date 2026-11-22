import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  type CustomerId,
  type DeadlineKind,
  deadlineRegistry,
  type InstallationId,
  type IsoDate,
  type SiteId,
  type TenantId,
} from '@opengewerk/domain'
import { Database, type ExpectedDeadline, newId } from '@opengewerk/platform-server'
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ApiModule } from '../api/api.module.js'
import { as, testIdentities as identities } from '../api/test-identity.js'
import { readyToInvoice } from '../api/test-invoice.js'
import {
  applicationDatabaseUrl,
  connect,
  resetToMigrated,
  shipRoles,
} from '../database/test-database.js'
import { type DeadlineJob, runDeadlinesOf } from '../deadlines/engine.js'
import { deadlineKinds } from '../deadlines/registry.js'
import type { DeadlineValues } from '../deadlines/sources.js'
import { mailOutbox } from '../database/schema/index.js'
import {
  deletedCustomerMail,
  lapsedReminderMail,
  refuseWithheldCustomerMail,
} from '../mail/attachments.js'
import { callNotes } from './customer-reminder.js'

/**
 * The reminders of a due inspection to the customer (#316, decided on
 * 27.09.2026): by mail where the customer has an address, as a task to call
 * where they have none and a call is allowed, once per due day; with a
 * contract always, without one only with a consent or for a customer of the
 * business under § 7 Abs. 3 UWG, who is never called; never to a customer
 * who stopped them; and nothing before the business switches them on.
 *
 * The sources are the test's own, so that the deadlines are exactly the ones
 * each test names; the kinds and the action are the real ones.
 */

const north = newId<'tenant'>() as TenantId
const now = new Date('2037-09-24T07:00:00Z')
const dueOn = '2037-10-24' as IsoDate

let admin: Pool
let database: Database
let app: INestApplication
let site = ''
let workshop = ''
const customers: Record<string, string> = {}
const installations: Record<string, string> = {}

const inspection = deadlineKinds.kind('elektro.recurring_inspection') as DeadlineKind
const appliances = deadlineKinds.kind('elektro.appliance_inspection') as DeadlineKind

/** The deadlines each source has right now, set by each test. */
let due: {
  inspection: ExpectedDeadline<DeadlineValues>[]
  appliances: ExpectedDeadline<DeadlineValues>[]
}

function engine(): DeadlineJob {
  return {
    database,
    registry: deadlineRegistry([inspection, appliances]),
    sources: {
      inspection: () => Promise.resolve(due.inspection),
      appliance_inspection: () => Promise.resolve(due.appliances),
    },
  }
}

function inspectionOf(who: string, label = `Elektroinstallation von ${who}`) {
  return {
    sourceId: installations[who] ?? '',
    sourceLabel: `${label} am Objekt Rheinstraße 12`,
    anchorOn: '2033-10-24' as IsoDate,
    namedDueOn: dueOn,
    naturalUserId: 'max',
    values: {
      documentId: null,
      installationId: (installations[who] ?? null) as InstallationId | null,
      customerId: (customers[who] ?? null) as CustomerId | null,
      siteId: site as SiteId,
      jobId: null,
    },
  }
}

function applianceOf(who: string, number: string) {
  return {
    sourceId: newIdFor(number),
    sourceLabel: `${number} Kaffeemaschine am Objekt Werkstatt`,
    anchorOn: '2036-10-24' as IsoDate,
    namedDueOn: dueOn,
    naturalUserId: 'max',
    values: {
      documentId: null,
      installationId: null,
      customerId: (customers[who] ?? null) as CustomerId | null,
      siteId: workshop as SiteId,
      jobId: null,
    },
  }
}

const applianceIds = new Map<string, string>()

function newIdFor(number: string): string {
  const known = applianceIds.get(number) ?? newId<'appliance'>()

  applianceIds.set(number, known)

  return known
}

async function switchOn() {
  await admin.query(
    `insert into tenant_parameters (tenant_id, key, valid_from, unit, value)
       values ($1, 'customer_reminder.mail', '2037-01-01', 'flag', 1)`,
    [north],
  )
}

async function mails() {
  const { rows } = await admin.query<{
    recipient_address: string
    subject: string
    body: string
    cause: string
    customer_id: string | null
  }>(
    `select recipient_address, subject, body, cause, customer_id from mail_outbox where kind = 'customer_reminder' order by recipient_address`,
  )

  return rows
}

async function calls() {
  const { rows } = await admin.query<{
    title: string
    assignee_user_id: string
    due_on: string
    customer_id: string
  }>(
    `select title, assignee_user_id, to_char(due_on, 'YYYY-MM-DD') as due_on, customer_id
       from tasks where notes = $1 order by title`,
    [callNotes],
  )

  return rows
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2)', [north, 'Elektro Nord GmbH'])
  await shipRoles(admin, north)
  await readyToInvoice(admin, north)

  for (const [userId, name, roles] of [
    ['olga', 'Olga Inhaberin', ['owner']],
    ['max', 'Max Monteur', ['technician']],
  ] as const) {
    await admin.query('insert into auth_users (id, name, email) values ($1, $2, $3)', [
      userId,
      name,
      `${userId}@example.de`,
    ])
    await admin.query('insert into memberships (tenant_id, user_id, roles) values ($1, $2, $3)', [
      north,
      userId,
      [...roles],
    ])
  }

  // Who may be reminded, and how they can be reached.
  // The last column: the notice on the objection confirmed (#1026). `hoffmann`
  // is a customer of the business stored as one before the office was asked,
  // as every one is after the migration.
  const people: [string, string | null, string | null, string | null, boolean | string][] = [
    ['lehmann', 'klaus.lehmann@example.com', 'existing_customer', '2024-03-12', true],
    ['ohne', 'ohne@example.com', null, null, false],
    ['becker', null, 'consent', '2025-05-02', false],
    ['baeckerei', null, 'existing_customer', '2024-03-12', true],
    ['abbestellt', 'abbestellt@example.com', 'objected', '2026-11-02', false],
    ['vertrag', 'vertrag@example.com', null, null, false],
    ['vertragstelefon', null, null, null, false],
    ['einwilligung', 'einwilligung@example.com', 'consent', '2025-05-02', false],
    ['vertragende', 'vertragende@example.com', null, null, false],
    ['hoffmann', 'hoffmann@example.com', 'existing_customer', '2024-03-12', false],
    // Confirmed for the address the customer had before (#1026).
    [
      'umgezogen',
      'umgezogen@example.com',
      'existing_customer',
      '2024-03-12',
      'alt.umgezogen@example.com',
    ],
  ]

  for (const [who, email, ground, since, confirmed] of people) {
    customers[who] = newId<'customer'>()
    await admin.query(
      `insert into customers (id, tenant_id, kind, name, email, reminder_ground, reminder_ground_on,
         objection_notice_address)
       values ($1, $2, 'private', $3, $4, $5, $6, $7)`,
      [
        customers[who],
        north,
        `Kunde ${who}`,
        email,
        ground,
        since,
        typeof confirmed === 'string' ? confirmed : confirmed ? email : null,
      ],
    )
  }

  site = newId<'site'>()
  workshop = newId<'site'>()
  await admin.query(
    `insert into sites (id, tenant_id, customer_id, designation) values ($1, $3, $4, 'Rheinstraße 12'), ($2, $3, $4, 'Werkstatt')`,
    [site, workshop, north, customers['becker']],
  )

  for (const who of Object.keys(customers)) {
    installations[who] = newId<'installation'>()
    await admin.query(
      `insert into installations (id, tenant_id, site_id, kind, designation) values ($1, $2, $3, 'meter_cabinet', $4)`,
      [installations[who], north, site, `Elektroinstallation von ${who}`],
    )
  }

  // The contracts: one that covers the installation and runs past the due
  // day, one of a customer who stopped all reminders.
  for (const who of ['vertrag', 'vertragstelefon', 'abbestellt', 'vertragende']) {
    const quote = newId<'document'>()

    await admin.query(
      `insert into documents (id, tenant_id, customer_id, kind, status, number, document_date, issued_at, issued_by, subject)
       values ($1, $2, $3, 'quote', 'issued', $4, '2036-12-01', now(), 'olga', 'Wartung')`,
      [quote, north, customers[who], `AN-${who}`],
    )
    await admin.query(
      `insert into maintenance_contracts
         (tenant_id, customer_id, site_id, quote_id, number, designation, installation_ids, starts_on, first_visit_on,
          interval_months, term_months, renewal, notice_months, price_kind, flat_cents)
       values ($1, $2, $3, $4, $5, 'Wartung', array[$6]::uuid[], '2037-01-01', '2037-06-01', 12, 24, 'none', 0, 'flat', 3900)`,
      [north, customers[who], site, quote, `WV-2037-${who}`, installations[who]],
    )
  }
  // Cancelled to the end of September, a month before the inspection is due.
  await admin.query(
    `update maintenance_contracts set cancelled_on = '2037-06-01', ends_on = '2037-09-30' where number = 'WV-2037-vertragende'`,
  )

  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [ApiModule.create(database, identities)],
  }).compile()

  app = built.createNestApplication()
  await app.init()
})

beforeEach(async () => {
  await admin.query('delete from mail_outbox')
  await admin.query('delete from deadlines')
  await admin.query('delete from tasks')
  await admin.query('delete from tenant_parameters')
  due = { inspection: [], appliances: [] }
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
})

/**
 * A reminder that waits in the outbox goes only while its ground holds
 * (#1026, CodeRabbit): the worker asks as it leaves, so that one written
 * before the confirmation was taken away, or before the update that asked
 * for it, stays unsent with the reason, and so does one to a customer who
 * objected since. One of a contract goes on its contract.
 */
describe('a reminder that waits to go out', () => {
  async function waiting(who: string) {
    const [row] = await database.forTenant({ tenantId: north, reason: 'mail' }, (tx) =>
      tx
        .select()
        .from(mailOutbox)
        .where(eq(mailOutbox.customerId, (customers[who] ?? '') as CustomerId)),
    )

    if (!row) {
      throw new Error(`no reminder to ${who}`)
    }

    return row
  }

  async function stored(who: string, ground: string | null, confirmed: boolean) {
    // A ground has its day and none has none.
    await admin.query(
      `update customers
          set reminder_ground = $2,
              reminder_ground_on = case when $4::text is null then null
                                        else coalesce(reminder_ground_on, date '2037-09-01') end,
              objection_notice_address = case when $3::boolean then email end
        where id = $1`,
      [customers[who], ground, confirmed, ground],
    )
  }

  it('stays unsent once its ground no longer holds', async () => {
    await switchOn()
    due.inspection = [inspectionOf('lehmann'), inspectionOf('vertrag')]

    await runDeadlinesOf(engine(), north, now)

    const { rows: covered } = await admin.query<{ installations: string[] }>(
      `select installation_ids::text[] as installations from maintenance_contracts
        where number = 'WV-2037-vertrag'`,
    )

    try {
      await expect(refuseWithheldCustomerMail(database, await waiting('lehmann'))).resolves.toBe(
        undefined,
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('vertrag'))).resolves.toBe(
        undefined,
      )

      await stored('lehmann', 'existing_customer', false)
      await expect(refuseWithheldCustomerMail(database, await waiting('lehmann'))).rejects.toThrow(
        lapsedReminderMail,
      )

      await stored('vertrag', 'objected', false)
      await expect(refuseWithheldCustomerMail(database, await waiting('vertrag'))).rejects.toThrow(
        lapsedReminderMail,
      )

      // Confirmed again, and the address only spelled otherwise since: that
      // is still the address the reminder was written to (the review).
      await stored('lehmann', 'existing_customer', true)
      await admin.query(`update customers set email = 'Klaus.Lehmann@example.com' where id = $1`, [
        customers['lehmann'],
      ])
      await expect(refuseWithheldCustomerMail(database, await waiting('lehmann'))).resolves.toBe(
        undefined,
      )

      // Confirmed again, but for another address: the waiting reminder was
      // written to the one the customer had (CodeRabbit). The confirmation
      // holds for the new address, so only the address refuses it.
      await stored('lehmann', 'existing_customer', true)
      await admin.query(
        `update customers set email = 'neu.lehmann@example.com',
            objection_notice_address = 'neu.lehmann@example.com'
          where id = $1`,
        [customers['lehmann']],
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('lehmann'))).rejects.toThrow(
        lapsedReminderMail,
      )

      // A customer deleted since the reminder was written, with the address
      // it went to.
      await admin.query(
        `update customers set email = 'klaus.lehmann@example.com', deleted_at = now() where id = $1`,
        [customers['lehmann']],
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('lehmann'))).rejects.toThrow(
        deletedCustomerMail,
      )

      // A contract given notice before the day the reminder is about.
      await stored('vertrag', null, false)
      await admin.query(
        `update maintenance_contracts set cancelled_on = '2037-06-01', ends_on = '2037-09-30'
          where number = 'WV-2037-vertrag'`,
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('vertrag'))).rejects.toThrow(
        lapsedReminderMail,
      )

      // A contract that begins only after the day the reminder is about,
      // which a new run would not count either (#1056).
      await admin.query(
        `update maintenance_contracts set cancelled_on = null, ends_on = null,
            starts_on = '2037-11-01', first_visit_on = '2037-11-01'
          where number = 'WV-2037-vertrag'`,
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('vertrag'))).rejects.toThrow(
        lapsedReminderMail,
      )

      // The installation taken out of the contract since, which a new run
      // would not remind of either (the review).
      await admin.query(
        `update maintenance_contracts set cancelled_on = null, ends_on = null,
            starts_on = '2037-01-01', first_visit_on = '2037-06-01',
            installation_ids = array[$1]::uuid[]
          where number = 'WV-2037-vertrag'`,
        [installations['lehmann']],
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('vertrag'))).rejects.toThrow(
        lapsedReminderMail,
      )

      // The maintenance of a contract rests on the contract itself, whatever
      // installations it covers now, as `contractOf` asks (the review): the
      // deadline of the reminder made one of the maintenance of WV-2037-vertrag.
      const contractCause = (await waiting('vertrag')).cause
      await admin.query(
        `update deadlines set kind = 'maintenance.visit',
            source_id = (select id from maintenance_contracts where number = 'WV-2037-vertrag')
          where id = $1`,
        [contractCause.split(':')[3]],
      )
      await expect(refuseWithheldCustomerMail(database, await waiting('vertrag'))).resolves.toBe(
        undefined,
      )
    } finally {
      // The address first: the confirmation is set for the address it finds.
      await admin.query(
        `update customers set email = 'klaus.lehmann@example.com', deleted_at = null where id = $1`,
        [customers['lehmann']],
      )
      await stored('lehmann', 'existing_customer', true)
      await stored('vertrag', null, false)
      await admin.query(
        `update maintenance_contracts set cancelled_on = null, ends_on = null,
            starts_on = '2037-01-01', first_visit_on = '2037-06-01',
            installation_ids = $1::uuid[]
          where number = 'WV-2037-vertrag'`,
        [covered[0]?.installations ?? []],
      )
    }
  })
})

describe('a reminder of a due inspection to the customer', () => {
  it('goes out once, by mail, to a customer of the business, naming the right to object', async () => {
    await switchOn()
    due.inspection = [inspectionOf('lehmann')]

    await runDeadlinesOf(engine(), north, now)
    await runDeadlinesOf(engine(), north, now)

    const sent = await mails()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.recipient_address).toBe('klaus.lehmann@example.com')
    // Whose it is, for the deletion of the customer and the pass that sends it.
    expect(sent[0]?.customer_id).toBe(customers['lehmann'])
    expect(sent[0]?.subject).toBe(
      'Fällig am 24.10.2037: Wiederholungsprüfung der Anlage Elektroinstallation von lehmann am Objekt Rheinstraße 12',
    )
    expect(sent[0]?.body).toContain('Guten Tag Kunde lehmann,')
    expect(sent[0]?.body).toContain('jederzeit widersprechen')
    expect(sent[0]?.body).toContain('Basistarifen')
  })

  it('needs the switch of the business', async () => {
    due.inspection = [inspectionOf('lehmann'), inspectionOf('becker')]

    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
    expect(await calls()).toEqual([])
  })

  it('goes to nobody without a contract and without a ground', async () => {
    await switchOn()
    due.inspection = [inspectionOf('ohne')]

    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
    expect(await calls()).toEqual([])
  })

  it('is a task to call where there is no address and a consent, due today, for the person of the deadline', async () => {
    await switchOn()
    due.inspection = [inspectionOf('becker')]

    await runDeadlinesOf(engine(), north, now)
    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
    expect(await calls()).toEqual([
      {
        title:
          'Kunden anrufen: Wiederholungsprüfung der Anlage Elektroinstallation von becker am Objekt Rheinstraße 12, fällig am 24.10.2037',
        assignee_user_id: 'max',
        due_on: '2037-09-24',
        customer_id: customers['becker'],
      },
    ])
  })

  /**
   * § 7 Abs. 3 Nr. 4 UWG wants the notice on the objection given when the
   * address was collected. A customer of the business without the office's
   * confirmation of it, as every one stored before the question, gets nothing
   * (#1026); `lehmann` above has it and gets the mail.
   */
  it('goes to a customer of the business only with the notice at the collection confirmed', async () => {
    await switchOn()
    // Not confirmed, and confirmed for an address the customer no longer has.
    due.inspection = [inspectionOf('hoffmann'), inspectionOf('umgezogen')]

    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
    expect(await calls()).toEqual([])
  })

  it('calls a customer of the business under § 7 Abs. 3 UWG never, since it covers mail alone', async () => {
    await switchOn()
    due.inspection = [inspectionOf('baeckerei')]

    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
    expect(await calls()).toEqual([])
  })

  it('belongs to a contract that covers the installation, by mail or by a call', async () => {
    await switchOn()
    due.inspection = [inspectionOf('vertrag'), inspectionOf('vertragstelefon')]

    await runDeadlinesOf(engine(), north, now)

    const sent = await mails()

    expect(sent.map((mail) => mail.recipient_address)).toEqual(['vertrag@example.com'])
    expect(sent[0]?.body).toContain(
      'Diese Erinnerung gehört zu Ihrem Wartungsvertrag WV-2037-vertrag.',
    )
    expect((await calls()).map((call) => call.customer_id)).toEqual([customers['vertragstelefon']])
  })

  it('belongs to no contract that ends before the inspection is due', async () => {
    await switchOn()
    due.inspection = [inspectionOf('vertragende')]

    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
  })

  /** Nor to one that begins only after it (#1056), which does not cover it yet. */
  it('belongs to no contract that begins after the inspection is due', async () => {
    await switchOn()
    due.inspection = [inspectionOf('vertrag')]
    await admin.query(
      `update maintenance_contracts set starts_on = '2037-11-01', first_visit_on = '2037-11-01'
        where number = 'WV-2037-vertrag'`,
    )

    try {
      await runDeadlinesOf(engine(), north, now)

      expect(await mails()).toEqual([])
    } finally {
      await admin.query(
        `update maintenance_contracts set starts_on = '2037-01-01', first_visit_on = '2037-06-01'
          where number = 'WV-2037-vertrag'`,
      )
    }
  })

  it('stops for a customer who stopped them, a contract and all', async () => {
    await switchOn()
    due.inspection = [inspectionOf('abbestellt')]

    await runDeadlinesOf(engine(), north, now)

    expect(await mails()).toEqual([])
    expect(await calls()).toEqual([])
  })

  it('names the withdrawal of a consent', async () => {
    await switchOn()
    due.inspection = [inspectionOf('einwilligung')]

    await runDeadlinesOf(engine(), north, now)

    expect((await mails())[0]?.body).toContain('Einwilligung jederzeit widerrufen')
  })

  it('is one for the appliances of a site due the same day, by mail and by a call', async () => {
    await switchOn()
    due.appliances = [
      applianceOf('einwilligung', '001'),
      applianceOf('einwilligung', '002'),
      applianceOf('becker', '003'),
      applianceOf('becker', '004'),
    ]

    await runDeadlinesOf(engine(), north, now)

    const sent = await mails()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(
      'Fällig am 24.10.2037: Prüfung der Geräte nach DGUV Vorschrift 3 am Objekt Werkstatt',
    )
    expect(await calls()).toHaveLength(1)
  })
})

describe('the ground of a customer at its route', () => {
  const send = (method: 'post' | 'patch', path: string, body: object) =>
    request(app.getHttpServer())
      [method](path)
      .set('x-test-identity', as(north, 'office'))
      .send(body)

  it('comes with its day, or not at all', async () => {
    const refused = await send('post', '/customers', {
      kind: 'private',
      name: 'Familie Gruber',
      reminderGround: 'consent',
    }).expect(422)

    expect((refused.body as { message: string }).message).toBe(
      'Zur Grundlage für Erinnerungen gehört der Tag, seit dem sie gilt.',
    )

    const made = await send('post', '/customers', {
      kind: 'private',
      name: 'Familie Gruber',
      reminderGround: 'consent',
      reminderGroundOn: '2025-05-02',
    }).expect(201)
    const id = String((made.body as { id: string }).id)

    // The day alone, as the office sends a change of it: checked against the
    // ground the customer holds (#1026, the review).
    await send('patch', `/customers/${id}`, { reminderGroundOn: '2025-06-01' }).expect(200)
    await send('patch', `/customers/${id}`, {
      reminderGround: 'newsletter',
      reminderGroundOn: '2025-06-01',
    }).expect(422)
    await send('patch', `/customers/${id}`, {
      reminderGround: 'objected',
      reminderGroundOn: '2026-11-02',
    }).expect(200)

    const { rows } = await admin.query<{ reminder_ground: string; on: string }>(
      `select reminder_ground, to_char(reminder_ground_on, 'YYYY-MM-DD') as on from customers where id = $1`,
      [id],
    )

    expect(rows[0]).toEqual({ reminder_ground: 'objected', on: '2026-11-02' })
  })

  /**
   * The confirmation that the notice on the objection was given when the
   * address was collected (#1026) belongs to a customer of § 7 Abs. 3 UWG
   * alone: such a customer is stored without it and counts as none, another
   * ground takes it away, and a write of the ground without it, as a form of
   * the version before sends, leaves it.
   */
  it('keeps the confirmation of the notice with a customer of the business alone', async () => {
    const made = await send('post', '/customers', {
      kind: 'private',
      name: 'Familie Gruber',
      email: 'gruber@example.com',
      reminderGround: 'existing_customer',
      reminderGroundOn: '2024-03-12',
    }).expect(201)
    const id = String((made.body as { id: string }).id)
    const confirmed = async () =>
      (
        await admin.query<{ confirmed: boolean }>(
          `select coalesce(objection_notice_address = email, false) as confirmed
             from customers where id = $1`,
          [id],
        )
      ).rows[0]?.confirmed
    const ground = { reminderGround: 'existing_customer', reminderGroundOn: '2024-03-12' }

    expect(await confirmed()).toBe(false)

    await send('patch', `/customers/${id}`, {
      ...ground,
      objectionNoticeAddress: 'gruber@example.com',
    }).expect(200)
    expect(await confirmed()).toBe(true)

    await send('patch', `/customers/${id}`, ground).expect(200)
    expect(await confirmed()).toBe(true)

    await send('patch', `/customers/${id}`, {
      reminderGround: 'consent',
      reminderGroundOn: '2025-05-02',
      objectionNoticeAddress: 'gruber@example.com',
    }).expect(422)
    await send('patch', `/customers/${id}`, {
      reminderGround: 'consent',
      reminderGroundOn: '2025-05-02',
    }).expect(200)
    expect(await confirmed()).toBe(false)
  })

  /**
   * The office sends only what changed (`writeDirectly`): the confirmation
   * alone, the day alone. Both are checked against the ground the customer
   * holds (#1026, the review): the confirmation goes with a customer of the
   * business, the day with any ground, and neither without one. The
   * confirmation names the address: a new one written alone, as a client
   * that does not know the field writes it, takes it away, also for the way
   * back to the old address, and one for another address than the
   * customer's is refused.
   */
  it('takes the confirmation and the day alone, checked against the stored ground', async () => {
    const created = async (body: Record<string, unknown>) =>
      String(
        (
          (await send('post', '/customers', { kind: 'private', ...body }).expect(201)).body as {
            id: string
          }
        ).id,
      )
    const stored = async (id: string) =>
      (
        await admin.query<{ confirmed: boolean; on: string | null }>(
          `select coalesce(objection_notice_address = email, false) as confirmed,
                  to_char(reminder_ground_on, 'YYYY-MM-DD') as on
             from customers where id = $1`,
          [id],
        )
      ).rows[0]
    const albers = await created({
      name: 'Familie Albers',
      email: 'albers@example.com',
      reminderGround: 'existing_customer',
      reminderGroundOn: '2024-03-12',
    })

    await send('patch', `/customers/${albers}`, {
      objectionNoticeAddress: 'albers@example.com',
    }).expect(200)
    expect(await stored(albers)).toEqual({ confirmed: true, on: '2024-03-12' })

    await send('patch', `/customers/${albers}`, { reminderGroundOn: '2024-04-02' }).expect(200)
    expect(await stored(albers)).toEqual({ confirmed: true, on: '2024-04-02' })

    await send('patch', `/customers/${albers}`, { email: 'neu.albers@example.com' }).expect(200)
    expect(await stored(albers)).toEqual({ confirmed: false, on: '2024-04-02' })

    // The new address took the confirmation for the old one away, so going
    // back to the old address does not make it hold again (CodeRabbit).
    await send('patch', `/customers/${albers}`, { email: 'albers@example.com' }).expect(200)
    expect(await stored(albers)).toEqual({ confirmed: false, on: '2024-04-02' })
    await send('patch', `/customers/${albers}`, { email: 'neu.albers@example.com' }).expect(200)

    await send('patch', `/customers/${albers}`, {
      objectionNoticeAddress: 'albers@example.com',
    }).expect(422)
    await send('patch', `/customers/${albers}`, {
      objectionNoticeAddress: 'neu.albers@example.com',
    }).expect(200)
    expect(await stored(albers)).toEqual({ confirmed: true, on: '2024-04-02' })

    // An address that is no text is refused with the sentence, not with an
    // error of the server (the review).
    for (const email of [5, ['neu.albers@example.com']]) {
      const refused = await send('patch', `/customers/${albers}`, {
        email,
        objectionNoticeAddress: 'neu.albers@example.com',
      }).expect(422)

      expect(JSON.stringify(refused.body)).toContain('für die E-Mail-Adresse des Kunden bestätigt')
    }

    // A confirmation that held for the stored address neither, as a device
    // can create a customer with one, goes with the next address as well,
    // also when that is the one it names (CodeRabbit).
    const vogt = await created({
      name: 'Familie Vogt',
      email: 'b.vogt@example.com',
      reminderGround: 'existing_customer',
      reminderGroundOn: '2024-03-12',
    })

    await admin.query(
      `update customers set objection_notice_address = 'a.vogt@example.com' where id = $1`,
      [vogt],
    )
    await send('patch', `/customers/${vogt}`, { email: 'a.vogt@example.com' }).expect(200)
    expect(await stored(vogt)).toEqual({ confirmed: false, on: '2024-03-12' })

    const becker = await created({
      name: 'Schreinerei Becker',
      reminderGround: 'consent',
      reminderGroundOn: '2025-05-02',
    })

    await send('patch', `/customers/${becker}`, {
      email: 'becker@example.com',
      objectionNoticeAddress: 'becker@example.com',
    }).expect(422)
    expect(await stored(becker)).toEqual({ confirmed: false, on: '2025-05-02' })

    const ohne = await created({ name: 'Familie Ohne' })

    await send('patch', `/customers/${ohne}`, { reminderGroundOn: '2025-05-02' }).expect(422)
    await send('patch', `/customers/${ohne}`, {
      email: 'ohne@example.com',
      objectionNoticeAddress: 'ohne@example.com',
    }).expect(422)
    expect(await stored(ohne)).toEqual({ confirmed: false, on: null })
  })
})
