import type { RecordState } from '@opengewerk/platform-domain'
import { describe, expect, it } from 'vitest'

import { circuitAlong, selectiveRefusal, structureProblem, valueAfter } from './structure.js'

// What a device may not send of the structure at all (ADR 0014), asked
// without a database. Whether a section belongs to the board of its circuit
// needs one, and the tests of an application's sync hold that.

describe('what a device may not send of the structure', () => {
  it('is nothing for an entity that is a name of the prototype of an object', () => {
    expect(structureProblem('__proto__', { kind: 'garage' }, null)).toBeNull()
    expect(structureProblem('constructor', { kind: 'garage' }, null)).toBeNull()
  })

  it('is a kind of board nobody knows', () => {
    expect(structureProblem('distribution_boards', { kind: 'garage' }, null)).toBe(
      'Diese Art von Verteiler ist unbekannt.',
    )
    expect(structureProblem('distribution_boards', { kind: 'sub_distribution' }, null)).toBeNull()
    expect(structureProblem('distribution_boards', { designation: 'UV Küche' }, null)).toBeNull()
  })

  it('is a figure of a circuit out of bounds, judged as the circuit would stand afterwards', () => {
    const standing = {
      overcurrentDevice: 'circuit_breaker',
      tripCharacteristic: 'b',
      ratedCurrentMilli: 16000,
    }

    expect(structureProblem('circuits', { ratedCurrentMilli: 0 }, null)).not.toBeNull()
    expect(structureProblem('circuits', { ratedCurrentMilli: 20000 }, standing)).toBeNull()
    // The curve of a fuse with a breaker the patch does not touch.
    expect(structureProblem('circuits', { tripCharacteristic: 'gg' }, standing)).not.toBeNull()
  })

  it('is not a figure nobody touched: a circuit that is only renamed is let through', () => {
    const wrongAlready = { tripCharacteristic: 'gg', overcurrentDevice: 'circuit_breaker' }

    expect(structureProblem('circuits', { designation: 'F4' }, wrongAlready)).toBeNull()
  })

  it('is not a nominal voltage a new circuit left out, but one sent as nothing (#1021)', () => {
    expect(
      structureProblem('circuits', { designation: 'F1', ratedCurrentMilli: 16_000 }, null),
    ).toBeNull()
    expect(structureProblem('circuits', { designation: 'F1', voltageClass: null }, null)).toBe(
      'Diese Nennspannung ist unbekannt.',
    )
    expect(structureProblem('circuits', { rcdSelective: true }, null)).toBe(
      'Selektiv ist nur ein RCD mit Typ. Bitte zuerst den Typ wählen.',
    )
  })

  it('is a figure of the PV structure out of its range', () => {
    expect(structureProblem('inverters', { ratedPowerW: 0 }, null)).not.toBeNull()
    expect(structureProblem('pv_strings', { tiltDeg: 91 }, null)).not.toBeNull()
    expect(structureProblem('pv_modules', { ratedPowerW: 400 }, null)).toBeNull()
  })

  it('is nothing for a table that is not the structure', () => {
    expect(structureProblem('equipment', { designation: '' }, null)).toBeNull()
    expect(structureProblem('labels', { kind: 'garage' }, null)).toBeNull()
  })
})

describe('the value of a field after an operation', () => {
  it('is what the operation sets, or else what the row holds, or else nothing', () => {
    const row = { id: 'c-1', designation: 'F1', consumer: null }

    expect(valueAfter('designation', { designation: 'F2' }, row)).toBe('F2')
    expect(valueAfter('designation', {}, row)).toBe('F1')
    expect(valueAfter('consumer', { consumer: null }, { ...row, consumer: 'Herd' })).toBeNull()
    expect(valueAfter('cableType', {}, null)).toBeNull()
  })
})

/**
 * What an operation on a circuit takes along without saying it (#1021): a
 * type of RCD taken away takes a stored selective with it, and nothing else.
 */
describe('what a circuit takes along', () => {
  const stored = { id: 'k-1', rcdType: 'a', rcdSelective: true } as RecordState

  it('is the selective, when the type goes and the operation leaves the selective alone', () => {
    expect(circuitAlong('circuits', { rcdType: null }, stored)).toEqual({
      rcdType: null,
      rcdSelective: false,
    })
  })

  it('is nothing otherwise', () => {
    expect(circuitAlong('circuits', { rcdType: 'b' }, stored)).toEqual({ rcdType: 'b' })
    expect(circuitAlong('circuits', { rcdType: null, rcdSelective: true }, stored)).toEqual({
      rcdType: null,
      rcdSelective: true,
    })
    expect(circuitAlong('circuits', { rcdType: null }, { ...stored, rcdSelective: false })).toEqual(
      { rcdType: null },
    )
    expect(circuitAlong('circuits', { rcdType: null }, null)).toEqual({ rcdType: null })
    expect(circuitAlong('equipment', { rcdType: null }, stored)).toEqual({ rcdType: null })
  })
})

/**
 * A selective RCD sent for a circuit whose type went since the device saw it
 * (#1021) is two people disagreeing, and only that.
 */
describe('a selective RCD sent for a circuit without a type', () => {
  const now = { id: 'k-1', rcdType: null, rcdSelective: false, version: 2 } as RecordState

  it('is a conflict when the circuit changed since the device saw it', () => {
    expect(selectiveRefusal('circuits', { rcdSelective: true }, now, 1)).toEqual({
      reason: 'changed_elsewhere',
      fields: ['rcdType', 'rcdSelective'],
    })
  })

  it('is no conflict without a version, with the version the device saw, or with a type', () => {
    expect(selectiveRefusal('circuits', { rcdSelective: true }, now, null)).toBeNull()
    expect(selectiveRefusal('circuits', { rcdSelective: true }, now, 2)).toBeNull()
    expect(selectiveRefusal('circuits', { rcdSelective: true, rcdType: 'a' }, now, 1)).toBeNull()
    expect(
      selectiveRefusal('circuits', { rcdSelective: true }, { ...now, rcdType: 'a' }, 1),
    ).toBeNull()
    expect(selectiveRefusal('circuits', { rcdSelective: false }, now, 1)).toBeNull()
    expect(selectiveRefusal('circuits', { rcdSelective: true }, null, 1)).toBeNull()
  })
})
