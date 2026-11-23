import {
  type CircuitFacts,
  fieldsOf,
  type FormDefinition,
  limitVerdict,
  type MeasurementField,
  type MeasuringConditions,
  measuringConditions,
} from '@opengewerk/domain'
import { describe, expect, it } from 'vitest'

import { elektroRegistry, elektroRules } from './index.js'

/**
 * Version 4 of the first inspection after DIN VDE 0100-600 (#1021), judged
 * with the rules of this package as a protocol is: the four questions of the
 * expert review of 20.11.2026 (#31), each with the case that was judged too
 * mildly or too strictly before, and version 3 unchanged for the protocols
 * filled in it.
 */

const on = '2026-11-20'

function measurementOf(version: number, key: string, form = 'vde-0100-600'): MeasurementField {
  const definition = elektroRegistry.definitionFor(form, version) as FormDefinition
  const circuits = fieldsOf(definition).find((field) => field.key === 'circuits')
  const found =
    circuits?.kind === 'group' ? circuits.fields.find((field) => field.key === key) : undefined

  if (found?.kind !== 'measurement') {
    throw new Error(`No measurement ${key} in version ${String(version)} of ${form}`)
  }

  return found
}

/** A socket circuit behind a B 16 A and an RCD of 30 mA, as most are. */
const ordinary: CircuitFacts = {
  tripCharacteristic: 'b',
  ratedCurrentMilli: 16_000,
  ratedResidualCurrentMilli: 30,
  voltageClass: 'up_to_500',
  rcdSelective: false,
}

function judge(key: string, milli: number, circuit: CircuitFacts = ordinary, version = 4) {
  return limitVerdict(measurementOf(version, key), milli, { rules: elektroRules, on, circuit })
}

describe('version 4 of the first inspection (#1021)', () => {
  it('judges the insulation by the nominal voltage of the circuit, after Table 6.1', () => {
    // A SELV circuit with 0,6 MΩ was outside the 1 MΩ of the circuits up to 500 V.
    expect(
      judge('insulation_resistance', 600, { ...ordinary, voltageClass: 'selv_pelv' }),
    ).toMatchObject({
      within: true,
      text: 'Innerhalb des Grenzwerts, mindestens 0,50 MΩ.',
    })
    expect(
      judge('insulation_resistance', 400, { ...ordinary, voltageClass: 'selv_pelv' }).within,
    ).toBe(false)
    expect(judge('insulation_resistance', 600)).toMatchObject({
      within: false,
      text: 'Außerhalb des Grenzwerts, mindestens 1,00 MΩ.',
    })
    expect(
      judge('insulation_resistance', 900, { ...ordinary, voltageClass: 'above_500' }).within,
    ).toBe(false)
    // A block from before the chart knew the voltage: up to 500 V.
    const { voltageClass: _left, ...before } = ordinary

    expect(judge('insulation_resistance', 600, before).within).toBe(false)
  })

  it('judges the loop impedance against two thirds of U0 / Ia, and asks for Annex D above it', () => {
    // 230 V over five times 16 A is 2,875 Ω; two thirds of it 1,916 Ω.
    expect(judge('loop_impedance', 1_950)).toEqual({
      within: false,
      limitMilli: 1_916,
      text:
        'Außerhalb des Grenzwerts, höchstens 1,916 Ω. ' +
        'Eine genauere Bewertung nach Anhang D der DIN VDE 0100-600 ist nötig.',
      source: expect.stringMatching(
        /^DIN VDE 0100-600 \(VDE 0100-600\):2017-06, Anhang D; DIN VDE 0100-410/,
      ),
    })
    expect(judge('loop_impedance', 1_900)).toMatchObject({
      within: true,
      text: 'Innerhalb des Grenzwerts, höchstens 1,916 Ω.',
    })
    // B 6 A: 230 V over 30 A is 7,666 Ω, two thirds of it 5,111 Ω, never 5,10 Ω.
    expect(judge('loop_impedance', 5_110, { ...ordinary, ratedCurrentMilli: 6_000 })).toMatchObject(
      {
        within: true,
        limitMilli: 5_110,
        text: 'Innerhalb des Grenzwerts, höchstens 5,11 Ω.',
      },
    )
  })

  it('takes the tripping current above half of IΔn up to all of it', () => {
    // An RCD that trips below half of IΔn is too sensitive, or the circuit leaks;
    // at half of it, the rated non-operating current, it must not trip at all.
    expect(judge('rcd_trip_current', 14_000)).toMatchObject({
      within: false,
      fromMilli: 15_001,
      limitMilli: 30_000,
      text: 'Außerhalb des Grenzwerts, über 15,0 bis 30,0 mA.',
      source:
        'DIN EN 61008-1 (VDE 0664-10):2018-03, 5.3.4 und 8.5, Auslösung zwischen 0,5 IΔn und IΔn',
    })
    expect(judge('rcd_trip_current', 15_000).within).toBe(false)
    expect(judge('rcd_trip_current', 15_100).within).toBe(true)
    expect(judge('rcd_trip_current', 30_000).within).toBe(true)
    expect(judge('rcd_trip_current', 30_100).within).toBe(false)
  })

  it('gives a selective RCD 130 to 500 ms, and one without delay at most 300 ms', () => {
    const selective = { ...ordinary, rcdSelective: true }

    // A sound type S tripping after 400 ms was outside the 300 ms.
    expect(judge('rcd_trip_time', 400_000, selective)).toMatchObject({
      within: true,
      fromMilli: 130_000,
      limitMilli: 500_000,
      text: 'Innerhalb des Grenzwerts, zwischen 130 und 500 ms.',
    })
    expect(judge('rcd_trip_time', 120_000, selective).within).toBe(false)
    expect(judge('rcd_trip_time', 501_000, selective).within).toBe(false)
    expect(judge('rcd_trip_time', 400_000)).toMatchObject({
      within: false,
      text: 'Außerhalb des Grenzwerts, höchstens 300 ms.',
    })
  })

  it('leaves version 3 as it judged, for the protocols filled in it', () => {
    const selv = { ...ordinary, voltageClass: 'selv_pelv' as const }

    expect(judge('insulation_resistance', 600, selv, 3).within).toBe(false)
    expect(judge('loop_impedance', 1_950, ordinary, 3).within).toBe(true)
    expect(judge('rcd_trip_current', 14_000, ordinary, 3).within).toBe(true)
    expect(judge('rcd_trip_time', 400_000, { ...ordinary, rcdSelective: true }, 3).within).toBe(
      false,
    )
  })
})

/**
 * Version 2 of the recurring inspection after DIN VDE 0105-100 (#1022): the
 * insulation after the whole of table 11 of the DGUV Information 203-072, by
 * the environment of the circuit, the earthing system and SELV or PELV, and
 * the loop impedance and tripping current as version 4 of the first
 * inspection, which section 3.4.3.1.1 of the information names for the
 * recurring inspection as well.
 */
describe('version 2 of the recurring inspection (#1022)', () => {
  const recurring = (
    key: string,
    milli: number,
    conditions: MeasuringConditions = {},
    circuit: CircuitFacts | null = ordinary,
    version = 2,
  ) =>
    limitVerdict(measurementOf(version, key, 'vde-0105-100'), milli, {
      rules: elektroRules,
      on,
      circuit,
      conditions,
    })
  const damp = { environment: 'damp' } as const
  const itSystem = { earthingSystem: 'it' }

  it('judges the insulation without the loads at 1000 Ω per volt dry and 500 Ω per volt damp', () => {
    expect(recurring('insulation_without_loads', 229)).toMatchObject({
      within: false,
      limitMilli: 230,
    })
    expect(recurring('insulation_without_loads', 230).within).toBe(true)
    // A damp circuit with 0,120 MΩ was outside the 0,230 MΩ of a dry one.
    expect(recurring('insulation_without_loads', 120, damp)).toMatchObject({
      within: true,
      limitMilli: 115,
      text: 'Innerhalb des Grenzwerts, mindestens 0,115 MΩ.',
    })
    expect(recurring('insulation_without_loads', 114, damp).within).toBe(false)
  })

  it('judges the insulation with the loads at 300 Ω per volt dry and 150 Ω per volt damp, never looser', () => {
    expect(recurring('insulation_with_loads', 68)).toMatchObject({ within: false, limitMilli: 69 })
    // 150 Ω per volt at 230 V are 34,5 kΩ, held to 35 kΩ.
    expect(recurring('insulation_with_loads', 34, damp)).toMatchObject({
      within: false,
      limitMilli: 35,
      text: 'Außerhalb des Grenzwerts, mindestens 0,035 MΩ.',
    })
    expect(recurring('insulation_with_loads', 35, damp).within).toBe(true)
  })

  it('judges the insulation in an IT system at 50 Ω per volt, with and without loads, dry and damp', () => {
    for (const key of ['insulation_without_loads', 'insulation_with_loads']) {
      expect(recurring(key, 12, itSystem)).toMatchObject({ within: true, limitMilli: 12 })
      expect(recurring(key, 11, { ...itSystem, ...damp }).within).toBe(false)
    }
  })

  it('judges SELV and PELV at 0,25 MΩ in every column, and says what it lacks above 500 V', () => {
    const selv = { ...ordinary, voltageClass: 'selv_pelv' as const }

    for (const key of ['insulation_without_loads', 'insulation_with_loads']) {
      expect(recurring(key, 249, itSystem, selv)).toMatchObject({ within: false, limitMilli: 250 })
      expect(recurring(key, 250, damp, selv).within).toBe(true)
      expect(recurring(key, 900, {}, { ...ordinary, voltageClass: 'above_500' })).toMatchObject({
        within: null,
        text: 'Über 500 V gilt der Mindestwert je Volt der Nennspannung des Stromkreises, und die nennt das Stromkreisverzeichnis nicht.',
      })
    }
  })

  it('judges per volt of the nominal voltage the protocol names, and of 230 V without one', () => {
    // An IT system of 400 V asks 20 kΩ, where 230 V would let 12 kΩ through.
    expect(
      recurring('insulation_without_loads', 15, { ...itSystem, nominalVoltageMilli: 400_000 }),
    ).toMatchObject({ within: false, limitMilli: 20 })
    // 110 V: 5,5 kΩ, held to 6 kΩ.
    expect(
      recurring('insulation_with_loads', 6, { ...itSystem, nominalVoltageMilli: 110_000 }),
    ).toMatchObject({ within: true, limitMilli: 6 })
    expect(
      recurring('insulation_without_loads', 229, { nominalVoltageMilli: 230_000 }).within,
    ).toBe(false)
  })

  it('judges a block without a circuit by the conditions alone', () => {
    expect(recurring('insulation_without_loads', 120, damp, null)).toMatchObject({
      within: true,
      limitMilli: 115,
    })
    expect(recurring('insulation_without_loads', 120, {}, null).within).toBe(false)
  })

  it('judges the loop impedance and the tripping current as version 4 of the first inspection', () => {
    expect(recurring('loop_impedance', 1_950)).toMatchObject({
      within: false,
      limitMilli: 1_916,
      text:
        'Außerhalb des Grenzwerts, höchstens 1,916 Ω. ' +
        'Eine genauere Bewertung nach Anhang D der DIN VDE 0100-600 ist nötig.',
    })
    expect(recurring('rcd_trip_current', 15_000).within).toBe(false)
    expect(recurring('rcd_trip_current', 15_100).within).toBe(true)
    const selective = { ...ordinary, rcdSelective: true }

    // A selective RCD between 130 and 500 ms, one without delay at most 300 ms.
    expect(recurring('rcd_trip_time', 400_000, {}, selective).within).toBe(true)
    expect(recurring('rcd_trip_time', 100_000, {}, selective).within).toBe(false)
    expect(recurring('rcd_trip_time', 400_000).within).toBe(false)
  })

  it('takes nothing of a circuit over from the last protocol, so that a circuit starts with nothing entered', () => {
    const definition = elektroRegistry.definitionFor('vde-0105-100', 2) as FormDefinition
    const circuits = fieldsOf(definition).find((field) => field.key === 'circuits')
    const fields = circuits?.kind === 'group' ? circuits.fields : []

    expect(fields.map((field) => field.key)).toContain('environment')
    expect(fields.filter((field) => field.carry === true)).toEqual([])
  })

  it('leaves version 1 as it judged, for the protocols filled in it', () => {
    expect(recurring('insulation_without_loads', 120, damp, ordinary, 1).within).toBe(false)
    expect(recurring('insulation_with_loads', 12, itSystem, ordinary, 1).within).toBe(false)
    expect(recurring('loop_impedance', 1_950, {}, ordinary, 1).within).toBe(true)
  })

  it('takes the conditions from the block and the head of the protocol, and only what it knows', () => {
    expect(
      measuringConditions(
        { environment: 'damp' },
        { earthing_system: 'it', nominal_voltage: 400_000 },
      ),
    ).toEqual({ environment: 'damp', earthingSystem: 'it', nominalVoltageMilli: 400_000 })
    expect(
      measuringConditions({ environment: 'nass' }, { earthing_system: 4, nominal_voltage: 0 }),
    ).toEqual({})
    expect(measuringConditions({}, { nominal_voltage: '400' })).toEqual({})
    expect(measuringConditions(undefined, null)).toEqual({})
  })
})

describe('version 2 of the commissioning protocol of a wallbox (#1075)', () => {
  function chargingMeasurement(version: number, key: string): MeasurementField {
    const definition = elektroRegistry.definitionFor('vde-0100-722', version) as FormDefinition
    const found = fieldsOf(definition).find((field) => field.key === key)

    if (found?.kind !== 'measurement') {
      throw new Error(`No measurement ${key} in version ${String(version)} of vde-0100-722`)
    }

    return found
  }

  function judged(milli: number, version = 2, form: Record<string, unknown> = {}) {
    return limitVerdict(chargingMeasurement(version, 'rcd_trip_current'), milli, {
      rules: elektroRules,
      on,
      circuit: null,
      conditions: measuringConditions(null, form),
    })
  }

  it('judges the tripping current above half up to all of the 30 mA of the charging point', () => {
    // Milliamperes in thousandths: 15 mA is 15 000.
    expect(judged(15_000)).toMatchObject({ within: false, fromMilli: 15_001, limitMilli: 30_000 })
    expect(judged(15_100)).toMatchObject({ within: true })
    expect(judged(30_000)).toMatchObject({ within: true })
    expect(judged(30_100)).toMatchObject({ within: false })
    expect(judged(12_000)?.text).toBe('Außerhalb des Grenzwerts, über 15,0 bis 30,0 mA.')
    // The 30 mA per connection point and the range of DIN EN 61008-1.
    expect(judged(12_000)?.source).toContain('722.531.3.101')
    expect(judged(12_000)?.source).toContain('61008-1')
  })

  it('judges an RCD of 10 mA between half and all of its own rated residual current', () => {
    const ten = { rcd_rated_residual_current: '10' }

    expect(judged(5000, 2, ten)).toMatchObject({
      within: false,
      fromMilli: 5001,
      limitMilli: 10_000,
    })
    expect(judged(8000, 2, ten)).toMatchObject({ within: true })
    expect(judged(10_100, 2, ten)).toMatchObject({ within: false })
    // The range is that of DIN EN 61008-1, the 30 mA of DIN VDE 0100-722 are not the limit then.
    expect(judged(8000, 2, ten)?.source).not.toContain('722.531.3.101')
    expect(judged(8000, 2, { rcd_rated_residual_current: '30' })).toMatchObject({ within: false })
  })

  it('judges nothing before DIN VDE 0100-722 asked for the RCD, named or not', () => {
    const before = (form: Record<string, unknown>) =>
      limitVerdict(chargingMeasurement(2, 'rcd_trip_current'), 12_000, {
        rules: elektroRules,
        on: '2019-05-31',
        circuit: null,
        conditions: measuringConditions(null, form),
      })

    expect(before({})).toMatchObject({ within: null, limitMilli: null })
    expect(before({ rcd_rated_residual_current: '30' })).toMatchObject({
      within: null,
      limitMilli: null,
    })
  })

  it('reads the rated residual current of the protocol in whole milliamperes up to 30', () => {
    expect(measuringConditions(null, { rcd_rated_residual_current: '10' })).toEqual({
      rcdRatedResidualMicro: 10_000,
    })
    expect(measuringConditions(null, { rcd_rated_residual_current: '30' })).toEqual({
      rcdRatedResidualMicro: 30_000,
    })

    for (const odd of ['300', '0', '31', '10.5', 'zehn', 10, null]) {
      expect(measuringConditions(null, { rcd_rated_residual_current: odd })).toEqual({})
    }
  })

  it('leaves version 1 as it was for the protocols filled in it', () => {
    expect(judged(12_000, 1)).toMatchObject({ within: true, limitMilli: 30_000 })
    expect(judged(12_000, 1)).not.toHaveProperty('fromMilli')
  })
})
