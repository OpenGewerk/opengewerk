import type { CircuitFacts, IsoDate, LimitVerdict, RuleSet } from '@opengewerk/platform-domain'

import type { ApplianceFacts } from '../model/appliance.js'
import type { MeasuringConditions } from './circuit-limits.js'
import type { MeasurementField, MeasurementUnit } from './definition.js'
import { tradeForms } from './engine.js'
import { isRuleLimit } from '@opengewerk/platform-domain'

export { type CircuitFacts, type LimitVerdict, measuredNumber } from '@opengewerk/platform-domain'
export type { MeasuringConditions } from './circuit-limits.js'

/** A value in thousandths, as it is written: `0,85 Ω`. */
export function formatMeasured(milli: number, unit: MeasurementUnit, decimals: number): string {
  return tradeForms.formatMeasured(milli, unit, decimals)
}

/**
 * The limits a measured value has to reach rather than stay under. A rule
 * says so itself (`at_least`); of the limits worked out, only the insulation
 * of an appliance does (#303), and the insulation of a circuit after its
 * nominal voltage (#1021) and both of the recurring inspection (#1022); the
 * loop impedance, the tripping current and time and the protective conductor
 * of an appliance are limits to stay under.
 */
const workedOutMinimums: ReadonlySet<string> = new Set([
  'appliance_insulation',
  'circuit_insulation',
  'recurring_insulation_without_loads',
  'recurring_insulation_with_loads',
])

/**
 * The conditions a circuit was measured in as its block and its protocol say
 * them (#1022): the environment in the block, the earthing system and the
 * nominal voltage in the head, where they are given and known, and the rated
 * residual current of the RCD of a wallbox (#1075). A form that asks for none
 * of them gives none, and its limits judge as before.
 */
export function measuringConditions(
  block: Readonly<Record<string, unknown>> | null | undefined,
  form: Readonly<Record<string, unknown>> | null | undefined,
): MeasuringConditions {
  const environment = block?.['environment']
  const earthingSystem = form?.['earthing_system']
  const nominalVoltageMilli = form?.['nominal_voltage']
  const rcdRated = form?.['rcd_rated_residual_current']

  return {
    ...(environment === 'dry' || environment === 'damp' ? { environment } : {}),
    ...(typeof earthingSystem === 'string' ? { earthingSystem } : {}),
    ...(typeof nominalVoltageMilli === 'number' &&
    Number.isInteger(nominalVoltageMilli) &&
    nominalVoltageMilli > 0
      ? { nominalVoltageMilli }
      : {}),
    // The rated residual current of the RCD of a wallbox (#1075), chosen in
    // whole milliamperes and at most the 30 mA the standard allows.
    ...(typeof rcdRated === 'string' &&
    /^\d{1,2}$/.test(rcdRated) &&
    Number(rcdRated) >= 1 &&
    Number(rcdRated) <= 30
      ? { rcdRatedResidualMicro: Number(rcdRated) * 1000 }
      : {}),
  }
}

/** Whether the limit of a field is one to reach, "mindestens", rather than one to stay under. */
export function limitIsMinimum(field: MeasurementField): boolean {
  const limit = field.limit

  if (limit === undefined) {
    return false
  }

  return isRuleLimit(limit) ? limit.kind === 'at_least' : workedOutMinimums.has(limit.kind)
}

/**
 * Judges a measured value against the limit its field names (#79), on the day
 * of the test, with the rules of the trade package, and for the loop
 * impedance and the tripping current with the circuit it was measured on; for
 * the test of an appliance (#303) with the appliance, its protection class and lead.
 * The conditions of a circuit (#1022) go with it, and judge a block without a
 * circuit as well.
 *
 * A value outside its limit is said so, with the limit and its source, and is
 * kept: what was measured goes on the paper, and a protocol that refused it
 * would only make somebody write a different number.
 */
export function limitVerdict(
  field: MeasurementField,
  measuredMilli: number | null,
  context: {
    readonly rules: RuleSet
    readonly on: IsoDate
    readonly circuit: CircuitFacts | null
    readonly appliance?: ApplianceFacts | null
    readonly conditions?: MeasuringConditions
  },
): LimitVerdict {
  const { circuit, appliance, conditions } = context

  return tradeForms.limitVerdict(field, measuredMilli, {
    rules: context.rules,
    on: context.on,
    item: circuit
      ? { ...circuit, ...conditions }
      : (appliance ?? (conditions ? { ...conditions } : null)),
  })
}
