import {
  berlinClock,
  type ConflictReason,
  defaultNight,
  emergencyKindAt,
  type EmergencyKind,
  emergencyKinds,
  type EmergencySurcharge,
  emergencySurchargeLine,
  type EmergencyTariff,
  emergencyTariffText,
  holidaysIn,
  type IsoDate,
  type JobId,
  type LineUnit,
  shippedRules,
  type SurchargeLine,
} from '@opengewerk/domain'
import { isUuid, type TenantTransaction } from '@opengewerk/platform-server'
import { and, eq, gt, isNull, lte } from 'drizzle-orm'

import { holidaySettingOf } from '../absences/absences.js'
import { parameterAt } from '../database/parameters.js'
import { jobs, onCallShifts } from '../database/schema/index.js'

/**
 * How far ahead of the server's clock a device may put the moment of a call:
 * five minutes of a clock that runs fast, and no more.
 */
const clockSlackMs = 5 * 60_000

/**
 * How long a call made without a network may take to reach the server: two
 * days. An older moment is no call taken now, and the office takes it over
 * like any call outside the plan; otherwise a time of the plan long past
 * would carry a surcharge the call never had.
 */
const longestOfflineMs = 48 * 3_600_000

/** Why a service call made on call may not land, in the shape a sync conflict records. */
export interface OnCallRefusal {
  readonly reason: ConflictReason
  readonly fields: readonly string[]
}

function momentOf(value: unknown): Date | null {
  const moment = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null

  return moment && !Number.isNaN(moment.getTime()) ? moment : null
}

/**
 * Whether a job made by somebody with `job.on_call` and without `job.write`
 * may land (#293, decided on 27.09.2026): a service call, running, standing
 * on its own, whose moment of the call lies in a time of that person's
 * on-call plan, not ahead of the server's clock and at most two days back. A time taken back since,
 * or a call outside every time, is refused as a conflict about this one
 * operation; the office takes the call over from there.
 */
export async function onCallRefusal(
  tx: TenantTransaction,
  userId: string,
  values: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
): Promise<OnCallRefusal | null> {
  if (
    values['kind'] !== 'service' ||
    (values['status'] !== undefined && values['status'] !== 'active')
  ) {
    return { reason: 'record_is_fixed', fields: ['kind', 'status'] }
  }

  if (
    (values['parentJobId'] !== undefined && values['parentJobId'] !== null) ||
    (values['predecessorJobId'] !== undefined && values['predecessorJobId'] !== null)
  ) {
    return { reason: 'record_is_fixed', fields: ['parentJobId', 'predecessorJobId'] }
  }

  const moment = momentOf(values['emergencyAt'])

  if (
    moment === null ||
    moment.getTime() > now.getTime() + clockSlackMs ||
    moment.getTime() < now.getTime() - longestOfflineMs
  ) {
    return { reason: 'record_is_fixed', fields: ['emergencyAt'] }
  }

  const [covering] = await tx
    .select({ id: onCallShifts.id })
    .from(onCallShifts)
    .where(
      and(
        eq(onCallShifts.userId, userId),
        isNull(onCallShifts.deletedAt),
        lte(onCallShifts.startsAt, moment),
        gt(onCallShifts.endsAt, moment),
      ),
    )
    .limit(1)

  return covering ? null : { reason: 'record_is_fixed', fields: ['emergencyAt'] }
}

/** The units of the lines the percentage of a surcharge comes on: the working time. */
const hourUnits: readonly LineUnit[] = ['hour']

/**
 * The line for the surcharge of an emergency call (#293) on the invoice out
 * of its reports, or null: for a job without a moment of a call, for a call
 * in ordinary hours, and for a kind the business set no surcharge for on the
 * day of the call. The public holidays are those of the business on that day.
 */
export async function surchargeLineFor(
  tx: TenantTransaction,
  jobId: string | null,
  lines: readonly { readonly unit: LineUnit; readonly netCents: number }[],
): Promise<SurchargeLine | null> {
  if (jobId === null || !isUuid(jobId)) {
    return null
  }

  const [job] = await tx
    .select({ emergencyAt: jobs.emergencyAt })
    .from(jobs)
    .where(eq(jobs.id, jobId as JobId))

  if (!job?.emergencyAt) {
    return null
  }

  const tariff = await emergencyTariffOn(tx, berlinClock(job.emergencyAt).day)
  const kind: EmergencyKind | null = emergencyKindAt(
    job.emergencyAt,
    new Set(tariff.holidays),
    tariff.night,
  )

  if (kind === null) {
    return null
  }

  const hourNetCents = lines
    .filter((line) => hourUnits.includes(line.unit))
    .reduce((sum, line) => sum + line.netCents, 0)

  return emergencySurchargeLine(kind, tariff.surcharges[kind], hourNetCents)
}

/**
 * The surcharges of the business as they stand on a day (#293, #1024): the
 * night, the amount of each kind, the tax on a flat amount and the public
 * holidays of that year and the next, so that a device keeping it names the
 * surcharge of a call on any day of a time on call, across New Year as well.
 * The tax is the standard rate of the day, and none where the business
 * claims section 19 UStG on it: the customer of a call is a consumer, never
 * a recipient of construction services.
 */
export async function emergencyTariffOn(
  tx: TenantTransaction,
  day: IsoDate,
): Promise<EmergencyTariff> {
  const setting = await holidaySettingOf(tx)
  const year = Number(day.slice(0, 4))
  const holidays =
    setting === null
      ? []
      : [year, year + 1].flatMap((each) =>
          holidaysIn(shippedRules, setting, each).map((holiday) => holiday.on),
        )
  const number = async (key: Parameters<typeof parameterAt>[1]) =>
    (await parameterAt(tx, key, day))?.value ?? null
  const surcharges: Partial<Record<EmergencyKind, EmergencySurcharge>> = {}

  // One after the other: a transaction is one connection.
  for (const kind of emergencyKinds) {
    surcharges[kind] = {
      flatCents: (await number(`emergency.${kind}_flat_cents`)) ?? 0,
      basisPoints: (await number(`emergency.${kind}_basis_points`)) ?? 0,
    }
  }

  const smallBusiness = (await number('small_business.claimed')) === 1

  return {
    on: day,
    night: {
      fromMinute: (await number('emergency.night_from_minute')) ?? defaultNight.fromMinute,
      untilMinute: (await number('emergency.night_until_minute')) ?? defaultNight.untilMinute,
    },
    surcharges: surcharges as Record<EmergencyKind, EmergencySurcharge>,
    vatBasisPoints: smallBusiness
      ? null
      : shippedRules.valueAt('vat.standard', 'basis_points', day),
    holidays,
  }
}

/**
 * The surcharge of an emergency call as its customer hears it (#1024), for
 * the mail with its instructions: by the tariff of the day of the call, as
 * the invoice charges it. Null for a call that is no emergency, one in
 * ordinary hours, a kind the business set nothing for, and a business as
 * customer, which gets no instructions.
 */
export async function callSurchargeText(
  tx: TenantTransaction,
  call: { readonly emergencyAt: Date | null; readonly isBusiness: boolean },
): Promise<string | null> {
  if (call.emergencyAt === null || call.isBusiness) {
    return null
  }

  return emergencyTariffText(
    await emergencyTariffOn(tx, berlinClock(call.emergencyAt).day),
    call.emergencyAt,
  )
}
