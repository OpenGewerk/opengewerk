import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { cashAccountingNote, type TenantId } from '@opengewerk/domain'
import { Database, newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import { ApiModule } from './api.module.js'
import { as, testIdentities as identities } from './test-identity.js'
import { invoiceable, issuableDraft, readyToInvoice } from './test-invoice.js'

/**
 * The statement on cash accounting, from the declaration to the frozen invoice
 * (#1038).
 *
 * From 2028 an invoice of a business that reckons its tax on what it receives
 * says so (section 14 (4) number 6a UStG). Which way a turnover is taxed
 * depends on the period it falls in, not on the day it is invoiced: a business
 * that switches at the turn of the year still taxes the work of December the
 * old way when it invoices it in January. So the declaration is read on the
 * day of the work, as the rate is (#1017), and frozen with the invoice; the
 * PDF and the e-invoice are both made from what was frozen.
 *
 * Two businesses, because a declaration only ever moves forward: the one in
 * the north switches from cash to accrual accounting on 1 January 2029, the
 * one in the south the other way round.
 */

const north = { id: newId<'tenant'>(), name: 'Elektro Nord GmbH' }
const south = { id: newId<'tenant'>(), name: 'Elektro Süd GmbH' }

let admin: Pool
let database: Database
let app: INestApplication
const customers = new Map<TenantId, string>()

function http() {
  return request(app.getHttpServer())
}

function declare(tenantId: TenantId, value: 0 | 1, from: string) {
  return http()
    .post('/settings/parameters')
    .set('x-test-identity', as(tenantId, 'owner'))
    .send({ key: 'cash_accounting.permitted', from, value })
    .expect(201)
}

/**
 * An invoice for work in that period, issued on that day in Germany. With a
 * day of supply it is a recurring invoice whose maintenance was on that day,
 * which the engine of the contracts writes and nobody else (#1037).
 */
async function invoiced(
  tenantId: TenantId,
  work: {
    readonly serviceFrom: string
    readonly serviceUntil: string
    readonly supplyOn?: string
  },
  issuedOn: string,
): Promise<readonly string[]> {
  const office = as(tenantId, 'office')
  const { supplyOn, ...period } = work
  const draft = await issuableDraft(app, office, customers.get(tenantId) ?? '', {
    documentDate: issuedOn,
    ...period,
    ...(supplyOn ? { kind: 'recurring_invoice' } : {}),
  })

  if (supplyOn) {
    await admin.query('update documents set supply_on = $2 where id = $1', [draft, supplyOn])
  }

  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${issuedOn}T10:00:00+01:00`) })

  try {
    await http().post(`/documents/${draft}/issue`).set('x-test-identity', office).expect(201)
  } finally {
    vi.useRealTimers()
  }

  const { rows } = await admin.query<{ content: { notes: string[] } }>(
    'select content from document_snapshots where document_id = $1',
    [draft],
  )

  if (!rows[0]) {
    throw new Error(`Document ${draft} froze nothing.`)
  }

  return rows[0].content.notes
}

const december = { serviceFrom: '2028-12-01', serviceUntil: '2028-12-20' }
const january = { serviceFrom: '2029-01-08', serviceUntil: '2029-01-12' }

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()

  for (const tenant of [north, south]) {
    await admin.query('insert into tenants (id, name) values ($1, $2)', [tenant.id, tenant.name])
  }

  await readyToInvoice(admin, north.id, south.id)

  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [ApiModule.create(database, identities)],
  }).compile()

  app = built.createNestApplication()
  await app.init()

  for (const tenant of [north, south]) {
    const customer = await http()
      .post('/customers')
      .set('x-test-identity', as(tenant.id, 'office'))
      .send({ kind: 'private', name: 'Familie Berg', ...invoiceable })
      .expect(201)

    customers.set(tenant.id, (customer.body as { id: string }).id)
  }

  await declare(north.id, 1, '2028-01-01')
  await declare(north.id, 0, '2029-01-01')
  await declare(south.id, 1, '2029-01-01')
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
})

describe('a business that switches to accrual accounting at the turn of the year', () => {
  it('still states cash accounting for the work of December invoiced in January', async () => {
    expect(await invoiced(north.id, december, '2029-01-15')).toContain(cashAccountingNote)
  })

  it('does not state it for the work of January', async () => {
    expect(await invoiced(north.id, january, '2029-01-15')).not.toContain(cashAccountingNote)
  })

  it('states it for a period into January that pays for a maintenance in December', async () => {
    const period = { serviceFrom: '2028-12-15', serviceUntil: '2029-01-14', supplyOn: '2028-12-20' }

    expect(await invoiced(north.id, period, '2029-01-15')).toContain(cashAccountingNote)
  })
})

describe('a business that switches to cash accounting at the turn of the year', () => {
  it('does not state it for the work of December invoiced in January', async () => {
    expect(await invoiced(south.id, december, '2029-01-15')).not.toContain(cashAccountingNote)
  })

  it('states it for the work of January', async () => {
    expect(await invoiced(south.id, january, '2029-01-15')).toContain(cashAccountingNote)
  })
})
