import { describe, expect, it } from 'vitest'

import { shippedRules } from '../rules/shipped.js'
import { tenantParameterProblem } from '../rules/parameter.js'
import { workingTimeWarnings } from '../rules/working-time.js'
import {
  emergencyKindAt,
  emergencySurchargeLine,
  emergencySurchargeText,
  type EmergencyTariff,
  emergencyTariffText,
  chargeableSurcharge,
  namedSurcharge,
  onCallShiftProblem,
  shiftCovers,
  tariffOn,
  tariffStarts,
} from './on-call.js'

/** Wednesday 28.10.2026 at a time of day in Germany (CET, UTC+1). */
const wednesday = (clock: string) => new Date(`2026-10-28T${clock}:00+01:00`)

describe('the kind of an emergency call (#293)', () => {
  it('is the night between its hours, also over midnight', () => {
    expect(emergencyKindAt(wednesday('02:14'), new Set())).toBe('night')
    expect(emergencyKindAt(wednesday('21:30'), new Set())).toBe('night')
    expect(emergencyKindAt(wednesday('10:00'), new Set())).toBeNull()
    expect(emergencyKindAt(wednesday('06:00'), new Set())).toBeNull()
    expect(emergencyKindAt(wednesday('19:59'), new Set())).toBeNull()
  })

  it('follows the night the business sets', () => {
    expect(
      emergencyKindAt(wednesday('19:30'), new Set(), { fromMinute: 19 * 60, untilMinute: 7 * 60 }),
    ).toBe('night')
    expect(
      emergencyKindAt(wednesday('06:30'), new Set(), { fromMinute: 19 * 60, untilMinute: 7 * 60 }),
    ).toBe('night')
  })

  it('is the weekend on Saturday and Sunday, at any hour', () => {
    expect(emergencyKindAt(new Date('2026-10-31T11:00:00+01:00'), new Set())).toBe('weekend')
    expect(emergencyKindAt(new Date('2026-11-01T03:00:00+01:00'), new Set())).toBe('weekend')
  })

  it('is a public holiday of the business before the weekend and the night', () => {
    const holidays = new Set(['2026-10-28', '2026-11-01'])

    expect(emergencyKindAt(wednesday('02:14'), holidays)).toBe('holiday')
    expect(emergencyKindAt(new Date('2026-11-01T03:00:00+01:00'), holidays)).toBe('holiday')
  })

  it('takes the day in Germany, not in UTC', () => {
    // 23:30 UTC on Friday is 00:30 on Saturday in Germany.
    expect(emergencyKindAt(new Date('2026-10-30T23:30:00Z'), new Set())).toBe('weekend')
  })
})

describe('the surcharge line', () => {
  it('is one flat rate at the flat amount', () => {
    expect(emergencySurchargeLine('night', { flatCents: 4500, basisPoints: 0 }, 6800)).toEqual({
      designation: 'Notdienstzuschlag Nacht',
      description: null,
      quantityMilli: 1000,
      unit: 'flat_rate',
      unitPriceCents: 4500,
      netCents: 4500,
    })
  })

  it('comes as a percentage on the working time, rounded to the cent', () => {
    expect(
      emergencySurchargeLine('weekend', { flatCents: 0, basisPoints: 5000 }, 10_201),
    ).toMatchObject({
      designation: 'Notdienstzuschlag Wochenende',
      description: '50 % auf die Arbeitszeit',
      unitPriceCents: 5101,
      netCents: 5101,
    })
  })

  it('is none where the business set nothing for the kind', () => {
    expect(emergencySurchargeLine('holiday', { flatCents: 0, basisPoints: 0 }, 6800)).toBeNull()
  })
})

describe('the surcharge the customer hears before the order (#1024)', () => {
  it('is a flat amount with the tax, for a consumer is owed the total price', () => {
    expect(emergencySurchargeText('night', { flatCents: 4500, basisPoints: 0 }, 1900)).toBe(
      'Notdienstzuschlag Nacht: 53,55 € einschließlich 19 % Umsatzsteuer',
    )
  })

  it('is the flat amount alone for a business that charges no tax', () => {
    expect(emergencySurchargeText('holiday', { flatCents: 4500, basisPoints: 0 }, null)).toBe(
      'Notdienstzuschlag Feiertag: 45,00 €',
    )
  })

  it('is the percentage on the working time, and none where nothing is set', () => {
    expect(emergencySurchargeText('weekend', { flatCents: 0, basisPoints: 2550 }, 1900)).toBe(
      'Notdienstzuschlag Wochenende: 25,5 % auf die Arbeitszeit',
    )
    expect(emergencySurchargeText('weekend', { flatCents: 0, basisPoints: 0 }, 1900)).toBeNull()
  })

  it('is read from the tariff a device keeps, by the kind of the moment', () => {
    const tariff: EmergencyTariff = {
      on: '2026-10-28',
      until: '2026-11-24',
      night: { fromMinute: 22 * 60, untilMinute: 6 * 60 },
      surcharges: {
        night: { flatCents: 4500, basisPoints: 0 },
        weekend: { flatCents: 0, basisPoints: 5000 },
        holiday: { flatCents: 9000, basisPoints: 0 },
      },
      vatBasisPoints: 1900,
      holidays: ['2026-11-01'],
    }

    expect(emergencyTariffText(tariff, wednesday('02:14'))).toMatch(
      /^Notdienstzuschlag Nacht: 53,55/,
    )
    // Before the night the business set, and after the default one began.
    expect(emergencyTariffText(tariff, wednesday('21:00'))).toBeNull()
    expect(emergencyTariffText(tariff, new Date('2026-10-31T11:00:00+01:00'))).toBe(
      'Notdienstzuschlag Wochenende: 50 % auf die Arbeitszeit',
    )
    expect(emergencyTariffText(tariff, new Date('2026-11-01T11:00:00+01:00'))).toMatch(
      /^Notdienstzuschlag Feiertag: 107,10/,
    )
  })
})

describe('the tariffs a device keeps (#1024)', () => {
  const tariff = (on: string, until: string, flatCents: number): EmergencyTariff => ({
    on,
    until,
    night: { fromMinute: 20 * 60, untilMinute: 6 * 60 },
    surcharges: {
      night: { flatCents, basisPoints: 0 },
      weekend: { flatCents: 0, basisPoints: 0 },
      holiday: { flatCents: 0, basisPoints: 0 },
    },
    vatBasisPoints: 1900,
    holidays: [],
  })
  const kept = [tariff('2026-10-26', '2026-10-28', 4500), tariff('2026-10-29', '2026-11-22', 6000)]

  it('hold from their first to their last day, in German time', () => {
    expect(tariffOn(kept, wednesday('02:14'))?.surcharges.night.flatCents).toBe(4500)
    // 23:30 UTC on Wednesday is already Thursday in Germany.
    expect(tariffOn(kept, new Date('2026-10-28T23:30:00Z'))?.surcharges.night.flatCents).toBe(6000)
  })

  it('know nothing of a day before or after them', () => {
    expect(tariffOn(kept, new Date('2026-10-25T12:00:00+01:00'))).toBeNull()
    expect(tariffOn(kept, new Date('2026-11-23T02:00:00+01:00'))).toBeNull()
  })

  it('begin anew on a day a setting begins on, and on a day the rate of tax changes', () => {
    const rate = (day: string) => (day >= '2026-11-10' ? 1600 : 1900)

    expect(
      tariffStarts(
        '2026-11-01',
        '2026-11-29',
        ['2026-11-05', '2026-01-01', '2026-11-30', '2026-11-05'],
        rate,
      ),
    ).toEqual(['2026-11-01', '2026-11-05', '2026-11-10'])
    expect(tariffStarts('2026-11-01', '2026-11-29', [], () => 1900)).toEqual(['2026-11-01'])
  })
})

describe('a time of the on-call plan', () => {
  it('has an end after its beginning, at most four weeks long, and a short note', () => {
    expect(
      onCallShiftProblem('2026-11-02T16:00:00Z', '2026-11-09T06:00:00Z', 'Woche 45'),
    ).toBeNull()
    expect(onCallShiftProblem('2026-11-09T06:00:00Z', '2026-11-02T16:00:00Z', null)).toContain(
      'nach ihrem Beginn',
    )
    expect(onCallShiftProblem('2026-11-01T00:00:00Z', '2026-12-15T00:00:00Z', null)).toContain(
      'höchstens 28 Tage',
    )
    expect(onCallShiftProblem('x', '2026-11-02T16:00:00Z', null)).toContain('Beginn und Ende')
    expect(
      onCallShiftProblem('2026-11-02T16:00:00Z', '2026-11-09T06:00:00Z', 'x'.repeat(201)),
    ).toContain('200')
  })

  it('covers a moment from its beginning up to but not including its end', () => {
    const shift = { startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-09T06:00:00Z' }

    expect(shiftCovers(shift, new Date('2026-11-02T16:00:00Z'))).toBe(true)
    expect(shiftCovers(shift, new Date('2026-11-09T06:00:00Z'))).toBe(false)
    expect(shiftCovers(shift, new Date('2026-11-02T15:59:00Z'))).toBe(false)
  })
})

describe('the settings of the surcharges', () => {
  it('are whole numbers, hours of the day and percentages up to 1.000 %', () => {
    expect(tenantParameterProblem('emergency.night_flat_cents', 4500)).toBeNull()
    expect(tenantParameterProblem('emergency.night_flat_cents', -1)).toContain('nicht negativ')
    expect(tenantParameterProblem('emergency.night_from_minute', 1440)).toContain('23:59')
    expect(tenantParameterProblem('emergency.weekend_basis_points', 100_001)).toContain('1.000 %')
  })
})

describe('a call taken on call and the rest period (#293)', () => {
  it('breaks the rest period, and the warning of the next day says so', () => {
    const work = (startedAt: string, endedAt: string) => ({ kind: 'work', startedAt, endedAt })
    const entries = [
      work('2026-10-27T07:00:00+01:00', '2026-10-27T16:00:00+01:00'),
      // The call at night, from 02:14 to 03:30.
      work('2026-10-28T02:14:00+01:00', '2026-10-28T03:30:00+01:00'),
      work('2026-10-28T07:00:00+01:00', '2026-10-28T16:00:00+01:00'),
    ]

    expect(
      workingTimeWarnings(entries, '2026-10-28', shippedRules).map((warning) => warning.kind),
    ).toContain('rest')
  })
})

describe('the surcharge named before the order and the one charged (#1081)', () => {
  const tariff: EmergencyTariff = {
    on: '2026-10-26',
    until: '2026-11-22',
    night: { fromMinute: 20 * 60, untilMinute: 6 * 60 },
    surcharges: {
      night: { flatCents: 4500, basisPoints: 0 },
      weekend: { flatCents: 0, basisPoints: 5000 },
      holiday: { flatCents: 0, basisPoints: 0 },
    },
    vatBasisPoints: 1900,
    holidays: [],
  }

  it('is the surcharge of the kind of the call by the tariff named from', () => {
    expect(namedSurcharge(tariff, wednesday('02:14'))).toEqual({ flatCents: 4500, basisPoints: 0 })
    expect(namedSurcharge(tariff, new Date('2026-10-31T11:00:00+01:00'))).toEqual({
      flatCents: 0,
      basisPoints: 5000,
    })
  })

  it('is nothing without a tariff, and in ordinary hours', () => {
    expect(namedSurcharge(null, wednesday('02:14'))).toEqual({ flatCents: 0, basisPoints: 0 })
    expect(namedSurcharge(tariff, wednesday('10:00'))).toEqual({ flatCents: 0, basisPoints: 0 })
  })

  it('charges the one of the day where nothing was recorded, or where it comes to less', () => {
    const day = { flatCents: 6000, basisPoints: 0 }

    expect(chargeableSurcharge(day, null, 10_000)).toBe(day)
    expect(chargeableSurcharge(day, { flatCents: 4500, basisPoints: 0 }, 10_000)).toEqual({
      flatCents: 4500,
      basisPoints: 0,
    })
    expect(
      chargeableSurcharge(
        { flatCents: 3000, basisPoints: 0 },
        { flatCents: 4500, basisPoints: 0 },
        0,
      ),
    ).toEqual({
      flatCents: 3000,
      basisPoints: 0,
    })
  })

  it('compares a flat amount with a percentage on the hours of the invoice', () => {
    const percent = { flatCents: 0, basisPoints: 5000 }
    const flat = { flatCents: 4500, basisPoints: 0 }

    // 50 % of 60,00 € is 30,00 €, less than 45,00 €; of 120,00 € it is more.
    expect(chargeableSurcharge(flat, percent, 6000)).toBe(percent)
    expect(chargeableSurcharge(flat, percent, 12_000)).toBe(flat)
  })

  it('never charges more than was named on hours without a price yet', () => {
    const weekend = { flatCents: 0, basisPoints: 5000 }

    expect(chargeableSurcharge(weekend, { flatCents: 0, basisPoints: 0 }, null)).toEqual({
      flatCents: 0,
      basisPoints: 0,
    })
    expect(chargeableSurcharge(weekend, { flatCents: 0, basisPoints: 3000 }, null)).toEqual({
      flatCents: 0,
      basisPoints: 3000,
    })
    expect(
      chargeableSurcharge(
        { flatCents: 0, basisPoints: 2000 },
        { flatCents: 0, basisPoints: 3000 },
        null,
      ),
    ).toEqual({
      flatCents: 0,
      basisPoints: 2000,
    })
    // A flat amount against a percentage: without a price of the hours what was named.
    expect(chargeableSurcharge(weekend, { flatCents: 4500, basisPoints: 0 }, null)).toEqual({
      flatCents: 4500,
      basisPoints: 0,
    })
  })

  it('takes a percentage on no working time at all for what it costs, nothing', () => {
    // A report of flat amounts alone: 50 % of no hours is less than 45,00 €.
    expect(
      chargeableSurcharge(
        { flatCents: 0, basisPoints: 5000 },
        { flatCents: 4500, basisPoints: 0 },
        0,
      ),
    ).toEqual({ flatCents: 0, basisPoints: 5000 })
  })

  it('charges nothing where the settings charge nothing, whatever was named', () => {
    expect(
      chargeableSurcharge(
        { flatCents: 0, basisPoints: 0 },
        { flatCents: 4500, basisPoints: 0 },
        // On hours without a price yet as well.
        null,
      ),
    ).toEqual({
      flatCents: 0,
      basisPoints: 0,
    })
  })

  it('charges nothing where nothing was named', () => {
    expect(
      chargeableSurcharge(
        { flatCents: 4500, basisPoints: 0 },
        { flatCents: 0, basisPoints: 0 },
        6800,
      ),
    ).toEqual({
      flatCents: 0,
      basisPoints: 0,
    })
  })
})
