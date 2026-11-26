import {
  type DocumentTotals,
  type RateTotal,
  type RecordState,
  type VatRate,
  vatRates,
} from '@opengewerk/domain'

import { documentStatusOf } from './labels.js'

/**
 * What an issued document shows when this device does not hold its totals
 * yet: one it pulled before the server copied them onto the document (#1035).
 * The next exchange brings them, and until then no figure is better than one
 * worked out again by rules the document was not issued under.
 */
export const totalsNotHereYet =
  'Die festgeschriebenen Summen dieses Belegs bringt der nächste Abgleich.'

function isCents(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

function isRate(value: unknown): value is VatRate {
  return (vatRates as readonly unknown[]).includes(value)
}

function rateTotalOf(value: unknown): RateTotal | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const entry = value as Record<string, unknown>

  return isRate(entry['rate']) &&
    isCents(entry['basisPoints']) &&
    isCents(entry['netCents']) &&
    isCents(entry['taxCents']) &&
    isCents(entry['grossCents'])
    ? {
        rate: entry['rate'],
        basisPoints: entry['basisPoints'],
        netCents: entry['netCents'],
        taxCents: entry['taxCents'],
        grossCents: entry['grossCents'],
      }
    : null
}

/**
 * The totals an issued document froze, as the database copied them from its
 * snapshot onto the document, read out of the text the sync carries a value
 * of JSON in. Null where the document holds none, or none in the shape of
 * totals.
 */
export function issuedTotalsOf(document: RecordState): DocumentTotals | null {
  const value = document['issuedTotals']

  if (typeof value !== 'string') {
    return null
  }

  let read: unknown

  try {
    read = JSON.parse(value) as unknown
  } catch {
    return null
  }

  if (typeof read !== 'object' || read === null) {
    return null
  }

  const totals = read as Record<string, unknown>
  const byRate = Array.isArray(totals['byRate']) ? totals['byRate'].map(rateTotalOf) : null
  const taxNote = totals['taxNote'] ?? null

  if (
    !isCents(totals['netCents']) ||
    !isCents(totals['taxCents']) ||
    !isCents(totals['grossCents']) ||
    byRate === null ||
    byRate.some((entry) => entry === null) ||
    (taxNote !== null && typeof taxNote !== 'string')
  ) {
    return null
  }

  return {
    netCents: totals['netCents'],
    taxCents: totals['taxCents'],
    grossCents: totals['grossCents'],
    byRate: byRate as RateTotal[],
    taxNote,
  }
}

/**
 * What an issued or cancelled document shows as its totals: the ones it
 * froze (#1035), or the sentence while this device does not hold them yet.
 * Null for a draft and a signed report, whose totals are worked out from
 * their lines, by the same function the server issues them with.
 */
export function frozenTotalsOf(document: RecordState): DocumentTotals | string | null {
  const status = documentStatusOf(document)

  if (status !== 'issued' && status !== 'cancelled') {
    return null
  }

  return issuedTotalsOf(document) ?? totalsNotHereYet
}
