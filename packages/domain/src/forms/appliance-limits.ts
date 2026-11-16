import {
  type IsoDate,
  type LimitCalculator,
  milliText,
  type RuleSet,
} from '@opengewerk/platform-domain'

import { type ApplianceFacts, isApplianceFacts } from '../model/appliance.js'

/**
 * The limits of the test of an appliance after DGUV Vorschrift 3 (#303) that
 * depend on the appliance, worked out of the rules of the trade package and what
 * the protocol hangs on: the protection class, for the protective conductor
 * the length and the cross-section of the lead, and for an appliance with
 * heating elements their power (opengewerk#816). The limits themselves are
 * values with a source in the package, as every other limit; here is only
 * which of them applies, and how lead and heating power add to it (DGUV
 * Information 203-070, table 1).
 */

const insulationRule: Readonly<Record<ApplianceFacts['protectionClass'], string>> = {
  I: 'elektro.appliance.insulation_class_one',
  II: 'elektro.appliance.insulation_class_two',
  III: 'elektro.appliance.insulation_class_three',
}

function applianceOf(item: unknown): ApplianceFacts | null {
  return isApplianceFacts(item) ? item : null
}

/**
 * The heating power of an appliance of class I with heating elements, in
 * watts, or null for one without or of another class: the table names the
 * heating elements only for class I.
 */
function heatingOf(appliance: ApplianceFacts): number | null {
  return appliance.protectionClass === 'I' ? (appliance.heatingPowerWatts ?? null) : null
}

/**
 * The protective conductor current an appliance with heating elements may
 * have, in microamperes, and its source: the base value up to the power at
 * which a milliampere per kilowatt reaches it, 3.5 kW, then a milliampere per
 * kilowatt, never more than the maximum. Null where a rule is missing on the
 * day.
 */
function heatingCurrent(
  rules: RuleSet,
  on: IsoDate,
  watts: number,
): { readonly limitMilli: number; readonly beyondBase: boolean; readonly source: string } | null {
  const base = rules.at('elektro.appliance.protective_conductor_current', on)
  const perKilowatt = rules.at('elektro.appliance.protective_conductor_current_per_kilowatt', on)
  const maximum = rules.at('elektro.appliance.protective_conductor_current_heating_maximum', on)

  if (!base || !perKilowatt || !maximum) {
    return null
  }

  // Microamperes per kilowatt times watts is thousandths of a microampere.
  const byPower = Math.round((perKilowatt.value * watts) / 1000)

  return byPower > base.value
    ? {
        limitMilli: Math.min(byPower, maximum.value),
        beyondBase: true,
        source: perKilowatt.source,
      }
    : { limitMilli: base.value, beyondBase: false, source: base.source }
}

/**
 * The least insulation resistance, by the protection class of the appliance.
 * A rule in kiloohms is a thousandth of a megaohm, the unit of the field, so
 * the value is the limit in thousandths as it stands. An appliance of class I
 * with heating elements is held to their value; above the power at which its
 * protective conductor current may grow, 3.5 kW, it is sound below that as
 * well where that current is kept, and the protocol names no limit here.
 */
export const applianceInsulation: LimitCalculator = (_field, { rules, on, item }) => {
  const appliance = applianceOf(item)

  if (!appliance) {
    return { none: 'Ohne Schutzklasse des Geräts gibt es keinen Grenzwert.' }
  }

  const watts = heatingOf(appliance)

  if (watts !== null) {
    const heating = rules.at('elektro.appliance.insulation_class_one_heating', on)
    const current = heatingCurrent(rules, on, watts)

    if (!heating || !current) {
      return { none: 'Für diesen Tag ist kein Grenzwert für Geräte mit Heizelementen hinterlegt.' }
    }

    if (current.beyondBase) {
      return {
        none: `Bei ${milliText(watts)} kW Heizleistung urteilt der Schutzleiterstrom; ein Isolationswiderstand unter ${milliText(heating.value)} MΩ ist dann kein Mangel, wenn er eingehalten ist.`,
      }
    }

    return { limitMilli: heating.value, atLeast: true, source: heating.source }
  }

  const rule = rules.at(insulationRule[appliance.protectionClass], on)

  if (!rule) {
    return { none: 'Ohne Schutzklasse des Geräts gibt es keinen Grenzwert.' }
  }

  return { limitMilli: rule.value, atLeast: true, source: rule.source }
}

/**
 * The largest protective conductor resistance of an appliance of class I: the
 * base value for a lead up to its length, a step for every further length or
 * part of one, and never more than the maximum. An appliance without a length
 * entered is held to the base value, which is never looser than the rule. A
 * lead of more than 1.5 mm² with a length is held to its own resistance,
 * worked out of length, cross-section and the conductivity of copper, and the
 * transition on top (opengewerk#816). An appliance of class II or III has no
 * protective conductor.
 */
export const applianceProtectiveConductor: LimitCalculator = (_field, { rules, on, item }) => {
  const appliance = applianceOf(item)

  if (!appliance) {
    return { none: 'Ohne Schutzklasse des Geräts gibt es keinen Grenzwert.' }
  }

  if (appliance.protectionClass !== 'I') {
    return { none: 'Ein Gerät dieser Schutzklasse hat keinen Schutzleiter.' }
  }

  const length = appliance.cordLengthMilli
  const crossSection = appliance.cordCrossSectionMilli ?? null
  const largest = rules.at('elektro.appliance.cord_cross_section_base', on)

  // Thousandths of a square millimetre are thousands of square micrometres.
  if (length !== null && crossSection !== null && largest && crossSection * 1000 > largest.value) {
    const conductivity = rules.at('elektro.appliance.cord_conductivity', on)
    const transition = rules.at('elektro.appliance.protective_conductor_transition', on)

    if (!conductivity || !transition || conductivity.value <= 0) {
      return { none: 'Für diesen Tag ist kein Grenzwert des Schutzleiterwiderstands hinterlegt.' }
    }

    // R = l / (κ · A): metres over m/(Ω·mm²) times mm² is ohms. In millimetres
    // and thousandths of a square millimetre the same quotient is milliohms.
    const lead = Math.round((length * 1000) / (conductivity.value * crossSection))

    return { limitMilli: lead + transition.value, atLeast: false, source: largest.source }
  }

  const base = rules.at('elektro.appliance.protective_conductor_base', on)
  const baseLength = rules.at('elektro.appliance.protective_conductor_base_length', on)
  const step = rules.at('elektro.appliance.protective_conductor_step', on)
  const stepLength = rules.at('elektro.appliance.protective_conductor_step_length', on)
  const maximum = rules.at('elektro.appliance.protective_conductor_maximum', on)

  if (!base || !baseLength || !step || !stepLength || !maximum || stepLength.value <= 0) {
    return { none: 'Für diesen Tag ist kein Grenzwert des Schutzleiterwiderstands hinterlegt.' }
  }

  const beyond = Math.max(0, (length ?? 0) - baseLength.value)
  const steps = Math.ceil(beyond / stepLength.value)

  // Milliohms are thousandths of an ohm, the unit of the field.
  return {
    limitMilli: Math.min(base.value + steps * step.value, maximum.value),
    atLeast: false,
    source: base.source,
  }
}

/**
 * The largest protective conductor current (opengewerk#816): the base value
 * of the package, and for an appliance of class I with heating elements of
 * more than 3.5 kW a milliampere per kilowatt, never more than the maximum.
 * Microamperes are thousandths of a milliampere, the unit of the field.
 */
export const applianceProtectiveConductorCurrent: LimitCalculator = (
  _field,
  { rules, on, item },
) => {
  const appliance = applianceOf(item)
  const watts = appliance ? heatingOf(appliance) : null

  if (watts !== null) {
    const current = heatingCurrent(rules, on, watts)

    if (!current) {
      return { none: 'Für diesen Tag ist kein Grenzwert für Geräte mit Heizelementen hinterlegt.' }
    }

    return { limitMilli: current.limitMilli, atLeast: false, source: current.source }
  }

  const base = rules.at('elektro.appliance.protective_conductor_current', on)

  if (!base) {
    return { none: 'Für diesen Tag ist kein Grenzwert des Schutzleiterstroms hinterlegt.' }
  }

  return { limitMilli: base.value, atLeast: false, source: base.source }
}
