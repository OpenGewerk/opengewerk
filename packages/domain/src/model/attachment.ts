import { type AttachmentRecord, attachmentRules } from '@opengewerk/platform-domain'
import type {
  ApplianceId,
  CustomerId,
  DefectId,
  InstallationId,
  JobId,
  SiteId,
} from './identifier.js'

/**
 * A file in the business's records, hung on what it is about (#77, 4.10).
 *
 * A customer, a site, an installation, an appliance (#817) and a job, any of
 * them and at least one.
 * The links are independent, like a task's: a wiring diagram taken at a job
 * carries the job and, with it, the installation, the site and the customer,
 * so it turns up wherever somebody looks for it later. One hung on a customer
 * carries only the customer.
 *
 * What a file is, its versions and how a photo is made smaller are the
 * foundation's (opengewerk-haustechnik#97); what one hangs on here is this
 * application's. The bytes are not here and not on this row's versions
 * either. They lie in the content addressed store from ADR 0007, and a
 * version names them by their SHA-256.
 *
 * The photo of a defect (#311) names the defect beside its places. A defect is
 * not a place of its own: the photo lies among the files of the defect's job
 * or installation, which a trigger in the database holds.
 */
export interface Attachment extends AttachmentRecord {
  readonly customerId: CustomerId | null
  readonly siteId: SiteId | null
  readonly installationId: InstallationId | null
  readonly jobId: JobId | null
  /** The appliance of the register a photo shows (#817), tested by DGUV Vorschrift 3. */
  readonly applianceId: ApplianceId | null
  readonly defectId: DefectId | null
}

/**
 * The rules of the files of this application, as the foundation makes them
 * from its five places and its two sentences: one object for the screens and
 * the sync, so that both read the rule the check `attachments_have_a_home`
 * holds in the database the same way.
 */
export const tradeAttachments = attachmentRules({
  homes: ['customerId', 'siteId', 'installationId', 'applianceId', 'jobId'],
  text: {
    noHome:
      'Eine Datei hängt an einem Kunden, einem Objekt, einer Anlage, einem Gerät oder einem Auftrag.',
    mediaType: 'Der Typ der Datei ist nicht so angegeben, wie OpenGewerk ihn festhält.',
  },
})

/**
 * Whether a file of this type is a photo a protocol prints (#817): a picture
 * the renderer shows in every PDF viewer. The field of a protocol offers only
 * these, and its page shows only these.
 */
export function isProtocolPhoto(mediaType: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)
}

/**
 * The version of a photo a protocol shows (#817), from the versions of its
 * file newest first, as every list of files orders them (by id): the newest;
 * for a signed protocol the newest the server had written when it was signed,
 * by the sequence of its writes, which a version, written once, and a signed
 * protocol, which no write changes, keep; and the first where all came after.
 * A version the server has not written yet counts as after any signature.
 */
export function shownPhotoVersion<V>(
  newestFirst: readonly V[],
  sequenceOf: (version: V) => number | null,
  signedAt: number | null,
): V | undefined {
  return (
    newestFirst.find((version) => {
      const sequence = sequenceOf(version)

      return signedAt === null || (sequence !== null && sequence <= signedAt)
    }) ?? newestFirst.at(-1)
  )
}

/** Why a type is not the one `fileMediaType` records, or null when it is. */
export function attachmentMediaTypeProblem(mediaType: unknown): string | null {
  return tradeAttachments.mediaTypeProblem(mediaType)
}

/** The five places a file can hang on. */
export const attachmentHomes = tradeAttachments.homes

/**
 * Why an attachment has nowhere to hang, or null when it has somewhere. A form
 * takes its places from the screen it stands on, so only a broken client sends
 * none; the check in the database holds the same rule.
 */
export function attachmentHomeProblem(attachment: {
  readonly customerId?: unknown
  readonly siteId?: unknown
  readonly installationId?: unknown
  readonly applianceId?: unknown
  readonly jobId?: unknown
}): string | null {
  return tradeAttachments.homeProblem(attachment)
}
