import {
  type CircuitFacts,
  type CircuitVoltageClass,
  type LimitCalculator,
  loopImpedance,
} from '@opengewerk/platform-domain'

/**
 * The limits of version 4 of the first inspection after DIN VDE 0100-600 that
 * are worked out of a circuit (#1021), decided with the expert review of
 * 20.11.2026 (#31). The values are rules with a source in the trade package,
 * as every other limit; here is only which of them applies to a circuit: the
 * insulation by its nominal voltage, the loop impedance against two thirds of
 * U0 / Ia, the tripping current between half and all of IΔn, and the tripping
 * time of a selective RCD by its own range. A block filled before the circuit
 * chart knew the nominal voltage and the selective RCD has neither, and its
 * circuit is up to 500 V with a general RCD.
 */

const insulationRule: Readonly<Record<CircuitVoltageClass, string>> = {
  up_to_500: 'elektro.insulation.minimum_up_to_500v',
  selv_pelv: 'elektro.insulation.minimum_selv_pelv',
  above_500: 'elektro.insulation.minimum_above_500v',
}

/** Said after a loop impedance outside its limit: what Annex D asks for then. */
export const loopImpedanceOutside =
  'Eine genauere Bewertung nach Anhang D der DIN VDE 0100-600 ist nötig.'

function circuitOf(item: unknown): CircuitFacts | null {
  return typeof item === 'object' && item !== null ? (item as CircuitFacts) : null
}

/**
 * Where and how a circuit was measured beside what its chart says (#1022):
 * the environment its block names, dry or damp, and the earthing system in the
 * head of the protocol. A block without them is a dry circuit in a TN or TT
 * system.
 */
export interface MeasuringConditions {
  readonly environment?: 'dry' | 'damp'
  readonly earthingSystem?: string
}

function conditionsOf(item: unknown): MeasuringConditions | null {
  return typeof item === 'object' && item !== null ? (item as MeasuringConditions) : null
}

/** The sources of two rules, once where they are the same. */
function sourcesOf(first: string, second: string): string {
  return first === second ? first : `${first}; ${second}`
}

/** The least insulation resistance after Table 6.1, by the nominal voltage of the circuit. */
export const circuitInsulation: LimitCalculator = (_field, { rules, on, item }) => {
  const rule = rules.at(insulationRule[circuitOf(item)?.voltageClass ?? 'up_to_500'], on)

  if (!rule) {
    return { none: 'Für diesen Tag ist kein Grenzwert hinterlegt.' }
  }

  // Kiloohms are thousandths of the megaohms the field is measured in.
  return { limitMilli: rule.value, atLeast: true, source: rule.source }
}

/**
 * The measured loop impedance after Annex D: two thirds of the limit the
 * protective device sets, rounded down again so that it is never looser, and
 * above it a closer look.
 */
export const loopImpedanceMeasured: LimitCalculator = (field, context) => {
  const whole = loopImpedance(field, context)

  if ('none' in whole) {
    return whole
  }

  const share = context.rules.at('elektro.loop.measured_share', context.on)

  if (!share) {
    return { none: 'Für diesen Tag ist kein Grenzwert hinterlegt.' }
  }

  return {
    limitMilli: Math.floor((whole.limitMilli * share.value) / 10_000),
    atLeast: false,
    outside: loopImpedanceOutside,
    source: `${share.source}; ${whole.source}`,
  }
}

/**
 * The tripping current between half and all of the rated residual current: an
 * RCD that trips below half of it is too sensitive or the circuit leaks. Half
 * of it is the rated non-operating current, at which it must not trip, so the
 * least value within is the next thousandth above it.
 */
export const rcdTripCurrentRange: LimitCalculator = (_field, { rules, on, item }) => {
  const rated = circuitOf(item)?.ratedResidualCurrentMilli
  const least = rules.at('elektro.rcd.trip_current_minimum', on)
  const most = rules.at('elektro.rcd.trip_current_maximum', on)

  if (!least || !most || !rated) {
    return { none: 'Ohne Bemessungsdifferenzstrom am Stromkreis gibt es keinen Grenzwert.' }
  }

  // Milliamperes as thousandths of the field's milliamperes, the shares in basis points.
  return {
    limitMilli: Math.floor((rated * 1000 * most.value) / 10_000),
    fromMilli: Math.floor((rated * 1000 * least.value) / 10_000) + 1,
    atLeast: false,
    source: sourcesOf(least.source, most.source),
  }
}

/**
 * The least insulation resistance of the recurring inspection after table 11
 * of the DGUV Information 203-072 (#1022), with or without the loads: 0,25 MΩ
 * for SELV and PELV, in an IT system 50 Ω per volt, and otherwise per volt by
 * the environment, dry or damp. Per volt is at U0 = 230 V, rounded up to whole
 * kiloohms so that it is never looser. The table has no row for a circuit
 * above 500 V, and the protocol says so rather than judge it by another.
 */
function recurringInsulation(loads: 'with_loads' | 'without_loads'): LimitCalculator {
  return (_field, { rules, on, item }) => {
    const voltageClass = circuitOf(item)?.voltageClass ?? 'up_to_500'
    const conditions = conditionsOf(item)

    if (voltageClass === 'above_500') {
      return {
        none: 'Für einen Stromkreis über 500 V nennt Tabelle 11 der DGUV Information 203-072 keinen Mindestwert.',
      }
    }

    if (voltageClass === 'selv_pelv') {
      const rule = rules.at('elektro.insulation.recurring_selv_pelv', on)

      // Kiloohms are thousandths of the megaohms the field is measured in.
      return rule
        ? { limitMilli: rule.value, atLeast: true, source: rule.source }
        : { none: 'Für diesen Tag ist kein Grenzwert hinterlegt.' }
    }

    const environment = conditions?.environment === 'damp' ? 'damp' : 'dry'
    const perVolt = rules.at(
      conditions?.earthingSystem === 'it'
        ? 'elektro.insulation.recurring_per_volt_it'
        : `elektro.insulation.recurring_per_volt_${loads}_${environment}`,
      on,
    )
    const voltage = rules.at('elektro.loop.nominal_voltage', on)

    if (!perVolt || !voltage) {
      return { none: 'Für diesen Tag ist kein Grenzwert hinterlegt.' }
    }

    // Ohms per volt times volts are ohms, and a thousandth of a megaohm is a kiloohm.
    return {
      limitMilli: Math.ceil((perVolt.value * voltage.value) / 1000),
      atLeast: true,
      source: perVolt.source,
    }
  }
}

/** The insulation of the recurring inspection without the loads connected (#1022). */
export const recurringInsulationWithoutLoads = recurringInsulation('without_loads')

/** The insulation of the recurring inspection with the loads connected and switched on (#1022). */
export const recurringInsulationWithLoads = recurringInsulation('with_loads')

/** The tripping time at IΔn: at most that of an RCD without delay, or the range of a selective one. */
export const rcdTripTime: LimitCalculator = (_field, { rules, on, item }) => {
  if (circuitOf(item)?.rcdSelective === true) {
    const least = rules.at('elektro.rcd.selective_trip_time_minimum', on)
    const most = rules.at('elektro.rcd.selective_trip_time_maximum', on)

    if (!least || !most) {
      return { none: 'Für diesen Tag ist kein Grenzwert hinterlegt.' }
    }

    return {
      limitMilli: most.value * 1000,
      fromMilli: least.value * 1000,
      atLeast: false,
      source: sourcesOf(least.source, most.source),
    }
  }

  const most = rules.at('elektro.rcd.trip_time_maximum', on)

  if (!most) {
    return { none: 'Für diesen Tag ist kein Grenzwert hinterlegt.' }
  }

  return { limitMilli: most.value * 1000, atLeast: false, source: most.source }
}
