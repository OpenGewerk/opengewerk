import {
  berlinClock,
  type ConflictReason,
  type CustomerId,
  type EarlyStartRequestId,
  type EarlyStartWording,
  type InstructionSheet,
  instructionSheetsFingerprint,
  type IsoDate,
  type JobId,
  jobInstructions,
  jobInstructionsRefusal,
  type JobKind,
  type TenantId,
} from '@opengewerk/domain'
import { isUuid, type TenantTransaction } from '@opengewerk/platform-server'
import { and, eq, isNull } from 'drizzle-orm'

import { customers, earlyStartRequests, jobs } from '../database/schema/index.js'
import { issuerOf } from '../documents/content.js'
import { ensureShippedInstructions, instructionsOf } from '../documents/instructions.js'
import type { CallInstructionsPrint } from '../documents/template.js'

/** A service call as far as its instructions need it. */
export interface CallForInstructions {
  readonly id: JobId
  readonly tenantId: TenantId
  readonly kind: JobKind
  readonly number: string | null
  readonly designation: string
  readonly urgentRepair: boolean
  readonly customerId: CustomerId
  readonly customerName: string
  readonly customerEmail: string | null
  readonly isBusiness: boolean
  readonly street: string | null
  readonly houseNumber: string | null
  readonly postalCode: string | null
  readonly city: string | null
  readonly country: string
}

/** The instructions of a service call on a day, as the device shows them and the PDF prints them. */
export interface CallInstructions {
  readonly call: CallForInstructions
  /** Why the job gets none, or null when it does. */
  readonly refusal: string | null
  readonly sheets: readonly InstructionSheet[]
  /** The words the customer signs on the device, or null when the business has no sheet for it. */
  readonly request: string | null
  /** What the letterhead lacks before they can go out, as sentences. */
  readonly gaps: readonly string[]
  readonly fingerprint: string
}

/** The job with its customer, or null when there is none or it was deleted. */
export async function callOf(
  tx: TenantTransaction,
  jobId: JobId,
): Promise<CallForInstructions | null> {
  // What is no identifier names no job: a 404 at the routes, not a fault of the database.
  if (!isUuid(jobId)) {
    return null
  }

  const [call] = await tx
    .select({
      id: jobs.id,
      tenantId: jobs.tenantId,
      kind: jobs.kind,
      number: jobs.number,
      designation: jobs.designation,
      urgentRepair: jobs.urgentRepair,
      customerId: jobs.customerId,
      customerName: customers.name,
      customerEmail: customers.email,
      isBusiness: customers.isBusiness,
      street: customers.street,
      houseNumber: customers.houseNumber,
      postalCode: customers.postalCode,
      city: customers.city,
      country: customers.country,
    })
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(and(eq(jobs.id, jobId), isNull(jobs.deletedAt)))

  return call ?? null
}

/**
 * The instructions of a service call (#292): the four of
 * `jobInstructionTemplates` in the business's wording of that day, filled in
 * from its letterhead. For a job that gets none, the reason and no sheets.
 */
export async function callInstructions(
  tx: TenantTransaction,
  call: CallForInstructions,
  on: IsoDate,
): Promise<CallInstructions> {
  const refusal = jobInstructionsRefusal(call, call)

  if (refusal !== null) {
    return { call, refusal, sheets: [], request: null, gaps: [], fingerprint: '' }
  }

  await ensureShippedInstructions(tx, call.tenantId)

  const rows = await instructionsOf(tx)
  const issuer = await issuerOf(tx, call.tenantId)
  const { sheets, request, gaps } = jobInstructions(
    rows.map((row) => ({
      id: row.id,
      template: row.template,
      title: row.title,
      body: row.body,
      kinds: row.kinds,
      consumersOnly: row.consumersOnly,
      withDocument: row.withDocument,
    })),
    on,
    issuer,
  )

  return {
    call,
    refusal: null,
    sheets,
    request,
    gaps: gaps.map((gap) => gap.message),
    fingerprint: instructionSheetsFingerprint(sheets, request),
  }
}

/** Why a request for an early start may not land, in the shape a sync conflict records. */
export interface EarlyStartRefusal {
  readonly reason: ConflictReason
  readonly fields: readonly string[]
}

/** What became of a request for an early start arriving from a device. */
export type EarlyStartArrival =
  | { readonly refusal: EarlyStartRefusal; readonly wording: null }
  | { readonly refusal: null; readonly wording: EarlyStartWording }

/**
 * Whether a request for an early start arriving from a device was signed under
 * what this server shows for its job, like a signature under a report
 * (`signatureRefusal`), and under which words. The device sends the
 * fingerprint of the sheets the customer read; here they are put together
 * again for the day of the signature. Different, the office changed a wording
 * or the customer in the meantime, and the request is refused as a conflict
 * rather than kept under words the customer never saw. A job that is gone, no
 * longer a service call or whose customer is a business now is refused the
 * same way. Let through, the words are those of this one read, the ones just
 * compared: kept from it and not read again, they are the words whose
 * fingerprint the device sent, whatever the settings say a moment later.
 */
export async function earlyStartArrival(
  tx: TenantTransaction,
  values: Readonly<Record<string, unknown>>,
): Promise<EarlyStartArrival> {
  const held = await instructionsForRequest(tx, values)

  if (!held) {
    return { refusal: { reason: 'record_missing', fields: ['jobId'] }, wording: null }
  }

  if (held.refusal !== null) {
    return { refusal: { reason: 'changed_elsewhere', fields: ['jobId'] }, wording: null }
  }

  return values['contentFingerprint'] === held.fingerprint
    ? { refusal: null, wording: { sheets: held.sheets, request: held.request } }
    : { refusal: { reason: 'changed_elsewhere', fields: ['contentFingerprint'] }, wording: null }
}

/** The instructions of the job of a request, for the day of its signature; null for a job that is gone. */
async function instructionsForRequest(
  tx: TenantTransaction,
  values: Readonly<Record<string, unknown>>,
): Promise<CallInstructions | null> {
  const call = await callOf(tx, String(values['jobId'] ?? '') as JobId)

  if (!call) {
    return null
  }

  const signedAt = values['signedAt']
  const moment = signedAt instanceof Date ? signedAt : new Date(String(signedAt))

  return callInstructions(
    tx,
    call,
    berlinClock(Number.isNaN(moment.getTime()) ? new Date() : moment).day,
  )
}

/**
 * The fingerprint of the instructions in the form a request signed before
 * SHA-256 carries: FNV-1a over the UTF-16 code units, with the length beside
 * it. Only compared, to tell whether such a request still matches the
 * settings; nothing is marked with it any more.
 */
export function legacyInstructionsFingerprint(
  sheets: readonly InstructionSheet[],
  request: string | null,
): string {
  const text = JSON.stringify([
    sheets.map((sheet) => [sheet.template, sheet.title, sheet.text]),
    request,
  ])
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `fnv1a32:${hash.toString(16).padStart(8, '0')}:${String(text.length)}`
}

/**
 * The words a request was signed under: kept with it since it lands, or, for
 * a request from before, those of the settings for its day while they still
 * have its fingerprint. Otherwise its signature is printed under none at all,
 * rather than under words the customer never read.
 */
function signedWording(
  request: { readonly contentFingerprint: string; readonly wording: EarlyStartWording | null },
  held: CallInstructions,
): EarlyStartWording {
  if (request.wording) {
    return request.wording
  }

  if (
    request.contentFingerprint === held.fingerprint ||
    request.contentFingerprint === legacyInstructionsFingerprint(held.sheets, held.request)
  ) {
    return { sheets: held.sheets, request: held.request }
  }

  throw new CallInstructionsRefused(unsignedWording)
}

/** Why a request from before its wording was kept cannot be printed any more. */
export const unsignedWording =
  'Die Belehrungen sind seit der Unterschrift anders formuliert worden. Das Verlangen wird deshalb nicht unter dem heutigen Wortlaut gedruckt.'

/** Why the instructions of a call cannot be printed, as the sentence the office or the mail shows. */
export class CallInstructionsRefused extends Error {}

/**
 * What the PDF of a call's instructions prints (#292): the words of the day
 * of the request signed at the door, with that request, or of `day` for the
 * sheets alone. Refused when the job gets none or the letterhead lacks what
 * the words need, with that sentence.
 */
export async function callPrintFacts(
  tx: TenantTransaction,
  jobId: JobId,
  requestId: string | null,
  day: IsoDate,
): Promise<CallInstructionsPrint> {
  const call = await callOf(tx, jobId)

  if (!call) {
    throw new CallInstructionsRefused('Den Auftrag gibt es nicht mehr.')
  }

  const [request] = requestId
    ? await tx
        .select({
          signerName: earlyStartRequests.signerName,
          signedAt: earlyStartRequests.signedAt,
          path: earlyStartRequests.path,
          contentFingerprint: earlyStartRequests.contentFingerprint,
          wording: earlyStartRequests.wording,
        })
        .from(earlyStartRequests)
        .where(
          and(
            eq(earlyStartRequests.id, requestId as EarlyStartRequestId),
            eq(earlyStartRequests.jobId, jobId),
          ),
        )
    : []

  if (requestId && !request) {
    throw new CallInstructionsRefused('Dieses Verlangen gehört nicht zu diesem Auftrag.')
  }

  const on = request ? berlinClock(request.signedAt).day : day
  const held = await callInstructions(tx, call, on)

  // Words kept with a request are printed as they are: whatever the job or
  // the letterhead lack today, they were complete when the customer signed.
  // Only words put together now have to be complete now.
  if (!request?.wording) {
    if (held.refusal !== null) {
      throw new CallInstructionsRefused(held.refusal)
    }

    if (held.gaps.length > 0) {
      throw new CallInstructionsRefused(held.gaps.join(' '))
    }
  }

  // The words the customer signed under, not those of today's settings.
  const wording = request ? signedWording(request, held) : null

  return {
    issuer: await issuerOf(tx, call.tenantId),
    recipient: {
      name: call.customerName,
      street: call.street,
      houseNumber: call.houseNumber,
      postalCode: call.postalCode,
      city: call.city,
      country: call.country,
    },
    call: { number: call.number, designation: call.designation },
    on,
    sheets: wording?.sheets ?? held.sheets,
    signed:
      // An empty request is still the one signed, and its signature stands.
      request && wording && wording.request !== null
        ? {
            request: wording.request,
            signerName: request.signerName,
            signedAt: request.signedAt.toISOString(),
            path: request.path,
          }
        : null,
  }
}
