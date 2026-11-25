import {
  addDays,
  applyRate,
  berlinClock,
  type IsoDate,
  type Synced,
} from '@opengewerk/platform-domain'

import type { OnCallShiftId } from './identifier.js'

/**
 * A time of the on-call plan (#293, Feature-Gliederung 4.1, 4.3): who is on
 * call from when until when, nights, weekends and public holidays alike, as
 * the time they lie in. Kept in the office at its routes; a device reads the
 * times of its own person, which is what lets it make a service call while
 * on call and not otherwise. Two times swap their people, and the change log
 * keeps who did.
 */
export interface OnCallShift extends Synced {
  readonly id: OnCallShiftId
  readonly userId: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly note: string | null
}

/** The longest note of a time of the plan, which `on_call_shifts_note_short` holds. */
export const longestOnCallNote = 200

/** The longest time one entry of the plan may span: four weeks, a rota of a month at most. */
export const longestOnCallDays = 28

/** What is wrong with a time of the plan, or null when nothing is. */
export function onCallShiftProblem(
  startsAt: unknown,
  endsAt: unknown,
  note: unknown,
): string | null {
  const start = startsAt instanceof Date ? startsAt : new Date(String(startsAt))
  const end = endsAt instanceof Date ? endsAt : new Date(String(endsAt))

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Eine Bereitschaft braucht Beginn und Ende.'
  }

  if (end.getTime() <= start.getTime()) {
    return 'Das Ende einer Bereitschaft liegt nach ihrem Beginn.'
  }

  if (end.getTime() - start.getTime() > longestOnCallDays * 86_400_000) {
    return `Eine Bereitschaft dauert höchstens ${String(longestOnCallDays)} Tage. Für einen längeren Plan mehrere eintragen.`
  }

  if (
    note !== null &&
    note !== undefined &&
    (typeof note !== 'string' || note.length > longestOnCallNote)
  ) {
    return `Die Notiz hat höchstens ${String(longestOnCallNote)} Zeichen.`
  }

  return null
}

/** Whether a time of the plan covers a moment: from its beginning, up to but not including its end. */
export function shiftCovers(
  shift: { readonly startsAt: Date | string; readonly endsAt: Date | string },
  moment: Date,
): boolean {
  const at = moment.getTime()

  return new Date(shift.startsAt).getTime() <= at && at < new Date(shift.endsAt).getTime()
}

/**
 * The kinds of an emergency call (#293), by when the customer called: on a
 * public holiday, at the weekend, at night. Each has its own surcharge.
 */
export const emergencyKinds = ['night', 'weekend', 'holiday'] as const

export type EmergencyKind = (typeof emergencyKinds)[number]

export const emergencyKindLabel: Readonly<Record<EmergencyKind, string>> = {
  night: 'Nacht',
  weekend: 'Wochenende',
  holiday: 'Feiertag',
}

/** The night of the surcharge when the business sets none: 20:00 to 06:00. */
export const defaultNight = { fromMinute: 20 * 60, untilMinute: 6 * 60 } as const

/**
 * The kind of a call at a moment, or null for one in ordinary hours: a public
 * holiday of the business first, then Saturday and Sunday, then the night,
 * which may run over midnight. All in German time.
 */
export function emergencyKindAt(
  moment: Date,
  holidays: ReadonlySet<IsoDate>,
  night: { readonly fromMinute: number; readonly untilMinute: number } = defaultNight,
): EmergencyKind | null {
  const { day, minute } = berlinClock(moment)

  if (holidays.has(day)) {
    return 'holiday'
  }

  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()

  if (weekday === 0 || weekday === 6) {
    return 'weekend'
  }

  const { fromMinute, untilMinute } = night
  const atNight =
    fromMinute <= untilMinute
      ? minute >= fromMinute && minute < untilMinute
      : minute >= fromMinute || minute < untilMinute

  return atNight ? 'night' : null
}

/** What the business set for one kind on a day: a flat amount, or a percentage of the working time. */
export interface EmergencySurcharge {
  readonly flatCents: number
  readonly basisPoints: number
}

/** A line of a document as the surcharge makes it. */
export interface SurchargeLine {
  readonly designation: string
  readonly description: string | null
  readonly quantityMilli: number
  readonly unit: 'flat_rate'
  readonly unitPriceCents: number
  readonly netCents: number
}

/**
 * The line an invoice gets for the surcharge of a call (#293), or null when
 * the business set none for its kind. A flat amount is one flat rate at that
 * amount; a percentage comes on the net of the lines in hours, rounded to the
 * cent. Lines in hours without a price yet give a surcharge of nothing,
 * which the office prices with them, and so do lines in hours that come to
 * less than nothing (#1099): a surcharge is never a credit, and a smaller
 * percentage of them would come to the larger amount.
 */
export function emergencySurchargeLine(
  kind: EmergencyKind,
  surcharge: EmergencySurcharge,
  hourNetCents: number,
): SurchargeLine | null {
  const designation = `Notdienstzuschlag ${emergencyKindLabel[kind]}`

  if (surcharge.flatCents > 0) {
    return {
      designation,
      description: null,
      quantityMilli: 1000,
      unit: 'flat_rate',
      unitPriceCents: surcharge.flatCents,
      netCents: surcharge.flatCents,
    }
  }

  if (surcharge.basisPoints > 0) {
    const cents = Math.round((Math.max(0, hourNetCents) * surcharge.basisPoints) / 10_000)
    const percent = (surcharge.basisPoints / 100).toLocaleString('de-DE', {
      maximumFractionDigits: 2,
    })

    return {
      designation,
      description: `${percent} % auf die Arbeitszeit`,
      quantityMilli: 1000,
      unit: 'flat_rate',
      unitPriceCents: cents,
      netCents: cents,
    }
  }

  return null
}

/** What is wrong with a value of a surcharge setting, or null. */
export function emergencyParameterProblem(unit: string, value: number): string | null {
  if (!Number.isInteger(value) || value < 0) {
    return 'Ein Notdienstzuschlag ist eine ganze Zahl, nicht negativ.'
  }

  if (unit === 'minutes' && value >= 24 * 60) {
    return 'Beginn und Ende der Nacht sind Uhrzeiten zwischen 00:00 und 23:59.'
  }

  if (unit === 'basis_points' && value > 100_000) {
    return 'Ein Aufschlag liegt zwischen 0 und 1.000 %.'
  }

  if (unit === 'cents' && value > 100_000_000) {
    return 'Eine Pauschale liegt unter 1.000.000 €.'
  }

  return null
}

/**
 * What a device keeps to name the surcharge of a call where it has no network
 * (#1024): the night, the surcharge of each kind, the tax on a flat amount and
 * the public holidays, from the first day these values hold (`on`) to the
 * last (`until`).
 */
export interface EmergencyTariff {
  readonly on: IsoDate
  readonly until: IsoDate
  readonly night: { readonly fromMinute: number; readonly untilMinute: number }
  readonly surcharges: Readonly<Record<EmergencyKind, EmergencySurcharge>>
  /**
   * The tax on a flat amount in basis points; null for a business under
   * section 19 UStG, which charges none.
   */
  readonly vatBasisPoints: number | null
  readonly holidays: readonly IsoDate[]
}

const euros = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

function percentOf(basisPoints: number): string {
  return (basisPoints / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })
}

/**
 * The surcharge of a kind as the customer hears it before giving the order
 * (#1024): section 312e BGB lets a business charge a consumer other costs
 * only after it told them. A flat amount with the tax, since a consumer is
 * owed the total price, or the percentage on the working time. Null where the
 * business set none for the kind.
 */
export function emergencySurchargeText(
  kind: EmergencyKind,
  surcharge: EmergencySurcharge,
  vatBasisPoints: number | null,
): string | null {
  const name = `Notdienstzuschlag ${emergencyKindLabel[kind]}`

  if (surcharge.flatCents > 0) {
    if (vatBasisPoints === null) {
      return `${name}: ${euros.format(surcharge.flatCents / 100)}`
    }

    const gross = surcharge.flatCents + applyRate(surcharge.flatCents, vatBasisPoints)

    return `${name}: ${euros.format(gross / 100)} einschließlich ${percentOf(vatBasisPoints)} % Umsatzsteuer`
  }

  if (surcharge.basisPoints > 0) {
    return `${name}: ${percentOf(surcharge.basisPoints)} % auf die Arbeitszeit`
  }

  return null
}

/**
 * The surcharge of a call at a moment by a tariff (#1024), or null for a call
 * in ordinary hours and for a kind the business set none for.
 */
export function emergencyTariffText(tariff: EmergencyTariff, moment: Date): string | null {
  const kind = emergencyKindAt(moment, new Set(tariff.holidays), tariff.night)

  return kind === null
    ? null
    : emergencySurchargeText(kind, tariff.surcharges[kind], tariff.vatBasisPoints)
}

/**
 * The tariff that holds on the day of a moment, among those a device keeps
 * (#1024), or null where none does: a device that has been without a network
 * for longer than they reach does not know the surcharge, and says so.
 */
export function tariffOn(
  tariffs: readonly EmergencyTariff[],
  moment: Date,
): EmergencyTariff | null {
  const { day } = berlinClock(moment)

  return tariffs.find((tariff) => tariff.on <= day && day <= tariff.until) ?? null
}

/**
 * The days on which a new tariff begins within the days from `from` to
 * `until` (#1024): `from` itself, every day a setting begins on, and every
 * day the rate of tax differs from the day before. In order, each once.
 */
export function tariffStarts(
  from: IsoDate,
  until: IsoDate,
  settingDays: readonly IsoDate[],
  rateOn: (day: IsoDate) => number,
): IsoDate[] {
  const starts = new Set<IsoDate>([from])

  for (const day of settingDays) {
    if (day > from && day <= until) {
      starts.add(day)
    }
  }

  for (let day = addDays(from, 1); day <= until; day = addDays(day, 1)) {
    if (rateOn(day) !== rateOn(addDays(day, -1))) {
      starts.add(day)
    }
  }

  return [...starts].sort()
}

/**
 * What a device records as named for a call to a consumer (#1081): the
 * surcharge of the kind of the call by the tariff it named it from, nothing
 * (both zero) where it knew no tariff for the day, was still asking, or the
 * call falls in ordinary hours. The invoice charges no more than this.
 */
export function namedSurcharge(tariff: EmergencyTariff | null, moment: Date): EmergencySurcharge {
  const kind = tariff ? emergencyKindAt(moment, new Set(tariff.holidays), tariff.night) : null

  return tariff && kind ? tariff.surcharges[kind] : { flatCents: 0, basisPoints: 0 }
}

/**
 * The tax a device records with the surcharge it names (#1083): the one of
 * the tariff it named it from, 0 under section 19 UStG, and null without a
 * tariff, where it named nothing.
 */
export function namedSurchargeVat(tariff: EmergencyTariff | null): number | null {
  return tariff ? (tariff.vatBasisPoints ?? 0) : null
}

/** The most a net amount may be whose total with tax at `basisPoints` is no more than `gross`. */
export function netWithin(gross: number, basisPoints: number): number {
  let net = Math.floor((gross * 10_000) / (10_000 + basisPoints))

  while (net > 0 && net + applyRate(net, basisPoints) > gross) {
    net -= 1
  }

  while (net + 1 + applyRate(net + 1, basisPoints) <= gross) {
    net += 1
  }

  return net
}

function isNothing(surcharge: EmergencySurcharge): boolean {
  return surcharge.flatCents === 0 && surcharge.basisPoints === 0
}

/**
 * The surcharge an invoice may charge for a call (#1081). Section 312e BGB
 * lets a business charge a consumer other costs only after it told them, so
 * what was named before the order is the most: nothing named, nothing
 * charged. Below that, the one of the day where it is less: two flat amounts
 * or two percentages compared as they are, a flat amount against a
 * percentage on the hours of the invoice. Hours without a price yet
 * (`hourNetCents` null) decide nothing, where a report with no hours at all
 * (zero) makes a percentage cost nothing; an equal amount goes to what was
 * named, so that the invoice never shows more than the customer heard. With
 * nothing recorded, the one of the day.
 *
 * A flat amount named with its tax (#1083, `tax.named`) is held to the total
 * the customer heard: on the invoice, with the tax of the line (`tax.line`, 0
 * without tax), it comes to no more than that, whether the tax changed
 * between the call and the invoice or not.
 */
export function chargeableSurcharge(
  day: EmergencySurcharge,
  heard: EmergencySurcharge | null,
  hourNetCents: number | null,
  tax: { readonly named: number | null; readonly line: number } | null = null,
): EmergencySurcharge {
  if (heard === null || isNothing(day)) {
    return day
  }

  const named =
    tax !== null && tax.named !== null && heard.flatCents > 0
      ? {
          ...heard,
          flatCents: netWithin(heard.flatCents + applyRate(heard.flatCents, tax.named), tax.line),
        }
      : heard

  const flat = (surcharge: EmergencySurcharge) => surcharge.flatCents > 0

  if (flat(named) && flat(day)) {
    return day.flatCents < named.flatCents ? day : named
  }

  if (!flat(named) && !flat(day)) {
    return day.basisPoints < named.basisPoints ? day : named
  }

  if (hourNetCents === null) {
    return named
  }

  const cost = (surcharge: EmergencySurcharge) =>
    flat(surcharge)
      ? surcharge.flatCents
      : Math.round((hourNetCents * surcharge.basisPoints) / 10_000)

  return cost(day) < cost(named) ? day : named
}
