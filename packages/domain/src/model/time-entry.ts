import type { Synced, TenantOwned } from '@opengewerk/platform-domain'
import type { JobId, LocationConsentId, TimeEntryId } from './identifier.js'

/**
 * What a stretch of time was (#76, 4.4). Travel and breaks are kinds of their
 * own because they are paid and counted differently, and a break is what the
 * working time rules look for.
 */
export const timeEntryKinds = ['work', 'travel', 'break'] as const

export type TimeEntryKind = (typeof timeEntryKinds)[number]

/**
 * One stretch of somebody's time, from its start to its end, as the record
 * § 17 MiLoG asks for: beginning, end and so the duration.
 *
 * Written once and never changed, like an issued document. A mistake is put
 * right by a new entry that names the one it corrects and says why, and an
 * entry that should not have been written at all is withdrawn the same way,
 * by a correction that carries `withdrawn`. The old entry stays, readable, for
 * the two years the law keeps it; what counts is worked out from the chain
 * (`effectiveEntries`).
 *
 * Whose time it is, the server writes from the request: nobody records time
 * for somebody else.
 *
 * A place is recorded only with the person's consent, at start and end and
 * nowhere in between, in millionths of a degree so that it is a whole number
 * like everything else stored here.
 */
export interface TimeEntry extends Synced {
  readonly id: TimeEntryId
  readonly userId: string
  readonly kind: TimeEntryKind
  readonly jobId: JobId | null
  readonly startedAt: Date
  readonly endedAt: Date
  readonly note: string | null
  readonly correctsEntryId: TimeEntryId | null
  /**
   * The year in Germany the chain of corrections of this entry began in
   * (opengewerk#1044): the year it starts in for an entry that corrects
   * nothing, that of the entry it corrects for a correction. Written by the
   * database when the entry is made, and the year the deletion concept counts
   * the entry with, however long its chain.
   */
  readonly chainYear: number
  readonly withdrawn: boolean
  readonly startLatitudeMicro: number | null
  readonly startLongitudeMicro: number | null
  readonly endLatitudeMicro: number | null
  readonly endLongitudeMicro: number | null
}

/**
 * Somebody's answer to whether their place may be recorded at start and end,
 * one row per answer. The latest counts; the ones before stay as the record of
 * when consent was given and when it was withdrawn.
 */
export interface LocationConsent extends TenantOwned {
  readonly id: LocationConsentId
  readonly userId: string
  readonly given: boolean
}

/** The longest a single entry may run: a day, so that a night job past midnight is one entry. */
export const longestEntryMinutes = 24 * 60

function instant(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime()
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)

    return Number.isNaN(parsed) ? null : parsed
  }

  return null
}

/** Whole minutes between two instants, as a list and the warnings count them. */
export function minutesBetween(start: Date | string, end: Date | string): number {
  return Math.round(((instant(end) ?? 0) - (instant(start) ?? 0)) / 60_000)
}

/** Why an entry's times cannot be recorded, or null when they can. */
export function timeEntryProblem(entry: {
  readonly startedAt?: unknown
  readonly endedAt?: unknown
}): string | null {
  const start = instant(entry.startedAt)
  const end = instant(entry.endedAt)

  if (start === null || end === null) {
    return 'Beginn und Ende müssen Zeitpunkte sein.'
  }

  if (end <= start) {
    return 'Das Ende liegt nicht nach dem Beginn.'
  }

  return (end - start) / 60_000 > longestEntryMinutes
    ? 'Ein Eintrag dauert höchstens 24 Stunden. Eine längere Zeit gehört in zwei Einträge.'
    : null
}

/** The first year a record of time can lie in (GHSA-9f85-85g8-g7w3). */
export const firstTimeEntryYear = 1970

/**
 * The year an instant lies in, in Germany, as the database counts it: signed
 * and without a year 0, so that 2026 before the common era is -2026, not the
 * year of its era that the calendar names.
 */
export function germanYear(at: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    era: 'short',
  }).formatToParts(new Date(at))
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const era = parts.find((part) => part.type === 'era')?.value

  return era === 'BC' ? -year : year
}

/**
 * Why the year of an entry is not one OpenGewerk takes, or null: from 1970 to
 * the year after this one, in Germany, as the database counts it (0163). A
 * device asks it before the outbox, so that a year typed wrong does not hold
 * the outbox up. A correction that stays in a year it may keep, the year its
 * chain began in or the year of the entry it corrects, brings no new year,
 * and so an entry from before can still be put right there.
 */
export function timeEntryYearProblem(
  startedAt: unknown,
  now: Date,
  keptYears: readonly number[] = [],
): string | null {
  const start = instant(startedAt)

  if (start === null) {
    return null
  }

  const year = germanYear(start)
  const last = germanYear(now.getTime()) + 1

  if ((year >= firstTimeEntryYear && year <= last) || keptYears.includes(year)) {
    return null
  }

  return `OpenGewerk nimmt Arbeitszeit für die Jahre ${String(firstTimeEntryYear)} bis ${String(last)} an, nicht für ${String(year)}.`
}

function named(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

/**
 * Why a correction cannot be recorded, or null when it can: it needs a reason,
 * and only an entry that corrects another can withdraw it.
 */
export function correctionProblem(entry: {
  readonly correctsEntryId?: unknown
  readonly note?: unknown
  readonly withdrawn?: unknown
}): string | null {
  if (entry.withdrawn === true && !named(entry.correctsEntryId)) {
    return 'Zurückziehen lässt sich nur ein Eintrag, den es gibt.'
  }

  if (named(entry.correctsEntryId) && !(typeof entry.note === 'string' && entry.note.trim())) {
    return 'Eine Korrektur braucht einen Grund.'
  }

  return null
}

function placeProblem(latitude: unknown, longitude: unknown): string | null {
  if (latitude === null || latitude === undefined) {
    return longitude === null || longitude === undefined
      ? null
      : 'Ein Standort besteht aus Breite und Länge.'
  }

  if (!Number.isInteger(latitude) || !Number.isInteger(longitude)) {
    return 'Ein Standort besteht aus Breite und Länge in millionstel Grad.'
  }

  return Math.abs(latitude as number) <= 90_000_000 && Math.abs(longitude as number) <= 180_000_000
    ? null
    : 'Der Standort liegt nicht auf der Erde.'
}

/** Why the places of an entry cannot be recorded, or null when they can. */
export function locationProblem(entry: {
  readonly startLatitudeMicro?: unknown
  readonly startLongitudeMicro?: unknown
  readonly endLatitudeMicro?: unknown
  readonly endLongitudeMicro?: unknown
}): string | null {
  return (
    placeProblem(entry.startLatitudeMicro, entry.startLongitudeMicro) ??
    placeProblem(entry.endLatitudeMicro, entry.endLongitudeMicro)
  )
}

/** The fields that carry a place. Stripped by the server without consent. */
export const locationFields = [
  'startLatitudeMicro',
  'startLongitudeMicro',
  'endLatitudeMicro',
  'endLongitudeMicro',
] as const

/**
 * The entries that count: every one nothing corrects, and no withdrawal. A
 * correction takes the place of what it corrects; a withdrawal takes it away
 * and counts for nothing itself.
 */
export function effectiveEntries<
  Entry extends {
    readonly id?: unknown
    readonly correctsEntryId?: unknown
    readonly withdrawn?: unknown
  },
>(entries: readonly Entry[]): Entry[] {
  const corrected = new Set(entries.map((entry) => entry.correctsEntryId).filter((id) => named(id)))

  return entries.filter((entry) => !corrected.has(entry.id) && entry.withdrawn !== true)
}
