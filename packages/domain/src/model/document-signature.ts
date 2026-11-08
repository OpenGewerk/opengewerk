import type { LineKind, LineUnit } from './document-line.js'
import type { Synced } from '@opengewerk/platform-domain'
import type { DocumentId, DocumentSignatureId } from './identifier.js'
import { sha256Hex } from './sha256.js'

// The name typed in under a signature and its length, which the check
// `document_signatures_signer_named` holds, are the foundation's since
// opengewerk-haustechnik#28 (`signerNameProblem`, `longestSignerName`): a form
// of any application asks the same.

/** What a browser says about itself, as much as `document_signatures_device_info_short` keeps. */
export const longestDeviceInfo = 500

/**
 * What is wrong with the device information of a signature, or null when
 * nothing is. The form cuts what the browser says to the length the table
 * keeps, so only a client that does not ever meets this.
 */
export function deviceInfoProblem(info: unknown): string | null {
  return typeof info === 'string' && info.length > longestDeviceInfo
    ? `Die Angabe zum Gerät hat höchstens ${String(longestDeviceInfo)} Zeichen.`
    : null
}

/**
 * A signature on a document, captured on the device it was given on.
 *
 * Section 4.10 calls this a simple electronic signature with a timestamp and
 * device information, and that is all it is: the picture, when it was made,
 * on which device, and the name of whoever signed. Not more, because more
 * would promise an evidential weight a simple signature does not carry.
 *
 * Written once and never changed. It travels like any record a technician
 * makes, through the outbox, because it is made in a cellar; and from the
 * moment it lands, the document it belongs to is `signed` and changes no
 * further.
 */
export interface DocumentSignature extends Synced {
  readonly id: DocumentSignatureId
  readonly documentId: DocumentId
  /**
   * Typed on the device, never taken from the customer record. On a building
   * site the person who signs is often not the customer but whoever was there.
   */
  readonly signerName: string
  /** The device's clock at the moment the signature was confirmed. */
  readonly signedAt: Date
  /** What the browser says about itself, the "device information" of 4.10. */
  readonly deviceInfo: string | null
  /** The picture, as a path in the units of `signatureBox`. */
  readonly path: string
  /** What the signature is about, see `signedContentFingerprint`. */
  readonly contentFingerprint: string
}

/** What a customer sees on the device before signing, and so what a signature is about. */
export interface SignedContent {
  /**
   * What the head of the page names: the subject, the date of the document,
   * its customer and its job, where it has one. The last two by id, so that
   * renaming the customer or the job is no other page. None where a test or
   * an older caller leaves them out.
   */
  readonly subject?: string | null
  readonly documentDate?: string | null
  readonly customerId?: string | null
  readonly jobId?: string | null
  readonly introText: string | null
  /**
   * The values of the fields the business gives its reports (#78), as the
   * JSON text the report carries. Absent or empty on a report without them,
   * and then none in the fingerprint. A fingerprint kept from before the
   * form `signed-content-3` cannot be worked out again from the report.
   */
  readonly fields?: string | null
  /**
   * The version of the definition the fields were shown with (#78): the
   * labels, units and options a value meant on the page. Another version of
   * the same values is another page.
   */
  readonly fieldsVersion?: number | null
  readonly lines: readonly {
    readonly id: string
    readonly position: number
    readonly kind: LineKind
    readonly designation: string
    readonly description: string | null
    readonly quantityMilli: number
    readonly unit: LineUnit
  }[]
}

/**
 * The mark of what was signed, worked out the same way on the device and on
 * the server.
 *
 * The device computes it from what it shows while the customer signs, and
 * sends it along. The server computes it again when the signature arrives,
 * from what it holds, and refuses the signature when the two differ: a line
 * added in the office while the customer was signing on site would otherwise
 * end up under a signature for a page it was never on.
 *
 * Everything the page showed goes in: the subject, the date, the customer and
 * the job its head names, the text, the lines, the fields and the version of
 * their definition, which says what a value meant. Prices stay
 * out, because the device does not show any, and so does everything the
 * office adds later to make an invoice of it. A change made on purpose has to
 * be found as surely as one made by accident: with thirty-two bits, somebody
 * who may write a draft could find a different text with the same mark and
 * have the signature land under it, so it is SHA-256 (`textFingerprint`). The
 * first entry names the form of the content, so that the next form is a new
 * mark and never the same one by chance.
 */
export function signedContentFingerprint(content: SignedContent): string {
  const lines = [...content.lines]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((line) => [line.kind, line.designation, line.description, line.quantityMilli, line.unit])
  const fields = content.fields === '{}' ? null : (content.fields ?? null)

  return textFingerprint(
    JSON.stringify([
      'signed-content-3',
      content.subject ?? null,
      content.documentDate ?? null,
      content.customerId ?? null,
      content.jobId ?? null,
      content.introText,
      lines,
      fields,
      content.fieldsVersion ?? null,
    ]),
  )
}

/**
 * The mark of a text a customer signs under: SHA-256 of its UTF-8 bytes, with
 * the name of the algorithm in front (see `signedContentFingerprint`). The
 * request for an early start of #292 is marked the same way. A mark of the
 * form before, FNV-1a of thirty-two bits, is never the same as one of these,
 * so a signature a device still holds with one comes back as changed.
 */
export function textFingerprint(text: string): string {
  return `sha256:${sha256Hex(text)}`
}
