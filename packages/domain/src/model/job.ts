import type { Id, Synced } from '@opengewerk/platform-domain'
import type {
  CustomerId,
  InstallationId,
  JobId,
  MaintenanceContractId,
  SiteId,
} from './identifier.js'

/**
 * A job is either a project or a service call. The concept keeps them apart
 * because they reach the business differently: a project is planned and split
 * into parts, a service call comes in by phone and has to be on a screen
 * thirty seconds later.
 */
export const jobKinds = ['project', 'service'] as const

export type JobKind = (typeof jobKinds)[number]

export const jobStatuses = ['draft', 'active', 'completed', 'cancelled'] as const

export type JobStatus = (typeof jobStatuses)[number]

export interface Job extends Synced {
  readonly id: JobId
  readonly customerId: CustomerId
  readonly siteId: SiteId | null
  readonly installationId: InstallationId | null
  /** A large site is split into sub jobs, one per trade or section. */
  readonly parentJobId: JobId | null
  /**
   * The finished job this one follows up (#170): the wallbox after the meter
   * cabinet, a repair after the handover. Not the parent: a sub job belongs to
   * its project and runs with it, a follow-up is a job of its own with its own
   * documents, and one column for both would turn every follow-up into a part
   * of the job before it. Set when the job is created and fixed from then on.
   */
  readonly predecessorJobId: JobId | null
  readonly kind: JobKind
  readonly status: JobStatus
  /**
   * Drawn from the job number range when the job is created (#145), on the
   * server and only there: a job created without a network gets it with the
   * next sync and has none until then. Null as well for a job created before
   * the numbering existed.
   */
  readonly number: string | null
  readonly designation: string
  readonly description: string | null
  /**
   * When the job was completed or cancelled (#140), written by the database
   * when the status goes there and emptied when it is taken up again. A
   * device of a technician keeps a closed job for `closedJobsStayDays` after
   * it, then lets it go.
   */
  readonly closedAt: Date | null
  /**
   * Whether the VOB/B is agreed as a whole (#310): then its periods of
   * warranty apply instead of those of the BGB, four years for a building.
   */
  readonly vobAgreed: boolean
  /**
   * Whether the work is a building, as the business decides it (#310): five
   * years of warranty and not two. Null while it has not, and then the job
   * suggests one (`suggestedBuildingWork`). The acceptance takes both as what
   * it starts with.
   */
  readonly buildingWork: boolean | null
  /**
   * An urgent repair or maintenance the customer expressly asked to be visited
   * for (#292): then there is no right of withdrawal for it, § 312g (2) no. 11
   * BGB, and the job says so wherever its instructions are (`urgentRepairNote`).
   * Set by the office when it takes the call; whatever else is agreed on site
   * is not covered by it.
   */
  readonly urgentRepair: boolean
  /**
   * When the customer called for an emergency (#293): set by whoever takes
   * the call on call, on the device, or by the office. Out of it comes the
   * kind of the call, at night, at the weekend or on a public holiday
   * (`emergencyKindAt`), and the surcharge on the invoice out of its report.
   * Null for every call that is no emergency.
   */
  readonly emergencyAt: Date | null
  /**
   * The surcharge named to a consumer before the order of an emergency call
   * (#1081), as the tariff of whoever took the call had it: a flat amount in
   * cents or a percentage on the working time, both zero where none could be
   * named. The invoice charges no more than this. Null for a call nobody
   * recorded it for, which is billed by the settings of the day.
   */
  readonly emergencyNamedFlatCents: number | null
  readonly emergencyNamedBasisPoints: number | null
  /**
   * The tax the flat amount was named with (#1083), in basis points, 0 for a
   * business under section 19 UStG: the invoice charges no more than that
   * amount with this tax, whatever tax it has itself. Null where it was named
   * before or by a device that does not know it; the amount then counts net.
   */
  readonly emergencyNamedVatBasisPoints: number | null
  /**
   * The maintenance contract whose deadline made this service job (#294), and
   * the day that maintenance is due: the proposal on the planning board. Set
   * by the server and only there, never by a device.
   */
  readonly maintenanceContractId: MaintenanceContractId | null
  readonly maintenanceDueOn: string | null
}

/**
 * A change of a job with the tax of its named surcharge taken along (#1083).
 * The tax belongs to the amount it was named with: a change of the named
 * amount or percentage that does not say with which tax, as from a device
 * that does not know it, leaves none recorded, and the amount counts net, as
 * for a call from before. Kept, the tax of the old amount would have made the
 * new one a total it never was.
 */
export function namedTaxAlong<Values extends Readonly<Record<string, unknown>>>(
  values: Values,
): Values {
  return ('emergencyNamedFlatCents' in values || 'emergencyNamedBasisPoints' in values) &&
    !('emergencyNamedVatBasisPoints' in values)
    ? { ...values, emergencyNamedVatBasisPoints: null }
    : values
}

/**
 * How long a closed job stays on the device of a technician assigned to it
 * (#140): long enough to look something up after the handover, not so long
 * that a lost telephone carries every job of the year.
 */
export const closedJobsStayDays = 30

/**
 * A person on a job (#140), assigned in the office. What the device of that
 * person holds follows from these rows, unless the person may see the whole
 * business (`job.read.all`). Made and removed on the server; a device reads
 * them and writes none. Removed means marked deleted, so that every device
 * learns it.
 */
export interface JobAssignment extends Synced {
  readonly id: Id<'job-assignment'>
  readonly jobId: JobId
  readonly userId: string
}

/**
 * The statuses that move a job forward (#128): taking it up and finishing it,
 * and taking a finished one up again when that happened by mistake.
 * Cancelling is not among them and neither is sending a job back to draft;
 * both are decisions about the order, not reports from the site.
 */
export const jobProgressStatuses: readonly JobStatus[] = ['active', 'completed']

/**
 * The statuses a report from the site may move a job out of: every one but
 * cancelled. A cancelled job was the office's decision about the order, and
 * taking it up again is one as well (`job.write`), not progress.
 */
export const jobProgressSources: readonly JobStatus[] = ['draft', 'active', 'completed']

/**
 * Whether a job may leave the status it has by a report from the site. The
 * other half of `isJobProgress`: which right a change asks for is decided on
 * the status it sets, before the record is read, and this is asked of the
 * status the record holds.
 */
export function leavesByProgress(held: unknown): boolean {
  return jobProgressSources.some((status) => status === held)
}

/** One change to one field, as an outbox operation carries it. */
interface FieldChange {
  readonly field: string
  readonly to: unknown
}

/**
 * Whether a change to a job only reports its progress: a status from
 * `jobProgressStatuses`, and nothing else.
 *
 * This is the part of a job a technician may write (`job.progress`). Which
 * customer it is for, where it is, what it is called and what is to be done
 * stays with whoever holds `job.write`, and a change that touches any of that
 * as well needs that right, however small the rest of it is. What happened on
 * site is a note of its own (`JobNote`, #220), not the description: until
 * then a note written on site replaced what the office had put down as the
 * job. An empty change reports nothing and is not progress either.
 */
export function isJobProgress(changes: readonly FieldChange[]): boolean {
  return (
    changes.length > 0 &&
    changes.every(
      (change) =>
        change.field === 'status' && jobProgressStatuses.some((status) => status === change.to),
    )
  )
}

/** A job as a follow-up is judged against it: whose it is and where it stands. */
export interface PredecessorFacts {
  readonly customerId: string
  readonly status: JobStatus
}

/**
 * What is wrong with following up this job, as a sentence, or null (#170).
 *
 * A follow-up comes after a job that is finished, for the same customer, and
 * no job follows itself. Work that is added while a job is still running is
 * not a follow-up but a change to the order, which is for phase 4. One
 * function for the form in the office, the sync on the server and its routes,
 * so all three refuse the same thing with the same words.
 */
export function followUpProblem(
  job: { readonly id: string; readonly customerId: string },
  predecessor: PredecessorFacts & { readonly id: string },
): string | null {
  if (predecessor.id === job.id) {
    return 'Ein Auftrag ist nicht sein eigener Vorgänger.'
  }

  if (predecessor.status !== 'completed') {
    return 'Ein Folgeauftrag schließt an einen abgeschlossenen Auftrag an.'
  }

  if (predecessor.customerId !== job.customerId) {
    return 'Ein Folgeauftrag ist für denselben Kunden wie der Auftrag davor.'
  }

  return null
}

/**
 * What is wrong with the terms of a job (#310), or nothing: the VOB/B is
 * agreed or not, and the work is a building, is none, or not decided yet.
 */
/** What is wrong with the moment of an emergency call (#293): a moment, or none. */
export function emergencyAtProblem(emergencyAt: unknown): string | null {
  if (emergencyAt === undefined || emergencyAt === null) {
    return null
  }

  const moment = emergencyAt instanceof Date ? emergencyAt : new Date(String(emergencyAt))

  if (Number.isNaN(moment.getTime())) {
    return 'Der Notdiensteinsatz braucht Tag und Uhrzeit des Anrufs.'
  }

  // The rules of tax begin in 2007, and an invoice finds no surcharge before
  // (#1085): a year like 0026 is a day typed in half.
  return moment.getTime() < firstCallDay
    ? 'Der Tag des Anrufs liegt vor 2007 und ist wohl vertippt.'
    : null
}

/** The first moment a call can be billed at: the rules of tax begin on 01.01.2007 (#1085). */
const firstCallDay = Date.parse('2007-01-01T00:00:00+01:00')

/**
 * What is wrong with the surcharge named before the order (#1081): both
 * parts or neither, whole numbers in the bounds of a setting, and only on an
 * emergency call.
 */
export function emergencyNamedProblem(
  flatCents: unknown,
  basisPoints: unknown,
  emergencyAt: unknown,
  vatBasisPoints: unknown = null,
): string | null {
  const absent = (value: unknown) => value === undefined || value === null

  // The tax only with an amount it was named with (#1083), and as a rate.
  if (!absent(vatBasisPoints)) {
    if (absent(flatCents)) {
      return 'Die Steuer eines genannten Notdienstzuschlags gehört zu seinem Betrag.'
    }

    if (
      typeof vatBasisPoints !== 'number' ||
      !Number.isInteger(vatBasisPoints) ||
      vatBasisPoints < 0 ||
      vatBasisPoints > 10_000
    ) {
      return 'Die Steuer eines genannten Notdienstzuschlags ist ein Satz zwischen 0 und 100 %.'
    }
  }

  if (absent(flatCents) && absent(basisPoints)) {
    return null
  }

  if (absent(flatCents) || absent(basisPoints)) {
    return 'Ein genannter Notdienstzuschlag hat einen Betrag und einen Prozentsatz, beide oder keinen.'
  }

  const whole = (value: unknown, most: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= most

  if (!whole(flatCents, 100_000_000) || !whole(basisPoints, 100_000)) {
    return 'Ein genannter Notdienstzuschlag ist eine ganze Zahl, nicht negativ, und liegt in den Grenzen der Einstellungen.'
  }

  return absent(emergencyAt) ? 'Einen Notdienstzuschlag nennt nur ein Notdiensteinsatz.' : null
}

/** What is wrong with the mark of an urgent repair (#292): it is yes or no. */
export function urgentRepairProblem(urgentRepair: unknown): string | null {
  return urgentRepair !== undefined && typeof urgentRepair !== 'boolean'
    ? 'Ob eine dringende Reparatur angefordert ist, heißt ja oder nein.'
    : null
}

export function jobTermsProblem(vobAgreed: unknown, buildingWork: unknown): string | null {
  if (vobAgreed !== undefined && typeof vobAgreed !== 'boolean') {
    return 'Ob die VOB/B vereinbart ist, heißt ja oder nein.'
  }

  return buildingWork !== undefined && buildingWork !== null && typeof buildingWork !== 'boolean'
    ? 'Ob die Leistung ein Bauwerk ist, heißt ja, nein oder noch offen.'
    : null
}
