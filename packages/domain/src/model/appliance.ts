import { milliText, type Synced } from '@opengewerk/platform-domain'

import type { ApplianceId, SiteId } from './identifier.js'

/**
 * The protection classes of an appliance, which decide what its test after DGUV
 * Vorschrift 3 measures and against which limit (#303): class I has a
 * protective conductor, class II double insulation and none, class III runs
 * on protective extra-low voltage.
 */
export const protectionClasses = ['I', 'II', 'III'] as const

export type ProtectionClass = (typeof protectionClasses)[number]

/**
 * Whether an appliance is carried about or stays where it is: portable equipment
 * comes under table 1B of the DGUV Vorschrift 3, fixed equipment under 1A.
 */
export const applianceMobilities = ['portable', 'fixed'] as const

export type ApplianceMobility = (typeof applianceMobilities)[number]

/** How the register and the report name it. */
export const applianceMobilityLabel: Readonly<Record<ApplianceMobility, string>> = {
  portable: 'ortsveränderlich',
  fixed: 'ortsfest',
}

/**
 * An appliance that hangs on no circuit (#303): the drill, the coffee machine,
 * the extension lead, a washing machine. It belongs to a site, as the register
 * of section 3.2 of the concept lists it, and carries its test protocols as an
 * installation does. "Gerät" on screen and paper, an appliance in the code:
 * a device is the phone or tablet of the sync, and every synced table keeps
 * the one that wrote it last as `device_id`.
 */
export interface Appliance extends Synced {
  readonly id: ApplianceId
  readonly siteId: SiteId
  /** The number on its test label, as the business keeps it. */
  readonly inventoryNumber: string | null
  readonly designation: string
  readonly manufacturer: string | null
  readonly model: string | null
  readonly serialNumber: string | null
  readonly protectionClass: ProtectionClass
  readonly mobility: ApplianceMobility
  /** Where it stands or is kept. */
  readonly location: string | null
  /**
   * The length of its lead in millimetres, which the limit of the protective
   * conductor resistance counts with; null where nobody entered it, and the
   * limit is then the one for up to 5 metres.
   */
  readonly cordLengthMilli: number | null
  /**
   * The cross-section of its lead in thousandths of a square millimetre
   * (opengewerk#816): over 1.5 mm² the limit of the protective conductor
   * resistance is the resistance of the lead worked out of its length; null
   * where nobody entered it, and the limit is then the one of the table.
   */
  readonly cordCrossSectionMilli: number | null
  /**
   * The power of its heating elements in watts (opengewerk#816), which the
   * limits of the insulation and of the protective conductor current count
   * with; null for an appliance without heating elements or where nobody
   * entered it, and the limits are then the stricter ones without.
   */
  readonly heatingPowerWatts: number | null
  readonly notes: string | null
}

/**
 * What the limits of a test are worked out from: the protection class, the
 * lead and the heating power.
 */
export type ApplianceFacts = Pick<
  Appliance,
  'protectionClass' | 'cordLengthMilli' | 'cordCrossSectionMilli' | 'heatingPowerWatts'
>

/** The facts that are counts, each a whole number above zero where it is given. */
const countedFacts = ['cordLengthMilli', 'cordCrossSectionMilli', 'heatingPowerWatts'] as const

function isCount(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

/**
 * Whether a value is what a limit of an appliance's test is worked out from.
 * Cross-section and heating power may be missing, and are then none: the
 * facts a protocol was signed with before opengewerk#816 name neither. The
 * length is always named, as none where it is not known.
 */
export function isApplianceFacts(value: unknown): value is ApplianceFacts {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const facts = value as Record<string, unknown>

  return (
    (protectionClasses as readonly unknown[]).includes(facts['protectionClass']) &&
    isCount(facts['cordLengthMilli']) &&
    countedFacts.every((key) => isCount(facts[key] ?? null))
  )
}

/** The facts with every count named, a missing one as none. */
function wholeFacts(facts: ApplianceFacts): ApplianceFacts {
  return {
    protectionClass: facts.protectionClass,
    cordLengthMilli: facts.cordLengthMilli ?? null,
    cordCrossSectionMilli: facts.cordCrossSectionMilli ?? null,
    heatingPowerWatts: facts.heatingPowerWatts ?? null,
  }
}

/**
 * The facts a protocol was signed with (opengewerk#954), as its column holds
 * them: JSON text, because the sync carries plain values. Its limits are
 * worked out of them from then on, whatever becomes of the appliance. Null
 * for anything that is not such facts.
 */
export function readApplianceFacts(value: unknown): ApplianceFacts | null {
  if (typeof value !== 'string') {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  return isApplianceFacts(parsed) ? wholeFacts(parsed) : null
}

/** The facts as a signed protocol keeps them, read again by `readApplianceFacts`. */
export function applianceFactsText(facts: ApplianceFacts): string {
  return JSON.stringify(wholeFacts(facts))
}

/** Whether two sets of facts are the same, and so give the same limits. */
export function sameApplianceFacts(left: ApplianceFacts, right: ApplianceFacts): boolean {
  const [one, other] = [wholeFacts(left), wholeFacts(right)]

  return (
    one.protectionClass === other.protectionClass &&
    countedFacts.every((key) => one[key] === other[key])
  )
}

/** The longest lead an appliance can have, a kilometre, in millimetres; the database holds the same. */
export const longestCordMilli = 1_000_000

/** The largest cross-section of a lead, 1000 mm², in thousandths; as for a circuit, and the database holds the same. */
export const largestCordCrossSectionMilli = 1_000_000

/** The largest heating power, a megawatt, in watts; the database holds the same. */
export const largestHeatingPowerWatts = 1_000_000

function isCountUpTo(value: unknown, largest: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= largest
}

/** What is wrong with the fields of an appliance, by field, in the words of the form. */
export function applianceProblems(appliance: {
  readonly designation?: unknown
  readonly cordLengthMilli?: unknown
  readonly cordCrossSectionMilli?: unknown
  readonly heatingPowerWatts?: unknown
}): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {}

  if ('designation' in appliance) {
    const designation = appliance.designation

    if (typeof designation !== 'string' || designation.trim() === '') {
      problems['designation'] = 'Ein Gerät braucht eine Bezeichnung.'
    }
  }

  const counts = [
    ['cordLengthMilli', longestCordMilli, 'Die Länge ist größer als 0 und höchstens 1000 m.'],
    [
      'cordCrossSectionMilli',
      largestCordCrossSectionMilli,
      'Der Querschnitt ist größer als 0 und höchstens 1000 mm².',
    ],
    [
      'heatingPowerWatts',
      largestHeatingPowerWatts,
      'Die Heizleistung ist größer als 0 und höchstens 1000 kW.',
    ],
  ] as const

  for (const [key, largest, sentence] of counts) {
    const value = appliance[key]

    if (value !== undefined && value !== null && !isCountUpTo(value, largest)) {
      problems[key] = sentence
    }
  }

  return problems
}

/** The length of the lead as it is read: "1,2 m", or null where none is known. */
export function cordLengthText(appliance: Pick<Appliance, 'cordLengthMilli'>): string | null {
  return appliance.cordLengthMilli === null ? null : `${milliText(appliance.cordLengthMilli)} m`
}

/**
 * The lead as it is read, its length and its cross-section: "1,8 m, 1,5 mm²",
 * either alone, or null where neither is known (opengewerk#816).
 */
export function cordText(
  appliance: Pick<Appliance, 'cordLengthMilli' | 'cordCrossSectionMilli'>,
): string | null {
  const parts = [
    cordLengthText(appliance),
    appliance.cordCrossSectionMilli === null
      ? null
      : `${milliText(appliance.cordCrossSectionMilli)} mm²`,
  ].filter((part): part is string => part !== null)

  return parts.length === 0 ? null : parts.join(', ')
}

/** The heating power as it is read: "1,4 kW", or null where none is known (opengewerk#816). */
export function heatingPowerText(appliance: Pick<Appliance, 'heatingPowerWatts'>): string | null {
  return appliance.heatingPowerWatts === null
    ? null
    : `${milliText(appliance.heatingPowerWatts)} kW`
}

/**
 * An appliance as a list, a task and the paper name it: its inventory number
 * before its designation, "005 Kaffeemaschine", or the designation alone.
 */
export function applianceLabel(
  appliance: Pick<Appliance, 'inventoryNumber' | 'designation'>,
): string {
  const number = appliance.inventoryNumber?.trim() ?? ''

  return number === '' ? appliance.designation : `${number} ${appliance.designation}`
}

/**
 * An appliance with what its limits are worked out from, as the head of a
 * protocol names it: "005 Kaffeemaschine, Schutzklasse I, Anschlussleitung
 * 1,2 m, Heizleistung 1,4 kW".
 */
export function applianceSubject(
  appliance: Pick<Appliance, 'inventoryNumber' | 'designation'> & ApplianceFacts,
): string {
  const lead = cordText(wholeFacts(appliance))
  const heating = heatingPowerText(wholeFacts(appliance))

  return [
    applianceLabel(appliance),
    `Schutzklasse ${appliance.protectionClass}`,
    ...(lead === null ? [] : [`Anschlussleitung ${lead}`]),
    ...(heating === null ? [] : [`Heizleistung ${heating}`]),
  ].join(', ')
}
