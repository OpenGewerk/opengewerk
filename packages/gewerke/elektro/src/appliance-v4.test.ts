import {
  fieldsOf,
  type FormDefinition,
  formRecordProblem,
  formValuesText,
  limitVerdict,
  type MeasurementField,
  sealProblems,
} from '@opengewerk/domain'
import { describe, expect, it } from 'vitest'

import { elektroRegistry, elektroRules } from './index.js'

/**
 * Version 4 of the test of an appliance after DGUV Vorschrift 3 (#1023), from
 * the expert review in #31: after a repair, DIN EN 50678 (VDE 0701) measures
 * the protective conductor current at every appliance with a protective
 * conductor, and an appliance with a safely separated output shows its
 * separation after table 1 and figure 4 of the DGUV Information 203-070.
 */

const fourth = elektroRegistry.definitionFor('dguv-v3', 4) as FormDefinition
const third = elektroRegistry.definitionFor('dguv-v3', 3) as FormDefinition
const classOne = { protectionClass: 'I' }
const classTwo = { protectionClass: 'II' }

/** A test as filled in, everything there but the protective conductor current. */
const repaired = {
  tester: 'Anna Weber',
  test_kind: 'after_repair',
  housing: 'ok',
  cord: 'ok',
  plug: 'ok',
  markings: 'ok',
  suitability: 'ok',
  function: 'ok',
  safety_devices: 'ok',
  verdict: 'passed',
  next_inspection_months: 12_000,
}

function measurement(definition: FormDefinition, key: string): MeasurementField {
  const found = fieldsOf(definition).find((field) => field.key === key)

  if (found?.kind !== 'measurement') {
    throw new Error(`No measurement ${key}`)
  }

  return found
}

describe('version 4 of the test of an appliance (#1023)', () => {
  it('asks for the protective conductor current after a repair of an appliance of class I', () => {
    expect(sealProblems(fourth, repaired, { seal: false, subject: classOne })).toEqual([
      'Schutzleiterstrom IPE fehlt.',
    ])
    expect(
      sealProblems(
        fourth,
        { ...repaired, protective_conductor_current: 520 },
        {
          seal: false,
          subject: classOne,
        },
      ),
    ).toEqual([])
  })

  it('asks nothing more of an appliance of class II, or at a recurring test', () => {
    expect(sealProblems(fourth, repaired, { seal: false, subject: classTwo })).toEqual([])
    expect(
      sealProblems(
        fourth,
        { ...repaired, test_kind: 'recurring' },
        { seal: false, subject: classOne },
      ),
    ).toEqual([])
  })

  it('leaves version 3 as it asked, for the tests filled in it', () => {
    expect(sealProblems(third, repaired, { seal: false, subject: classOne })).toEqual([])
  })

  it('is refused as signed by the server with the facts the test is signed with', () => {
    const record = (facts: object) => ({
      definitionKey: 'dguv-v3',
      definitionVersion: 4,
      status: 'signed',
      values: formValuesText({
        ...repaired,
        tester_signature: {
          name: 'Anna Weber',
          path: 'M10,10L20,20',
          signedAt: '2026-11-23T10:00:00Z',
        },
      }),
      applianceFacts: JSON.stringify(facts),
    })

    expect(
      formRecordProblem(elektroRegistry, record({ protectionClass: 'I', cordLengthMilli: 2_000 })),
    ).toBe('Unterschrieben wird ein vollständiges Protokoll: Schutzleiterstrom IPE fehlt.')
    expect(
      formRecordProblem(elektroRegistry, record({ protectionClass: 'II', cordLengthMilli: 2_000 })),
    ).toBeNull()
  })

  it('judges the separation of a safely separated output by table 1 and figure 4', () => {
    const judge = (key: string, milli: number) =>
      limitVerdict(measurement(fourth, key), milli, {
        rules: elektroRules,
        on: '2026-11-23',
        circuit: null,
        appliance: null,
      })

    // At least 2 MΩ between input and output.
    expect(judge('separation_insulation', 1_990)).toMatchObject({
      within: false,
      text: 'Außerhalb des Grenzwerts, mindestens 2,00 MΩ.',
    })
    expect(judge('separation_insulation', 2_000).within).toBe(true)
    // At most 25 V AC and 60 V DC at the output.
    expect(judge('output_voltage_ac', 25_100)).toMatchObject({
      within: false,
      text: 'Außerhalb des Grenzwerts, höchstens 25,0 V.',
    })
    expect(judge('output_voltage_ac', 25_000).within).toBe(true)
    expect(judge('output_voltage_dc', 60_000).within).toBe(true)
    expect(judge('output_voltage_dc', 60_100).within).toBe(false)
    expect(judge('separation_insulation', 1_990).source).toContain('Abbildung 4')
  })

  it('adds the three values of the separation and the condition, and changes nothing else', () => {
    const added = ['separation_insulation', 'output_voltage_ac', 'output_voltage_dc']
    const back = {
      ...fourth,
      version: 3,
      sections: fourth.sections.map((section) =>
        section.key === 'measurements'
          ? {
              ...section,
              hint: third.sections.find((entry) => entry.key === 'measurements')?.hint,
              fields: section.fields
                .filter((field) => !added.includes(field.key))
                .map(({ requiredWhen: _condition, ...field }) => field),
            }
          : section,
      ),
    }

    expect(back).toEqual(third)
  })
})
