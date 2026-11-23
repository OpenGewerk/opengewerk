import {
  type CircuitFacts,
  fieldsOf,
  type FormDefinition,
  limitVerdict,
  type MeasurementField,
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

function measurementOf(version: number, key: string): MeasurementField {
  const definition = elektroRegistry.definitionFor('vde-0100-600', version) as FormDefinition
  const circuits = fieldsOf(definition).find((field) => field.key === 'circuits')
  const found =
    circuits?.kind === 'group' ? circuits.fields.find((field) => field.key === key) : undefined

  if (found?.kind !== 'measurement') {
    throw new Error(`No measurement ${key} in version ${String(version)}`)
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
        'Außerhalb des Grenzwerts, höchstens 1,91 Ω. ' +
        'Eine genauere Bewertung nach Anhang D der DIN VDE 0100-600 ist nötig.',
      source: expect.stringMatching(
        /^DIN VDE 0100-600 \(VDE 0100-600\):2017-06, Anhang D; DIN VDE 0100-410/,
      ),
    })
    expect(judge('loop_impedance', 1_900)).toMatchObject({
      within: true,
      text: 'Innerhalb des Grenzwerts, höchstens 1,91 Ω.',
    })
  })

  it('takes the tripping current between half and all of IΔn', () => {
    // An RCD that trips below half of IΔn is too sensitive, or the circuit leaks.
    expect(judge('rcd_trip_current', 14_000)).toMatchObject({
      within: false,
      fromMilli: 15_000,
      limitMilli: 30_000,
      text: 'Außerhalb des Grenzwerts, zwischen 15,0 und 30,0 mA.',
      source:
        'DIN EN 61008-1 (VDE 0664-10):2018-03, 5.3.4 und 8.5, Auslösung zwischen 0,5 IΔn und IΔn',
    })
    expect(judge('rcd_trip_current', 15_000).within).toBe(true)
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
