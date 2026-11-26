import { describe, expect, it } from 'vitest'

import { totalsNotHereYet } from '../../app/issued-totals.js'
import { type ShownLine, totalsOf } from './document-lines.js'

/**
 * The totals the office shows while a document is written (#1017): the rates
 * of the day of the work, as the server issues it, and for a cancellation
 * those of the invoice it takes back. December 2020 was taxed at sixteen
 * percent, January 2021 at nineteen again.
 */
const line: ShownLine = {
  id: 'l-1',
  record: { id: 'l-1' },
  kind: 'item',
  designation: 'Unterverteilung erneuert',
  netCents: 10000,
  vatRate: 'standard',
}

const invoice = {
  id: 'd-1',
  kind: 'invoice',
  documentDate: '2021-01-04',
  serviceFrom: '2020-12-14',
  serviceUntil: '2020-12-15',
  taxTreatment: 'standard',
}

describe('the totals of a document in the office (#1017)', () => {
  it('take the rate of the day of the work, not of the date of the document', () => {
    expect(totalsOf(invoice, [line], null)).toMatchObject({
      taxCents: 1600,
      byRate: [{ basisPoints: 1600, taxCents: 1600 }],
    })
  })

  it('take the rate of the last day of the work when the period has one', () => {
    expect(
      totalsOf({ ...invoice, serviceFrom: '2020-12-28', serviceUntil: '2021-01-02' }, [line], null),
    ).toMatchObject({ byRate: [{ basisPoints: 1900, taxCents: 1900 }] })
  })

  it('take for a cancellation the day of the work of the invoice it takes back', () => {
    const cancellation = {
      id: 'd-2',
      kind: 'cancellation_invoice',
      documentDate: '2021-02-01',
      serviceFrom: null,
      serviceUntil: null,
      taxTreatment: 'standard',
    }

    expect(totalsOf(cancellation, [line], invoice)).toMatchObject({
      byRate: [{ basisPoints: 1600, taxCents: 1600 }],
    })
  })
})

/**
 * An issued document shows what it froze (#1035), the figures of its PDF: the
 * invoice of December 2020 went out at nineteen percent, although the rules
 * of this version tax its work at sixteen.
 */
describe('the totals of an issued document in the office (#1035)', () => {
  const frozen = {
    netCents: 10000,
    taxCents: 1900,
    grossCents: 11900,
    byRate: [
      { rate: 'standard', basisPoints: 1900, netCents: 10000, taxCents: 1900, grossCents: 11900 },
    ],
    taxNote: null,
  }
  const issued = { ...invoice, status: 'issued', issuedTotals: JSON.stringify(frozen) }

  it('are the ones it froze, not the ones the rules of this version work out', () => {
    expect(totalsOf(issued, [line], null)).toEqual(frozen)
  })

  it('stay the ones it froze once it is cancelled', () => {
    expect(totalsOf({ ...issued, status: 'cancelled' }, [line], null)).toEqual(frozen)
  })

  it('wait for the next exchange where this device does not hold them yet', () => {
    expect(totalsOf({ ...issued, issuedTotals: null }, [line], null)).toBe(totalsNotHereYet)
    expect(totalsOf({ ...issued, issuedTotals: '{"netCents":"viel"}' }, [line], null)).toBe(
      totalsNotHereYet,
    )
  })

  it('are worked out from the lines for a draft, whatever it carries', () => {
    expect(totalsOf({ ...issued, status: 'draft' }, [line], null)).toMatchObject({
      taxCents: 1600,
    })
  })
})
