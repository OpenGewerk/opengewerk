import {
  addDays,
  berlinClock,
  chargeableSurcharge,
  type ConflictReason,
  defaultNight,
  type DocumentId,
  emergencyKindAt,
  type EmergencyKind,
  emergencyKinds,
  type EmergencySurcharge,
  emergencySurchargeLine,
  emergencySurchargeText,
  type EmergencyTariff,
  emergencyTariffText,
  holidaysIn,
  type IsoDate,
  type JobId,
  lineLimits,
  type LineUnit,
  longestOnCallDays,
  shippedRules,
  type SurchargeLine,
  tariffStarts,
  type TenantId,
  whyFixed,
} from '@opengewerk/domain'
import { isUuid, type TenantTransaction } from '@opengewerk/platform-server'
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm'

import { holidaySettingOf } from '../absences/absences.js'
import { parameterAt, parameterHistory } from '../database/parameters.js'
import { documentLines, documents, jobs, onCallShifts } from '../database/schema/index.js'

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
 *
 * Every hour counts at the price it has (#1087), an hour without one yet at
 * nothing; the draft works the line out again when the office prices it.
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
    .select({
      emergencyAt: jobs.emergencyAt,
      namedFlatCents: jobs.emergencyNamedFlatCents,
      namedBasisPoints: jobs.emergencyNamedBasisPoints,
    })
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

  return emergencySurchargeLine(
    kind,
    chargeableSurcharge(tariff.surcharges[kind], namedOf(job), hourNetCents),
    hourNetCents,
  )
}

/**
 * What of the line of the surcharge the server works out, and a change of
 * which by hand takes it over (#1087), with the document it is on: a line a
 * device moves to another draft is no surcharge of that draft's call, and
 * that draft may have its own.
 */
const surchargeFields = [
  'documentId',
  'kind',
  'designation',
  'description',
  'quantityMilli',
  'unit',
  'unitPriceCents',
  'priceBase',
  'articleId',
] as const

/**
 * Whether a change takes the line of the surcharge over from the server
 * (#1087): its document, text, quantity, unit, price or article set to
 * something else than it holds. Its place among the lines and its rate of
 * tax are no change of the surcharge.
 */
export function takesOverSurcharge(
  values: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): boolean {
  return surchargeFields.some(
    (field) => values[field] !== undefined && values[field] !== current[field],
  )
}

/**
 * The line of the surcharge of a draft worked out again from what it depends
 * on as it stands now (#1087): the hours of the draft at the price they have,
 * the job of the draft with its call and the surcharge named before the
 * order, the settings of the day of the call. Only the marked line changes; a
 * draft without one, a fixed document and a line the office took over stay
 * as they are. The line goes where the call no longer has a surcharge, as on
 * a draft moved to a job that is no emergency, and keeps its mark while it is
 * gone: once the call has a surcharge again, the draft gets it back as a new
 * line. A line the office or a device removes loses its mark as it goes.
 * Answers whether a surcharge that is due waits for room on a full draft, or
 * is more than a line holds, in which case the line stays as it was.
 *
 * Locked like a line written in the office, so that it waits for a
 * transaction that is issuing the document and then finds it fixed.
 */
export async function refreshSurchargeLine(
  tx: TenantTransaction,
  documentId: string,
): Promise<SurchargeWait | null> {
  if (!isUuid(documentId)) {
    return null
  }

  // Most lines are on a document without one, a report above all: asked
  // first, before the document is locked. A mark on a line that is gone
  // counts, it is the surcharge the draft may get back.
  const [mark] = await tx
    .select({ id: documentLines.id })
    .from(documentLines)
    .where(
      and(
        eq(documentLines.documentId, documentId as DocumentId),
        eq(documentLines.emergencySurcharge, true),
      ),
    )
    .limit(1)

  if (!mark) {
    return null
  }

  const [document] = await tx
    .select({
      tenantId: documents.tenantId,
      kind: documents.kind,
      status: documents.status,
      jobId: documents.jobId,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId as DocumentId), isNull(documents.deletedAt)))
    .for('no key update')

  if (!document || whyFixed(document) !== null) {
    return null
  }

  const lines = await tx
    .select()
    .from(documentLines)
    .where(
      and(eq(documentLines.documentId, documentId as DocumentId), isNull(documentLines.deletedAt)),
    )
  const marked = lines.find((line) => line.emergencySurcharge)
  const surcharge = await surchargeLineFor(
    tx,
    document.jobId,
    lines.filter((line) => line !== marked),
  )

  if (!marked) {
    return surcharge === null
      ? null
      : await restoreSurchargeLine(
          tx,
          document.tenantId,
          documentId as DocumentId,
          lines,
          surcharge,
        )
  }

  if (surcharge === null) {
    await tx
      .update(documentLines)
      .set({ deletedAt: new Date() })
      .where(eq(documentLines.id, marked.id))

    return null
  }

  // Out of hours a line holds each, a sum the column cannot: written, it would
  // refuse whatever brought it, a transmission with no operation to blame.
  if (tooLarge(surcharge)) {
    return 'too large'
  }

  const next = {
    designation: surcharge.designation,
    description: surcharge.description,
    quantityMilli: surcharge.quantityMilli,
    unit: surcharge.unit,
    unitPriceCents: surcharge.unitPriceCents,
    netCents: surcharge.netCents,
  }

  // Unchanged, the line keeps its version: a device holds nothing new.
  if (
    Object.entries(next).every(([field, value]) => marked[field as keyof typeof next] === value)
  ) {
    return null
  }

  await tx.update(documentLines).set(next).where(eq(documentLines.id, marked.id))

  return null
}

/**
 * The surcharge back on a draft whose line the server took away while the
 * call had none (#1087): a new line, as the last one, with the rate of tax of
 * the line that went. The mark leaves the line that went, so that it comes
 * back once and a line removed later stays removed.
 *
 * Only where a line that went still carries the mark: one the office removed
 * while this transaction waited for the draft lost it and stays removed. And
 * only where the draft has room: on a full one the line waits, marked, until
 * the office removes another, instead of refusing the change that brought it.
 * Not next to a surcharge the office typed in meanwhile: that one is the
 * draft's surcharge, and the line that went loses its mark for good.
 */
async function restoreSurchargeLine(
  tx: TenantTransaction,
  tenantId: TenantId,
  documentId: DocumentId,
  lines: readonly {
    readonly kind: string
    readonly position: number
    readonly designation: string
  }[],
  surcharge: SurchargeLine,
): Promise<SurchargeWait | null> {
  const gone = and(
    eq(documentLines.documentId, documentId),
    eq(documentLines.emergencySurcharge, true),
    isNotNull(documentLines.deletedAt),
  )
  const [last] = await tx
    .select({ vatRate: documentLines.vatRate })
    .from(documentLines)
    .where(gone)
    .orderBy(desc(documentLines.deletedAt))
    .limit(1)

  if (!last) {
    return null
  }

  // A position the office typed as a surcharge, by its word alone or with
  // its kind after it; a heading or a text with the word is none.
  const typed = lines.some(
    (line) =>
      line.kind === 'item' &&
      (line.designation === surchargeDesignation ||
        line.designation.startsWith(`${surchargeDesignation} `)),
  )

  if (typed) {
    await tx.update(documentLines).set({ emergencySurcharge: false }).where(gone)

    return null
  }

  if (lines.length >= lineLimits.lines) {
    return 'waits for room'
  }

  if (tooLarge(surcharge)) {
    return 'too large'
  }

  await tx.update(documentLines).set({ emergencySurcharge: false }).where(gone)
  await tx.insert(documentLines).values({
    tenantId,
    documentId,
    kind: 'item',
    position: lines.reduce((last, line) => Math.max(last, line.position), 0) + 1,
    designation: surcharge.designation,
    description: surcharge.description,
    quantityMilli: surcharge.quantityMilli,
    unit: surcharge.unit,
    unitPriceCents: surcharge.unitPriceCents,
    vatRate: last.vatRate,
    netCents: surcharge.netCents,
    emergencySurcharge: true,
  })

  return null
}

/** The word every line of a surcharge begins with (`emergencySurchargeLine`). */
const surchargeDesignation = 'Notdienstzuschlag'

/**
 * Why a surcharge that is due is not on its draft (#1087): the draft has no
 * room left, or the surcharge is more than a line holds.
 */
export type SurchargeWait = 'waits for room' | 'too large'

/** The most cents a line holds: the largest integer of its columns. */
const largestCents = 2_147_483_647

function tooLarge(surcharge: SurchargeLine): boolean {
  return (
    Math.abs(surcharge.netCents) > largestCents || Math.abs(surcharge.unitPriceCents) > largestCents
  )
}

/**
 * The line of the surcharge of an invoice made out of the reports of a job
 * (#293), marked as the server's (#1087), as its last line. Where the call
 * has no surcharge now, the line is made and taken away at once, marked: the
 * draft follows its call all the same and gets the surcharge once there is
 * one, as a draft does whose line the server took away. Only for a job that
 * is an emergency call: an invoice of any other job holds no line of a
 * surcharge, not even one taken away, and its log names none. A surcharge
 * more than a line holds is made taken away as well; issuing names it.
 */
export async function insertSurchargeLine(
  tx: TenantTransaction,
  tenantId: TenantId,
  documentId: string,
  position: number,
  jobId: string | null,
  due: SurchargeLine | null,
): Promise<void> {
  // A surcharge with no room on the invoice, copied full from its report, or
  // more than a line holds waits taken away, as on a draft; issuing names it.
  const [held] =
    due === null
      ? []
      : await tx
          .select({ lines: count() })
          .from(documentLines)
          .where(
            and(
              eq(documentLines.documentId, documentId as DocumentId),
              isNull(documentLines.deletedAt),
            ),
          )
  const surcharge =
    due !== null && !tooLarge(due) && (held?.lines ?? 0) < lineLimits.lines ? due : null

  if (surcharge === null) {
    const [job] =
      jobId === null || !isUuid(jobId)
        ? []
        : await tx
            .select({ emergencyAt: jobs.emergencyAt })
            .from(jobs)
            .where(and(eq(jobs.id, jobId as JobId), isNull(jobs.deletedAt)))

    if (!job?.emergencyAt) {
      return
    }
  }

  await tx.insert(documentLines).values({
    tenantId,
    documentId: documentId as DocumentId,
    kind: 'item',
    position,
    designation: surcharge?.designation ?? surchargeDesignation,
    description: surcharge?.description ?? null,
    quantityMilli: surcharge?.quantityMilli ?? 1000,
    unit: surcharge?.unit ?? 'flat_rate',
    unitPriceCents: surcharge?.unitPriceCents ?? 0,
    vatRate: 'standard',
    netCents: surcharge?.netCents ?? 0,
    emergencySurcharge: true,
    ...(surcharge === null ? { deletedAt: new Date() } : {}),
  })
}

/**
 * The drafts that have a line of the surcharge, of one job or of all of them
 * (#1087), locked in the order of their ids. A marked line that is gone
 * counts: its draft may get the surcharge back.
 *
 * Taken before the first write of a transaction that works them out again
 * afterwards. Issuing locks its document before it writes anything the log
 * records; a transaction that wrote first and locked the draft afterwards
 * would wait for it in a circle, and PostgreSQL would end one of the two.
 */
export async function lockSurchargeDrafts(
  tx: TenantTransaction,
  jobId: string | null = null,
): Promise<readonly string[]> {
  if (jobId !== null && !isUuid(jobId)) {
    return []
  }

  const drafts = await surchargeDrafts(tx, jobId === null ? null : [jobId]).for('no key update')

  return drafts.map((draft) => draft.id)
}

/**
 * The drafts with a line of the surcharge of these jobs, without a lock: for
 * a transmission that locks them with every other document it comes to,
 * in one order (#1087).
 */
export async function surchargeDraftsOf(
  tx: TenantTransaction,
  jobIds: readonly string[],
): Promise<readonly { readonly id: string; readonly jobId: string | null }[]> {
  const valid = jobIds.filter((jobId) => isUuid(jobId))

  if (valid.length === 0) {
    return []
  }

  return await surchargeDrafts(tx, valid)
}

/** The drafts with a line of the surcharge, a line gone included, of these jobs or of all. */
function surchargeDrafts(tx: TenantTransaction, jobIds: readonly string[] | null) {
  return tx
    .select({ id: documents.id, jobId: documents.jobId })
    .from(documents)
    .where(
      and(
        eq(documents.status, 'draft'),
        isNull(documents.deletedAt),
        ...(jobIds === null ? [] : [inArray(documents.jobId, jobIds as JobId[])]),
        inArray(
          documents.id,
          tx
            .select({ id: documentLines.documentId })
            .from(documentLines)
            .where(eq(documentLines.emergencySurcharge, true)),
        ),
      ),
    )
    .orderBy(documents.id)
}

/**
 * The lines of the surcharge of the drafts `lockSurchargeDrafts` locked
 * before the caller wrote, worked out again (#1087): of the drafts of one
 * job, after its call or the surcharge named for it changed, or of all of
 * them, after a setting of the surcharges or the public holidays changed.
 * Only those: a draft that came to the job since was worked out by whoever
 * moved it, and locking it now, after the write, would be the circle the
 * lock before avoids. Issuing works every draft out once more.
 */
export async function refreshSurchargeLines(
  tx: TenantTransaction,
  drafts: readonly string[],
): Promise<void> {
  // One after the other: a transaction is one connection.
  for (const draft of drafts) {
    await refreshSurchargeLine(tx, draft)
  }
}

/** The fields of a job the surcharge of its call depends on (#1087). */
export const surchargeFieldsOfJob: readonly string[] = [
  'emergencyAt',
  'emergencyNamedFlatCents',
  'emergencyNamedBasisPoints',
]

/** The surcharge named before the order of a call (#1081), or null where nobody recorded one. */
function namedOf(job: {
  readonly namedFlatCents: number | null
  readonly namedBasisPoints: number | null
}): EmergencySurcharge | null {
  return job.namedFlatCents === null || job.namedBasisPoints === null
    ? null
    : { flatCents: job.namedFlatCents, basisPoints: job.namedBasisPoints }
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
    until: day,
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
 * The settings a tariff reads, so that a new value of one of them begins a
 * new tariff, and the lines of the surcharge of the drafts follow it (#1087).
 */
export const tariffSettings: ReadonlySet<string> = new Set([
  ...emergencyKinds.flatMap((kind) => [
    `emergency.${kind}_flat_cents`,
    `emergency.${kind}_basis_points`,
  ]),
  'emergency.night_from_minute',
  'emergency.night_until_minute',
  'small_business.claimed',
])

/**
 * The tariffs of the days from `from` on, as far as a time on call can reach
 * (#1024): one for each span in which the values stay the same, so that a
 * device without a network names the surcharge of the day of the call, also
 * after a setting or the rate of tax changes. Each tariff is read the way the
 * invoice reads it, by `emergencyTariffOn`.
 */
export async function emergencyTariffsFrom(
  tx: TenantTransaction,
  from: IsoDate,
): Promise<EmergencyTariff[]> {
  const last = addDays(from, longestOnCallDays)
  const settingDays = (await parameterHistory(tx))
    .filter((row) => tariffSettings.has(row.key))
    .map((row) => row.validFrom)
  const starts = tariffStarts(from, last, settingDays, (day) =>
    shippedRules.valueAt('vat.standard', 'basis_points', day),
  )
  const tariffs: EmergencyTariff[] = []

  for (const [index, start] of starts.entries()) {
    const next = starts[index + 1]

    tariffs.push({
      ...(await emergencyTariffOn(tx, start)),
      until: next === undefined ? last : addDays(next, -1),
    })
  }

  return tariffs
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
  call: {
    readonly emergencyAt: Date | null
    readonly isBusiness: boolean
    readonly emergencyNamedFlatCents: number | null
    readonly emergencyNamedBasisPoints: number | null
  },
): Promise<string | null> {
  if (call.emergencyAt === null || call.isBusiness) {
    return null
  }

  const tariff = await emergencyTariffOn(tx, berlinClock(call.emergencyAt).day)
  const named = namedOf({
    namedFlatCents: call.emergencyNamedFlatCents,
    namedBasisPoints: call.emergencyNamedBasisPoints,
  })

  if (named === null) {
    return emergencyTariffText(tariff, call.emergencyAt)
  }

  // What was named is what the customer heard (#1081), and the invoice charges
  // no more; where nothing was named, the mail names nothing either.
  const kind = emergencyKindAt(call.emergencyAt, new Set(tariff.holidays), tariff.night)

  return kind === null ? null : emergencySurchargeText(kind, named, tariff.vatBasisPoints)
}
