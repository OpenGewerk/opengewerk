import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { berlinClock, instructionsSentence, type TenantId } from '@opengewerk/domain'
import {
  Database,
  FileStore,
  type MailTransport,
  newId,
  type OutgoingMail,
  type Renderer,
  UploadLimits,
} from '@opengewerk/platform-server'
import { aMailServer, testKey } from '@opengewerk/platform-server/testing'
import { Client, type Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import {
  mailAttachments,
  reassignedCustomerMail,
  restrictedCustomerMail,
} from '../mail/attachments.js'
import { runMailCycle } from '../mail/worker.js'
import { ApiModule } from './api.module.js'
import { DocumentFiles } from './document-files.js'
import { as, testIdentities as identities } from './test-identity.js'
import { invoiceable, readyToInvoice } from './test-invoice.js'

/**
 * The confirmations to a customer (#315): an appointment of their job
 * arranged, moved and cancelled, each with its calendar file, and a service
 * call the office took, with the instructions for a consumer. Each switched
 * on by the business, each with the business's text for its occasion or the
 * shipped one.
 */

const north = { id: newId<'tenant'>() as TenantId, name: 'Elektro Nord GmbH' }

let admin: Pool
let database: Database
let app: INestApplication
let files: DocumentFiles
let storageRoot = ''

const standIn: Renderer = () => Promise.resolve(new TextEncoder().encode('%PDF-1.7'))
const office = () => as(north.id, 'office')
const owner = () => as(north.id, 'owner')

/** A Friday and the Monday after, far enough ahead to stay to come. */
const friday = { startsAt: '2031-11-07T06:00:00.000Z', endsAt: '2031-11-07T14:00:00.000Z' }
const monday = { startsAt: '2031-11-10T06:00:00.000Z', endsAt: '2031-11-10T14:00:00.000Z' }

function http() {
  return request(app.getHttpServer())
}

async function send(
  method: 'post' | 'put' | 'delete' | 'get',
  path: string,
  body: Record<string, unknown> | null = null,
  who = office(),
  status = method === 'post' ? 201 : method === 'delete' ? 204 : 200,
) {
  const call = http()[method](path).set('x-test-identity', who)
  const answer = await (body ? call.send(body) : call).expect(status)

  return answer.body as Record<string, unknown>
}

function recording() {
  const sent: OutgoingMail[] = []
  const transport: MailTransport = {
    send: (mail) => {
      sent.push(mail)

      return Promise.resolve()
    },
    verify: () => Promise.resolve(),
    close: () => undefined,
  }

  return { sent, transport }
}

/** The customers the mails about a record keep, one for each mail. */
async function customersOfMails(column: 'appointment_id' | 'job_id', id: string) {
  const { rows } = await admin.query<{ customer_id: string | null }>(
    `select customer_id from mail_outbox where ${column} = $1 order by created_at`,
    [id],
  )

  return [...new Set(rows.map((row) => row.customer_id))]
}

async function cycle() {
  const { sent, transport } = recording()

  await runMailCycle({
    database,
    connect: () => transport,
    key: testKey,
    origin: 'https://opengewerk.example.de',
    // The chain a running instance gives its worker.
    attachments: mailAttachments(files, database),
    now: () => new Date(Date.now() + 1_000),
  })

  return sent
}

function calendarOf(mail: OutgoingMail | undefined) {
  const file = mail?.attachments?.find((attachment) => attachment.filename === 'Termin.ics')

  return file ? new TextDecoder().decode(file.content).replaceAll('\r\n ', '') : null
}

async function switchOn(key: string) {
  await send(
    'post',
    '/settings/parameters',
    { key, from: berlinClock(new Date()).day, value: 1 },
    owner(),
  )
}

async function aCustomer(fields: Record<string, unknown> = {}) {
  return String(
    (
      await send('post', '/customers', {
        kind: 'private',
        name: 'Familie Arslan',
        email: 'arslan@example.de',
        ...invoiceable,
        ...fields,
      })
    )['id'],
  )
}

async function aJob(customerId: string, kind = 'project') {
  return String(
    (await send('post', '/jobs', { customerId, kind, designation: 'Heizung ohne Strom' }))['id'],
  )
}

async function anAppointment(jobId: string) {
  const view = await send('post', '/appointments', {
    jobId,
    ...friday,
    note: null,
    rrule: null,
    exdates: [],
    userIds: ['jonas'],
  })

  return (view['appointment'] as { id: string; version: number }) ?? { id: '', version: 0 }
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2)', [north.id, north.name])
  await readyToInvoice(admin, north.id)
  await aMailServer(admin, north.id, { from: 'info@nord.example.de' })
  // Whoever goes to the appointments.
  await admin.query(
    "insert into auth_users (id, name, email) values ('jonas', 'Jonas Brandt', 'jonas@nord.example.de')",
  )
  await admin.query(
    "insert into memberships (tenant_id, user_id, roles) values ($1, 'jonas', '{technician}')",
    [north.id],
  )

  storageRoot = mkdtempSync(join(tmpdir(), 'opengewerk-confirmations-'))
  database = Database.connect(applicationDatabaseUrl())

  const store = new FileStore(storageRoot)

  files = new DocumentFiles(database, store, standIn, new UploadLimits(store))

  const built = await Test.createTestingModule({
    imports: [
      ApiModule.create(database, identities, {
        files: store,
        renderer: standIn,
        mail: {
          origin: 'https://opengewerk.example.de',
          key: testKey,
          connect: () => recording().transport,
        },
      }),
    ],
  }).compile()

  app = built.createNestApplication()
  await app.init()
})

beforeEach(async () => {
  // What earlier tests left waiting is taken off the queue, marked and not
  // deleted: the rows tell the job what was confirmed already.
  await admin.query(
    "update mail_outbox set status = 'sent', sent_at = now() where status = 'pending'",
  )
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
  rmSync(storageRoot, { recursive: true, force: true })
})

describe('the confirmations while switched off', () => {
  it('send nothing, about an appointment nor about a service call', async () => {
    const customer = await aCustomer()
    const made = [await aJob(customer), await aJob(customer, 'service')]

    await anAppointment(made[0] ?? '')

    expect(await cycle()).toEqual([])

    // A switch holds from a day on: switched on today, it would confirm these
    // too, which the tests below do not count on.
    for (const job of made) {
      await send('delete', `/jobs/${job}`, null, office(), 200)
    }
  })
})

describe('a confirmation of an appointment (#315)', () => {
  beforeAll(async () => {
    await switchOn('appointment.mail_to_customer')
  })

  it('goes out when arranged, moved and cancelled, each with its calendar file', async () => {
    const customerId = await aCustomer()
    const job = await aJob(customerId)
    const made = await anAppointment(job)
    const arranged = await cycle()

    // Whose it is, for the deletion of the customer and the pass that sends it.
    expect(await customersOfMails('appointment_id', made.id)).toEqual([customerId])

    expect(arranged.map((mail) => [mail.to, mail.subject])).toEqual([
      [
        { name: 'Familie Arslan', address: 'arslan@example.de' },
        'Ihr Termin am Freitag, 07.11.2031, 07:00 bis 15:00 Uhr',
      ],
    ])
    expect(calendarOf(arranged[0])).toContain('METHOD:REQUEST\r\n')
    expect(calendarOf(arranged[0])).toContain('SEQUENCE:0\r\n')
    expect(calendarOf(arranged[0])).toContain(`UID:${made.id}@opengewerk\r\n`)

    const moved = (await send('put', `/appointments/${made.id}`, {
      jobId: job,
      ...monday,
      note: null,
      rrule: null,
      exdates: [],
      userIds: ['jonas'],
      version: made.version,
    })) as { appointment: { version: number } }
    const afterMove = await cycle()

    expect(afterMove.map((mail) => mail.subject)).toEqual([
      'Ihr Termin ist verschoben: Montag, 10.11.2031, 07:00 bis 15:00 Uhr',
    ])
    expect(calendarOf(afterMove[0])).toContain('SEQUENCE:1\r\n')

    await send('delete', `/appointments/${made.id}?version=${String(moved.appointment.version)}`)

    const afterCancel = await cycle()

    expect(afterCancel.map((mail) => mail.subject)).toEqual([
      'Ihr Termin am Montag, 10.11.2031, 07:00 bis 15:00 Uhr entfällt',
    ])
    expect(calendarOf(afterCancel[0])).toContain('METHOD:CANCEL\r\n')
    expect(calendarOf(afterCancel[0])).toContain('STATUS:CANCELLED\r\n')
    // A version after the move, so that the calendar takes the cancellation.
    expect(calendarOf(afterCancel[0])).toContain('SEQUENCE:2\r\n')
    // And nothing twice.
    expect(await cycle()).toEqual([])
  })

  /**
   * Messages written before their customer was restricted, waiting as a
   * mail server that did not answer leaves them: a confirmation of a job,
   * which carries no file to a business, and a reminder, which names its
   * customer only in its cause. The pass gives both up with the reason.
   */
  it('wait unsent once their customer is restricted, with a file or without', async () => {
    const customerId = await aCustomer()
    const job = await aJob(customerId)
    const made = await anAppointment(job)
    const waiting = async (
      kind: string,
      cause: string,
      names: { jobId?: string; appointmentId?: string } = {},
    ) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into mail_outbox
           (tenant_id, kind, cause, sender_name, recipient_address, recipient_name, subject, body,
            job_id, appointment_id)
         values ($1, $2, $3, 'Elektro Nord GmbH', 'arslan@example.de', 'Familie Arslan', 'Betreff',
                 'Text', $4, $5)
         returning id`,
        [north.id, kind, cause, names.jobId ?? null, names.appointmentId ?? null],
      )

      return rows[0]?.id ?? ''
    }
    const received = await waiting('job_received', `job_received:${job}:waiting`, { jobId: job })
    const reminded = await waiting(
      'customer_reminder',
      `customer_reminder:e_check:${customerId}:${job}:2031-11-07`,
    )
    // Names its appointment and not its job.
    const confirmed = await waiting('appointment_confirmation', `appointment:${made.id}:waiting`, {
      appointmentId: made.id,
    })
    const recorded = await http()
      .post('/privacy/requests')
      .set('x-test-identity', office())
      .send({ customerId, receivedOn: new Date().toISOString().slice(0, 10), channel: 'email' })
      .expect(201)

    await admin.query(
      `update erasure_requests set status = 'restricted', restricted_at = now() where id = $1`,
      [(recorded.body as { request: { id: string } }).request.id],
    )

    expect(await cycle()).toEqual([])

    const { rows } = await admin.query<{ id: string; status: string; last_error: string | null }>(
      'select id, status, last_error from mail_outbox where id = any($1) order by id',
      [[received, reminded, confirmed]],
    )

    expect(rows).toEqual(
      [received, reminded, confirmed].map((id) => ({
        id,
        status: 'failed',
        last_error: expect.stringContaining(restrictedCustomerMail) as unknown,
      })),
    )
  })

  /**
   * A mail written about a job for one customer, the job given to another
   * before it went: what it carries would name the other, so it does not go
   * to the address of the first. A mail about a job that stayed goes.
   */
  it('waits unsent once its job belongs to another customer, and goes while it stays', async () => {
    const first = await aCustomer({ name: 'Familie Arslan' })
    const other = await aCustomer({ name: 'Familie Lehmann', email: 'lehmann@example.de' })
    const moved = await aJob(first)
    const stayed = await aJob(first)
    const written = async (jobId: string, subject: string) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into mail_outbox
           (tenant_id, kind, cause, sender_name, recipient_address, recipient_name, subject, body,
            job_id, customer_id)
         values ($1, 'job_received', $2, 'Elektro Nord GmbH', 'arslan@example.de', 'Familie Arslan',
                 $3, 'Text', $4, $5)
         returning id`,
        [north.id, `job_received:${jobId}:written`, subject, jobId, first],
      )

      return rows[0]?.id ?? ''
    }
    const away = await written(moved, 'Ihr Auftrag, nun bei anderen')
    const kept = await written(stayed, 'Ihr Auftrag, unverändert')

    await http()
      .patch(`/jobs/${moved}`)
      .set('x-test-identity', office())
      .send({ customerId: other })
      .expect(200)

    const sent = await cycle()

    expect(sent.map((mail) => mail.subject)).toContain('Ihr Auftrag, unverändert')
    expect(sent.map((mail) => mail.subject)).not.toContain('Ihr Auftrag, nun bei anderen')

    const { rows } = await admin.query<{ id: string; status: string; last_error: string | null }>(
      'select id, status, last_error from mail_outbox where id = any($1) order by id',
      [[away, kept]],
    )

    expect(rows).toEqual([
      {
        id: away,
        status: 'failed',
        last_error: expect.stringContaining(reassignedCustomerMail) as unknown,
      },
      { id: kept, status: 'sent', last_error: null },
    ])
  })

  /**
   * The calendar file is made as the mail goes, after the worker found the job
   * still the first customer's. Made from a job given to another customer in
   * between, it would carry the other's place to the address of the first.
   */
  it('carries no calendar file of a job given to another customer after the pass looked at it', async () => {
    const first = await aCustomer()
    const other = await aCustomer({ name: 'Familie Lehmann', email: 'lehmann@example.de' })
    const job = await aJob(first)
    const appointment = await anAppointment(job)

    // What went before goes out first, so that this pass carries only this mail.
    await cycle()

    const { rows: written } = await admin.query<{ id: string }>(
      `insert into mail_outbox
         (tenant_id, kind, cause, sender_name, recipient_address, recipient_name, subject, body,
          appointment_id, job_id, customer_id)
       values ($1, 'appointment_confirmation', $2, 'Elektro Nord GmbH', 'arslan@example.de',
               'Familie Arslan', 'Ihr Termin, gleich bei anderen', 'Text', $3, $4, $5)
       returning id`,
      [north.id, `appointment_confirmation:${appointment.id}:held`, appointment.id, job, first],
    )
    // Held right where the file reads the appointment with its job, while the
    // office gives the job to another customer.
    const query = Client.prototype.query
    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const atTheFile = new Promise<void>((resolve) => {
      reached = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let armed = true

    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string; values?: unknown[] } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const values = typeof config === 'string' ? args[1] : (config?.values ?? args[1])
      const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

      if (
        armed &&
        text.includes('from "appointments" inner join "jobs"') &&
        JSON.stringify(values ?? []).includes(appointment.id)
      ) {
        armed = false
        reached()

        return released.then(forward)
      }

      return forward()
    } as typeof query

    let sent: OutgoingMail[]

    try {
      const passing = cycle()

      await atTheFile
      await admin.query('update jobs set customer_id = $1 where id = $2', [other, job])
      release()
      sent = await passing
    } finally {
      Client.prototype.query = query
      release()
    }

    expect(sent.map((mail) => mail.subject)).not.toContain('Ihr Termin, gleich bei anderen')

    const { rows } = await admin.query<{ status: string; last_error: string | null }>(
      'select status, last_error from mail_outbox where id = $1',
      [written[0]?.id],
    )

    expect(rows).toEqual([{ status: 'failed', last_error: `ECUSTOMER: ${reassignedCustomerMail}` }])
  })

  it('goes to nobody for a customer without an address, and not about one that is over', async () => {
    await anAppointment(await aJob(await aCustomer({ email: null })))

    // Nor a cancellation of an appointment the customer never heard of.
    const untold = await anAppointment(await aJob(await aCustomer()))

    await send('delete', `/appointments/${untold.id}?version=${String(untold.version)}`)

    const job = await aJob(await aCustomer())

    await send('post', '/appointments', {
      jobId: job,
      startsAt: '2026-01-05T06:00:00.000Z',
      endsAt: '2026-01-05T08:00:00.000Z',
      note: null,
      rrule: null,
      exdates: [],
      userIds: ['jonas'],
    })

    expect(await cycle()).toEqual([])
  })

  it('says what the business wrote for the occasion, with its placeholders filled in', async () => {
    await send('post', '/documents/text-snippets', {
      purpose: 'mail',
      mailOccasion: 'appointment_arranged',
      title: 'Termin für {kunde}',
      text: 'Hallo {kunde},\n{auftrag} am {termin}.\n{benutzer}',
    })

    await anAppointment(await aJob(await aCustomer({ name: 'Familie Berg' })))

    const [mail] = await cycle()

    expect(mail?.subject).toBe('Termin für Familie Berg')
    expect(mail?.text.split('\n\n-- \n')[0]).toMatch(
      /^Hallo Familie Berg,\nAU-\d{4}-\d{4} Heizung ohne Strom am Freitag, 07\.11\.2031, 07:00 bis 15:00 Uhr\.$/,
    )
  })
})

describe('a confirmation of a service call (#315)', () => {
  beforeAll(async () => {
    await switchOn('service_call.mail_on_receipt')
  })

  it('goes out once, with the instructions for a consumer', async () => {
    const customerId = await aCustomer()
    const job = await aJob(customerId, 'service')
    const [mail, ...more] = await cycle()

    expect(await customersOfMails('job_id', job)).toEqual([customerId])

    expect(more).toEqual([])
    expect(mail?.subject).toMatch(/^Ihr Auftrag AU-\d{4}-\d{4} Heizung ohne Strom$/)
    expect(mail?.text).toContain(instructionsSentence)
    expect(mail?.attachments?.map((attachment) => attachment.filename)).toEqual(['Belehrungen.pdf'])
    expect(await cycle()).toEqual([])

    // The card of the instructions at the job lists it.
    const view = await send('get', `/jobs/${job}/instructions`)

    expect((view['mails'] as unknown[]).length).toBe(1)
  })

  it('goes without them to a business, and a project gets none', async () => {
    await aJob(
      await aCustomer({ kind: 'business', isBusiness: true, name: 'Bäckerei Lutz' }),
      'service',
    )
    await aJob(await aCustomer(), 'project')

    const sent = await cycle()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).not.toContain(instructionsSentence)
    expect(sent[0]?.attachments ?? []).toEqual([])
  })

  it('leaves the card of the instructions to them: a confirmation of an appointment is none', async () => {
    const job = await aJob(await aCustomer(), 'service')

    await anAppointment(job)
    expect(await cycle()).toHaveLength(2)

    const view = await send('get', `/jobs/${job}/instructions`)

    expect((view['mails'] as unknown[]).length).toBe(1)
  })
})

describe('a snippet for mails', () => {
  it('names its occasion, and there is one for each', async () => {
    const without = await send(
      'post',
      '/documents/text-snippets',
      { purpose: 'mail', title: 'Ihr Auftrag', text: 'Danke.' },
      office(),
      400,
    )

    expect(without['message']).toBe('Ein Textbaustein für E-Mails braucht seinen Anlass.')

    await send('post', '/documents/text-snippets', {
      purpose: 'mail',
      mailOccasion: 'job_received',
      title: 'Ihr Auftrag {auftrag}',
      text: 'Danke.',
    })

    const second = await send(
      'post',
      '/documents/text-snippets',
      { purpose: 'mail', mailOccasion: 'job_received', title: 'Noch einer', text: 'Danke.' },
      office(),
      409,
    )

    expect(second['message']).toBe(
      'Für „Auftragseingang“ gibt es schon einen Text. Den bestehenden bearbeiten oder entfernen.',
    )
  })
})
