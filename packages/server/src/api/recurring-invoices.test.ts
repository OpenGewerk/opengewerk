import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  addDays,
  addMonths,
  berlinClock,
  berlinInstant,
  type DocumentId,
  permissionsOfRoles,
  type TenantId,
} from '@opengewerk/domain'
import { Database, newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import { runDeadlinesOf } from '../deadlines/engine.js'
import { contractInvoicesToSend } from '../notifications/contract-invoices.js'
import { documentToCustomer } from '../notifications/notify.js'
import { ApiModule } from './api.module.js'
import { as, testIdentities as identities } from './test-identity.js'
import { invoiceable, readyToInvoice } from './test-invoice.js'

/**
 * The recurring invoices of maintenance contracts paid per period (#295): one
 * per period and never two, dated on the day it is made, also ahead of its
 * period, taxed by the rate of the period's end (#1017), the
 * first of a contract a draft and the next issued by nobody where the contract
 * wants it, and those sent to the customer once.
 */

const north = newId<'tenant'>() as TenantId
const today = berlinClock(new Date()).day
/**
 * A time of today after the morning the engine waits for before it acts
 * (`morningMinute`), so that a run between midnight and six in German time
 * does the same as one at noon.
 */
const morning = new Date(`${today}T09:00:00Z`)

let admin: Pool
let database: Database
let app: INestApplication
let customer = ''
let silent = ''
let site = ''

const office = () => as(north, 'office')

async function quote(customerId: string): Promise<DocumentId> {
  const id = newId<'document'>() as DocumentId

  await admin.query(
    `insert into documents (id, tenant_id, customer_id, site_id, kind, status, number, document_date, issued_at, issued_by, subject)
     values ($1, $2, $3, $4, 'quote', 'issued', $5, $6, now(), 'britta', 'Wartung')`,
    [id, north, customerId, customerId === customer ? site : null, `AN-${id.slice(-6)}`, today],
  )

  return id
}

/** A contract paid by the month, entered the day before it began, so that its periods since are its own. */
async function contract(
  startsOn: string,
  overrides: Record<string, unknown> = {},
  customerId = customer,
) {
  const answer = await request(app.getHttpServer())
    .post('/maintenance-contracts')
    .set('x-test-identity', office())
    .send({
      quoteId: await quote(customerId),
      designation: 'Wartung Elektroanlage Rheinstraße 12',
      installationIds: [],
      startsOn,
      firstVisitOn: addMonths(startsOn as never, 60),
      intervalMonths: 12,
      termMonths: 120,
      renewal: 'none',
      noticeMonths: 0,
      priceKind: 'flat',
      flatCents: 3_900,
      paymentRhythm: 'monthly',
      issueByItself: true,
      ...overrides,
    })
    .expect(201)
  const id = String((answer.body as { id: string }).id)

  await admin.query('update maintenance_contracts set created_at = $2 where id = $1', [
    id,
    `${addDays(startsOn as never, -1)}T12:00:00Z`,
  ])

  return id
}

async function invoicesOf(contractId: string) {
  const { rows } = await admin.query<{
    id: string
    status: string
    number: string | null
    issued_by: string | null
    document_date: string
    service_from: string
    service_until: string
  }>(
    `select id, status, number, issued_by, to_char(document_date, 'YYYY-MM-DD') as document_date,
            to_char(service_from, 'YYYY-MM-DD') as service_from, to_char(service_until, 'YYYY-MM-DD') as service_until
       from documents where maintenance_contract_id = $1 order by service_from`,
    [contractId],
  )

  return rows
}

async function run(times: number) {
  for (let pass = 0; pass < times; pass += 1) {
    await runDeadlinesOf({ database }, north, morning)
  }
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2)', [north, 'Elektro Nord GmbH'])
  await readyToInvoice(admin, north)

  customer = newId<'customer'>()
  silent = newId<'customer'>()
  site = newId<'site'>()
  await admin.query(
    `insert into customers (id, tenant_id, kind, name, is_business, email, street, house_number, postal_code, city)
     values ($1, $3, 'business', 'Hausverwaltung Süd GmbH', true, 'buchhaltung@hv-sued.example', $4, $5, $6, $7),
            ($2, $3, 'business', 'Metzgerei Lang GmbH', true, null, $4, $5, $6, $7)`,
    [
      customer,
      silent,
      north,
      invoiceable.street,
      invoiceable.houseNumber,
      invoiceable.postalCode,
      invoiceable.city,
    ],
  )
  await admin.query(
    `insert into sites (id, tenant_id, customer_id, designation) values ($1, $2, $3, 'Rheinstraße 12')`,
    [site, north, customer],
  )

  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [ApiModule.create(database, identities)],
  }).compile()

  app = built.createNestApplication()
  await app.init()
})

beforeEach(async () => {
  await admin.query('delete from deadlines')
  await admin.query('delete from tasks')
  await admin.query(
    'begin; set local session_replication_role = replica; delete from mail_outbox; delete from document_snapshots; delete from document_lines; delete from documents; delete from maintenance_contracts; commit;',
  )
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
})

describe('the recurring invoices of a contract (#295)', () => {
  it('come one per period, the first a draft and the next issued by nobody, and none twice', async () => {
    const startsOn = addMonths(today, -2)
    const made = await contract(startsOn)

    await run(5)

    const invoices = await invoicesOf(made)

    expect(invoices.map((invoice) => [invoice.service_from, invoice.status])).toEqual([
      [startsOn, 'draft'],
      [addMonths(startsOn, 1), 'issued'],
      [addMonths(startsOn, 2), 'issued'],
    ])
    expect(invoices[0]?.service_until).toBe(addDays(addMonths(startsOn, 1), -1))
    // Dated the day they were made, which is the day of issue, also the two
    // the run caught up on (#1017); the rate comes from the period of service.
    expect(invoices.map((invoice) => invoice.document_date)).toEqual([today, today, today])
    expect(
      invoices.slice(1).every((invoice) => invoice.number !== null && invoice.issued_by === null),
    ).toBe(true)

    const { rows } = await admin.query<{ due_on: string }>(
      `select to_char(due_on, 'YYYY-MM-DD') as due_on from deadlines where kind = 'maintenance.invoice' and source_id = $1`,
      [made],
    )

    expect(rows).toEqual([{ due_on: addMonths(startsOn, 3) }])

    // Billed once, the contract stays and is given notice instead.
    await request(app.getHttpServer())
      .delete(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .expect(409)
  })

  it('are dated the day they are made, also by a pass that began the day before (#1017)', async () => {
    const startsOn = addMonths(today, -1)
    const made = await contract(startsOn)
    const tomorrow = addDays(today, 1)

    // The pass of the business begins a second before midnight in Germany,
    // and makes the invoice of the first period five seconds after it.
    await runDeadlinesOf(
      { database, now: () => new Date(berlinInstant(tomorrow, 0).getTime() + 5_000) },
      north,
      new Date(berlinInstant(today, 24 * 60).getTime() - 1_000),
    )

    expect((await invoicesOf(made)).map((invoice) => invoice.document_date)).toEqual([tomorrow])
  })

  /**
   * Made ahead of its period, with a lead on its deadline, and issued by the
   * office before the period begins: dated on the day it is made and on the
   * day of its issue, not on the first day of the period, which has not come
   * yet (§ 14 Abs. 4 Satz 1 Nr. 3 UStG, #1039).
   */
  it('are dated on the day of their issue when a lead makes one ahead of its period', async () => {
    const startsOn = addDays(today, 3)
    const made = await contract(startsOn)

    // The first pass finds the deadline, the second runs it with its lead.
    await run(1)

    const { rowCount } = await admin.query(
      `update deadlines set lead_days = 7 where kind = 'maintenance.invoice' and source_id = $1`,
      [made],
    )

    expect(rowCount).toBe(1)
    await run(1)

    const [first] = await invoicesOf(made)

    expect([first?.status, first?.document_date]).toEqual(['draft', today])

    // Dated on the first day of the period, as before, the draft would be
    // dated anew by the issuing; this holds the issuing to today on its own.
    await admin.query(`update documents set document_date = $1 where id = $2`, [
      startsOn,
      first?.id,
    ])

    await request(app.getHttpServer())
      .post(`/documents/${String(first?.id)}/issue`)
      .set('x-test-identity', office())
      .expect(201)

    expect(
      (await invoicesOf(made)).map((invoice) => [invoice.status, invoice.document_date]),
    ).toEqual([['issued', today]])
  })

  it('stay drafts without the wish of the contract, and so does a period cut short by its end', async () => {
    const startsOn = addMonths(today, -1)
    const waiting = await contract(startsOn, { issueByItself: false })
    // Four months paid by the quarter: the second quarter ends with the contract.
    const quarters = addMonths(today, -3)
    const ending = await contract(quarters, { termMonths: 4, paymentRhythm: 'quarterly' })

    await run(4)

    expect((await invoicesOf(waiting)).map((invoice) => invoice.status)).toEqual(['draft', 'draft'])
    expect(
      (await invoicesOf(ending)).map((invoice) => [invoice.service_until, invoice.status]),
    ).toEqual([
      [addDays(addMonths(quarters, 3), -1), 'draft'],
      [addDays(addMonths(quarters, 4), -1), 'draft'],
    ])
  })

  it('tax a period by the rate of the period where the contract wants its end (#1037)', async () => {
    const made = await contract('2020-06-01', { termMonths: 2, rateDay: 'period_end' })

    await run(3)

    const { rows } = await admin.query<{ service_from: string; content: unknown }>(
      `select to_char(d.service_from, 'YYYY-MM-DD') as service_from, s.content
         from documents d join document_snapshots s on s.document_id = d.id
        where d.maintenance_contract_id = $1`,
      [made],
    )

    expect(rows.map((row) => row.service_from)).toEqual(['2020-07-01'])
    // The reduced standard rate of the second half of 2020, 16 instead of 19
    // per cent, though the invoice is dated today: the rate is the one of the
    // work (#1017).
    expect(JSON.stringify(rows[0]?.content)).toContain('"basisPoints":1600')
    expect(JSON.stringify(rows[0]?.content)).toContain(`"documentDate":"${today}"`)
  })

  it('go to the customer once those were issued by nobody, and to nobody without an address', async () => {
    const startsOn = addMonths(today, -1)
    const made = await contract(startsOn)
    const quiet = await contract(startsOn, {}, silent)

    await run(3)

    const wanted = await contractInvoicesToSend(database, north, new Date())
    const issued = (await invoicesOf(made)).filter((invoice) => invoice.status === 'issued')

    expect(wanted).toEqual([
      expect.objectContaining({
        kind: 'document',
        documentId: issued[0]?.id,
        request: 'contract',
        to: { address: 'buchhaltung@hv-sued.example', name: 'Hausverwaltung Süd GmbH' },
        requestedBy: null,
      }),
    ])
    expect((await invoicesOf(quiet)).filter((invoice) => invoice.status === 'issued')).toHaveLength(
      1,
    )

    await admin.query(
      `insert into mail_outbox (tenant_id, kind, cause, document_id, attachment, sender_name, recipient_address, subject, body)
       values ($1, 'document', $2, $3, 'pdf', 'Elektro Nord GmbH', 'buchhaltung@hv-sued.example', 'Rechnung', 'Rechnung')`,
      [north, `document:${String(issued[0]?.id)}:contract`, issued[0]?.id],
    )

    expect(await contractInvoicesToSend(database, north, new Date())).toEqual([])
  })

  /**
   * Not to a customer deleted since (#1065): not found, and not written
   * where the pass found it before the deletion.
   */
  it('go to nobody by themselves once their customer is deleted', async () => {
    const gone = newId<'customer'>()

    await admin.query(
      `insert into customers (id, tenant_id, kind, name, is_business, email, street, house_number, postal_code, city)
       values ($1, $2, 'business', 'Elektrohandel Kern GmbH', true, 'rechnung@kern.example', $3, $4, $5, $6)`,
      [
        gone,
        north,
        invoiceable.street,
        invoiceable.houseNumber,
        invoiceable.postalCode,
        invoiceable.city,
      ],
    )
    await contract(addMonths(today, -1), {}, gone)
    await run(3)

    const wanted = await contractInvoicesToSend(database, north, new Date())

    expect(wanted).toHaveLength(1)

    await request(app.getHttpServer())
      .delete(`/customers/${gone}`)
      .set('x-test-identity', office())
      .expect(200)

    expect(await contractInvoicesToSend(database, north, new Date())).toEqual([])

    for (const notification of wanted) {
      expect(await documentToCustomer(database, north, notification)).toEqual([])
    }
  })
})

async function pastTheTriggers(statement: string, values: readonly unknown[]) {
  const client = await admin.connect()

  try {
    await client.query('begin')
    await client.query("set local session_replication_role = 'replica'")
    await client.query(statement, [...values])
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function supplyOf(documentId: string) {
  const { rows } = await admin.query<{ supply_on: string | null }>(
    `select to_char(supply_on, 'YYYY-MM-DD') as supply_on from documents where id = $1`,
    [documentId],
  )

  return rows[0]?.supply_on ?? null
}

function check(documentId: string, identity = office()) {
  return request(app.getHttpServer())
    .get(`/documents/${documentId}/recurring-check`)
    .set('x-test-identity', identity)
}

/**
 * The day whose rate a recurring invoice takes (#1037): the maintenance its
 * period pays for, where the contract says the flat price pays for its
 * maintenances, which a new contract does. In the second half of 2020 the
 * standard rate was 16 per cent, before it 19.
 */
describe('the day of the rate of a recurring invoice (#1037)', () => {
  it('is the day of the maintenance its period pays for, not the end of the period', async () => {
    const made = await contract('2020-06-01', { termMonths: 2, firstVisitOn: '2020-06-15' })

    await run(3)

    const { rows } = await admin.query<{ id: string; content: { supplyOn: string } }>(
      `select d.id, s.content
         from documents d join document_snapshots s on s.document_id = d.id
        where d.maintenance_contract_id = $1`,
      [made],
    )
    const [july] = rows

    // July pays for the maintenance of 15 June, at 19 per cent, though the
    // month ends in the time of 16.
    expect(await supplyOf(String(july?.id))).toBe('2020-06-15')
    expect(july?.content.supplyOn).toBe('2020-06-15')
    expect(JSON.stringify(july?.content)).toContain('"basisPoints":1900')
  })

  it('stays the day of the invoice on its cancellation, whatever the contract says since', async () => {
    const made = await contract('2020-06-01', { termMonths: 2, firstVisitOn: '2020-06-15' })

    await run(3)

    const july = (await invoicesOf(made)).find((invoice) => invoice.status === 'issued')

    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ rateDay: 'period_end' })
      .expect(200)

    const storno = (
      await request(app.getHttpServer())
        .post(`/documents/${String(july?.id)}/cancellation`)
        .set('x-test-identity', office())
        .expect(201)
    ).body as { id: string }
    const { rows } = await admin.query<{
      content: { supplyOn: string; totals: { taxCents: number } }
    }>('select content from document_snapshots where document_id = $1', [storno.id])

    expect(await supplyOf(storno.id)).toBe('2020-06-15')
    expect(rows[0]?.content.supplyOn).toBe('2020-06-15')
    // The 19 per cent of the invoice turned round, not the 16 of the end of July.
    expect(rows[0]?.content.totals.taxCents).toBe(-741)
  })

  it('taxes the period as of that day too, so that a maintenance under section 19 stays so', async () => {
    // The business claimed section 19 for the first half of 2020 only.
    await admin.query(
      `insert into tenant_parameters (tenant_id, key, valid_from, valid_until, unit, value)
         values ($1, 'small_business.claimed', '2020-01-01', '2020-06-30', 'flag', 1)`,
      [north],
    )

    try {
      const made = await contract('2020-06-01', { termMonths: 2, firstVisitOn: '2020-06-15' })

      await run(3)

      const { rows } = await admin.query<{ service_from: string; tax_treatment: string }>(
        `select to_char(service_from, 'YYYY-MM-DD') as service_from, tax_treatment
           from documents where maintenance_contract_id = $1 order by service_from`,
        [made],
      )

      // July pays for the maintenance of 15 June, which the business did as
      // a small business, though July itself is past it.
      expect(rows).toEqual([
        { service_from: '2020-06-01', tax_treatment: 'small_business' },
        { service_from: '2020-07-01', tax_treatment: 'small_business' },
      ])
    } finally {
      await admin.query(
        "delete from tenant_parameters where tenant_id = $1 and key = 'small_business.claimed'",
        [north],
      )
    }
  })

  it('taxes the period as of its end for a contract that wants the end, as its rate', async () => {
    // Section 19 until 30 June 2020; the first period ends on 14 July.
    await admin.query(
      `insert into tenant_parameters (tenant_id, key, valid_from, valid_until, unit, value)
         values ($1, 'small_business.claimed', '2020-01-01', '2020-06-30', 'flag', 1)`,
      [north],
    )

    try {
      const made = await contract('2020-06-15', {
        termMonths: 2,
        firstVisitOn: '2020-06-20',
        rateDay: 'period_end',
      })

      await run(3)

      const { rows } = await admin.query<{ service_from: string; tax_treatment: string }>(
        `select to_char(service_from, 'YYYY-MM-DD') as service_from, tax_treatment
           from documents where maintenance_contract_id = $1 order by service_from`,
        [made],
      )

      expect(rows).toEqual([
        { service_from: '2020-06-15', tax_treatment: 'standard' },
        { service_from: '2020-07-15', tax_treatment: 'standard' },
      ])
    } finally {
      await admin.query(
        "delete from tenant_parameters where tenant_id = $1 and key = 'small_business.claimed'",
        [north],
      )
    }
  })

  it('is the end of the period for a contract that wants it, which names no day', async () => {
    const made = await contract('2020-06-01', {
      termMonths: 2,
      firstVisitOn: '2020-06-15',
      rateDay: 'period_end',
    })

    await run(3)

    const invoices = await invoicesOf(made)

    expect(await Promise.all(invoices.map((invoice) => supplyOf(invoice.id)))).toEqual([null, null])
  })
})

/**
 * What has changed for a recurring invoice since it was made, and the two
 * ways to act on it (#1037): a draft takes over the values of today, an
 * issued invoice is cancelled and its period laid out again.
 */
describe('what has changed for a recurring invoice (#1037)', () => {
  it('tells a draft the values its contract has today, and takes them over', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)

    expect((await check(id).expect(200)).body).toEqual({ changes: [] })

    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 4_200, rateDay: 'period_end' })
      .expect(200)

    expect((await check(id).expect(200)).body).toEqual({
      changes: [
        { field: 'flatCents', was: 3_900, now: 4_200 },
        { field: 'supplyOn', was: expect.any(String) as string, now: null },
      ],
    })

    await request(app.getHttpServer())
      .post(`/documents/${id}/recurring-refresh`)
      .set('x-test-identity', office())
      .expect(201)

    expect((await check(id).expect(200)).body).toEqual({ changes: [] })
    expect(await supplyOf(id)).toBeNull()

    const { rows } = await admin.query<{ unit_price_cents: number; net_cents: number }>(
      'select unit_price_cents, net_cents from document_lines where document_id = $1',
      [id],
    )

    expect(rows).toEqual([{ unit_price_cents: 4_200, net_cents: 4_200 }])

    // What it took over now is what the next change is told against.
    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 4_500 })
      .expect(200)

    expect((await check(id).expect(200)).body).toEqual({
      changes: [{ field: 'flatCents', was: 4_200, now: 4_500 }],
    })
  })

  it('tells a draft a tax treatment its customer has otherwise today, and takes it over', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)
    const construction = (value: boolean) =>
      admin.query('update customers set is_construction_service_recipient = $2 where id = $1', [
        customer,
        value,
      ])

    try {
      // The customer turns out to receive construction work (section 13b).
      await construction(true)

      expect((await check(id).expect(200)).body).toEqual({
        changes: [{ field: 'taxTreatment', was: 'standard', now: 'reverse_charge' }],
      })

      await request(app.getHttpServer())
        .post(`/documents/${id}/recurring-refresh`)
        .set('x-test-identity', office())
        .expect(201)

      const { rows } = await admin.query<{ tax_treatment: string }>(
        'select tax_treatment from documents where id = $1',
        [id],
      )

      expect(rows[0]?.tax_treatment).toBe('reverse_charge')

      // And back: told against what it took over last.
      await construction(false)

      expect((await check(id).expect(200)).body).toEqual({
        changes: [{ field: 'taxTreatment', was: 'reverse_charge', now: 'standard' }],
      })
    } finally {
      await construction(false)
    }
  })

  it('tells a draft the tax treatment of the customer it goes to, not of the contract', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)

    try {
      // The office sends it to another customer, who receives construction work.
      await admin.query(
        'update customers set is_construction_service_recipient = true where id = $1',
        [silent],
      )
      await request(app.getHttpServer())
        .patch(`/documents/${id}`)
        .set('x-test-identity', office())
        .send({ customerId: silent, siteId: null })
        .expect(200)

      expect((await check(id).expect(200)).body).toEqual({
        changes: [{ field: 'taxTreatment', was: 'standard', now: 'reverse_charge' }],
      })
    } finally {
      await admin.query(
        'update customers set is_construction_service_recipient = false where id = $1',
        [silent],
      )
    }
  })

  it('lays a period out again for the customer and site the invoice went to', async () => {
    const made = await contract(addMonths(today, -1))

    await run(3)

    const issued = (await invoicesOf(made)).find((invoice) => invoice.status === 'issued')
    const id = String(issued?.id)

    // Sent elsewhere by the office before it was issued.
    await pastTheTriggers('update documents set customer_id = $2, site_id = null where id = $1', [
      id,
      silent,
    ])

    const answer = await request(app.getHttpServer())
      .post(`/documents/${id}/renewal`)
      .set('x-test-identity', office())
      .expect(201)

    expect((answer.body as { renewed: unknown }).renewed).toMatchObject({
      customerId: silent,
      siteId: null,
    })
  })

  it('does not tell a draft of a value the office changed in it, nor offer to undo it', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)

    // The office prices the month itself and taxes it otherwise.
    await admin.query(
      'update document_lines set unit_price_cents = 3500, net_cents = 3500 where document_id = $1',
      [id],
    )
    await admin.query("update documents set tax_treatment = 'reverse_charge' where id = $1", [id])

    expect((await check(id).expect(200)).body).toEqual({ changes: [] })

    // Nor once the contract changes its price: the office holds this one.
    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 4_200 })
      .expect(200)

    expect((await check(id).expect(200)).body).toEqual({ changes: [] })
  })

  it('keeps to the line of the contract when the office adds a flat line of its own', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)

    await admin.query(
      `insert into document_lines (tenant_id, document_id, kind, position, designation, quantity_milli, unit, unit_price_cents, net_cents)
       values ($1, $2, 'item', 2, 'Anfahrt pauschal', 1000, 'flat_rate', 1500, 1500)`,
      [north, id],
    )
    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 4_200 })
      .expect(200)

    expect((await check(id).expect(200)).body).toEqual({
      changes: [{ field: 'flatCents', was: 3_900, now: 4_200 }],
    })

    await request(app.getHttpServer())
      .post(`/documents/${id}/recurring-refresh`)
      .set('x-test-identity', office())
      .expect(201)

    const { rows } = await admin.query<{ designation: string; unit_price_cents: number }>(
      'select designation, unit_price_cents from document_lines where document_id = $1 order by position',
      [id],
    )

    expect(rows).toEqual([
      { designation: 'Wartung Elektroanlage Rheinstraße 12', unit_price_cents: 4_200 },
      { designation: 'Anfahrt pauschal', unit_price_cents: 1_500 },
    ])
  })

  it('moves the day of its maintenance with a period the office moves, and blames no contract', async () => {
    const start = addMonths(today, -1)
    const made = await contract(start, {
      issueByItself: false,
      firstVisitOn: start,
      intervalMonths: 6,
    })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)
    const later = { from: addMonths(start, 7), until: addDays(addMonths(start, 8), -1) }

    expect(await supplyOf(id)).toBe(start)

    // Through the route: seven months on, the period pays for the second maintenance.
    await request(app.getHttpServer())
      .patch(`/documents/${id}`)
      .set('x-test-identity', office())
      .send({ serviceFrom: later.from, serviceUntil: later.until })
      .expect(200)

    expect(await supplyOf(id)).toBe(addMonths(start, 6))
    expect((await check(id).expect(200)).body).toEqual({ changes: [] })

    // Through the sync, as the screen of the office writes it: back again.
    const pushed = await request(app.getHttpServer())
      .post('/sync')
      .set('x-test-identity', JSON.stringify({ ...JSON.parse(office()), deviceId: 'office-tab' }))
      .send({
        deviceId: 'office-tab',
        operations: [
          {
            id: newId<'operation'>(),
            entity: 'documents',
            recordId: id,
            kind: 'update',
            baseVersion: null,
            patches: [
              { field: 'serviceFrom', from: later.from, to: first?.service_from },
              { field: 'serviceUntil', from: later.until, to: first?.service_until },
            ],
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201)

    expect((pushed.body as { receipts: { outcome: string }[] }).receipts[0]?.outcome).toBe(
      'applied',
    )
    expect(await supplyOf(id)).toBe(start)
    expect((await check(id).expect(200)).body).toEqual({ changes: [] })
  })

  it('keeps the day of its maintenance when the sync changes something else of the draft', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)
    const day = await supplyOf(id)

    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ rateDay: 'period_end' })
      .expect(200)

    const told = { changes: [{ field: 'supplyOn', was: day, now: null }] }

    expect((await check(id).expect(200)).body).toEqual(told)

    const { rows } = await admin.query<{
      line: string
      description: string | null
      document_date: string
    }>(
      `select l.id as line, l.description, to_char(d.document_date, 'YYYY-MM-DD') as document_date
         from document_lines l join documents d on d.id = l.document_id where d.id = $1`,
      [id],
    )
    const [line] = rows
    const pushed = await request(app.getHttpServer())
      .post('/sync')
      .set('x-test-identity', JSON.stringify({ ...JSON.parse(office()), deviceId: 'office-tab' }))
      .send({
        deviceId: 'office-tab',
        operations: [
          {
            id: newId<'operation'>(),
            entity: 'document_lines',
            recordId: line?.line,
            kind: 'update',
            baseVersion: null,
            patches: [
              { field: 'description', from: line?.description, to: 'Wartung laut Vertrag' },
            ],
            recordedAt: new Date().toISOString(),
          },
          {
            id: newId<'operation'>(),
            entity: 'documents',
            recordId: id,
            kind: 'update',
            baseVersion: null,
            patches: [{ field: 'documentDate', from: line?.document_date, to: addDays(today, -1) }],
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201)

    expect(
      (pushed.body as { receipts: { outcome: string }[] }).receipts.map((each) => each.outcome),
    ).toEqual(['applied', 'applied'])
    // The contract changed, not the period: the notice still says so.
    expect(await supplyOf(id)).toBe(day)
    expect((await check(id).expect(200)).body).toEqual(told)
  })

  it('tells a draft laid out before the notice only of the day of its maintenance', async () => {
    const made = await contract(addMonths(today, -1), { issueByItself: false })

    await run(2)

    const [first] = await invoicesOf(made)
    const id = String(first?.id)

    // As a draft from before 0160: what it took is not known.
    await admin.query('update documents set taken_over = null where id = $1', [id])
    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 4_200, rateDay: 'period_end' })
      .expect(200)

    expect((await check(id).expect(200)).body).toEqual({
      changes: [{ field: 'supplyOn', was: expect.any(String) as string, now: null }],
    })

    await request(app.getHttpServer())
      .post(`/documents/${id}/recurring-refresh`)
      .set('x-test-identity', office())
      .expect(201)

    expect((await check(id).expect(200)).body).toEqual({ changes: [] })
    expect(await supplyOf(id)).toBeNull()
  })

  it('leaves the price of a period cut short by the end of the contract to the office', async () => {
    const quarters = addMonths(today, -3)
    const made = await contract(quarters, { termMonths: 4, paymentRhythm: 'quarterly' })

    await run(4)

    const cut = (await invoicesOf(made))[1]

    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 9_900 })
      .expect(200)

    const answer = (await check(String(cut?.id)).expect(200)).body as {
      changes: { field: string }[]
    }

    expect(answer.changes.map((change) => change.field)).not.toContain('flatCents')
  })

  it('tells an issued invoice a rate the running version knows otherwise for its day', async () => {
    const made = await contract(addMonths(today, -1))

    await run(3)

    const issued = (await invoicesOf(made)).find((invoice) => invoice.status === 'issued')
    const id = String(issued?.id)

    expect((await check(id).expect(200)).body).toEqual({ changes: [] })

    // As an earlier version would have issued it: at 16 per cent.
    await pastTheTriggers(
      `update documents set issued_totals = jsonb_set(issued_totals, '{byRate,0,basisPoints}', '1600')
        where id = $1`,
      [id],
    )

    expect((await check(id).expect(200)).body).toEqual({
      changes: [
        {
          field: 'rate',
          rate: 'standard',
          supplyOn: expect.any(String) as string,
          was: 1600,
          now: 1900,
        },
      ],
    })
  })

  it('cancels an issued invoice and lays its period out again with its lines and the values of today', async () => {
    const made = await contract(addMonths(today, -1))

    await run(3)

    const issued = (await invoicesOf(made)).find((invoice) => invoice.status === 'issued')
    const id = String(issued?.id)
    const { rows: articles } = await admin.query<{ id: string }>(
      "insert into articles (tenant_id, number, designation, unit) values ($1, '1042', 'Prüfprotokoll', 'flat_rate') returning id",
      [north],
    )
    const article = String(articles[0]?.id)

    // Its line as one taken from an article and marked as the surcharge of
    // an emergency call, which the new draft keeps as it is.
    await pastTheTriggers(
      'update document_lines set article_id = $2, emergency_surcharge = true where document_id = $1',
      [id, article],
    )
    // And a flat line of the office beside it, which the new draft does not
    // take for the line of the contract.
    await pastTheTriggers(
      `insert into document_lines (tenant_id, document_id, kind, position, designation, quantity_milli, unit, unit_price_cents, net_cents)
       values ($1, $2, 'item', 2, 'Anfahrt pauschal', 1000, 'flat_rate', 1500, 1500)`,
      [north, id],
    )

    // The contract changed meanwhile; the new draft keeps what was billed.
    await request(app.getHttpServer())
      .patch(`/maintenance-contracts/${made}`)
      .set('x-test-identity', office())
      .send({ flatCents: 4_200, rateDay: 'period_end' })
      .expect(200)

    const answer = await request(app.getHttpServer())
      .post(`/documents/${id}/renewal`)
      .set('x-test-identity', office())
      .expect(201)
    const { cancellation, renewed } = answer.body as {
      cancellation: { kind: string; status: string; predecessorDocumentId: string }
      renewed: {
        id: string
        status: string
        serviceFrom: string
        serviceUntil: string
        createdBy: string
      }
    }

    expect(cancellation).toMatchObject({
      kind: 'cancellation_invoice',
      status: 'issued',
      predecessorDocumentId: id,
    })
    expect(renewed).toMatchObject({
      status: 'draft',
      serviceFrom: issued?.service_from,
      serviceUntil: issued?.service_until,
      createdBy: 'test',
    })
    expect((await invoicesOf(made)).find((invoice) => invoice.id === id)?.status).toBe('cancelled')
    expect(await supplyOf(renewed.id)).toBeNull()

    const { rows } = await admin.query<{
      unit_price_cents: number
      article_id: string | null
      emergency_surcharge: boolean
    }>(
      `select unit_price_cents, article_id, emergency_surcharge from document_lines
        where document_id = $1 order by position`,
      [renewed.id],
    )

    expect(rows).toEqual([
      { unit_price_cents: 3_900, article_id: article, emergency_surcharge: true },
      { unit_price_cents: 1_500, article_id: null, emergency_surcharge: false },
    ])
    // And hears of the price the contract has today.
    expect((await check(renewed.id).expect(200)).body).toEqual({
      changes: [{ field: 'flatCents', was: 3_900, now: 4_200 }],
    })

    // Once, as a cancellation is.
    await request(app.getHttpServer())
      .post(`/documents/${id}/renewal`)
      .set('x-test-identity', office())
      .expect(409)
  })

  it('is acted on only with the right to change documents and to issue them', async () => {
    const made = await contract(addMonths(today, -1))

    await run(3)

    const [draft, issued] = await invoicesOf(made)
    const officeRights = [...permissionsOfRoles(['office'])]
    const without = (right: string) =>
      JSON.stringify({
        userId: 'test',
        tenantId: north,
        roles: ['office'],
        rights: officeRights.filter((each) => each !== right),
      })

    await request(app.getHttpServer())
      .post(`/documents/${String(draft?.id)}/recurring-refresh`)
      .set('x-test-identity', without('document.write'))
      .expect(403)
    await request(app.getHttpServer())
      .post(`/documents/${String(issued?.id)}/renewal`)
      .set('x-test-identity', without('document.issue'))
      .expect(403)
  })

  it('keeps one invoice per period that counts, a cancelled one aside', async () => {
    const made = await contract(addMonths(today, -1))

    await run(2)

    const [first] = await invoicesOf(made)
    const twice = admin.query(
      `insert into documents (tenant_id, customer_id, kind, document_date, service_from, service_until, maintenance_contract_id)
       values ($1, $2, 'recurring_invoice', $3, $4, $5, $6)`,
      [north, customer, today, first?.service_from, first?.service_until, made],
    )

    await expect(twice).rejects.toMatchObject({ code: '23505' })
  })
})
