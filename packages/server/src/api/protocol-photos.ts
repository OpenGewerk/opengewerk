import {
  BadGatewayException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  chosenPhotos,
  type FormDefinition,
  type FormValues,
  isAllowed,
  isProtocolPhoto,
  readFormValues,
  shownPhotoVersion,
} from '@opengewerk/domain'
import {
  type Database,
  isUuid,
  type Renderer,
  RendererUnavailableError,
  type TenantTransaction,
} from '@opengewerk/platform-server'
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'

import { attachments, attachmentVersions, type formRecords } from '../database/schema/index.js'
import {
  type PhotoBound,
  photoBound,
  printedCollection,
  printedPhotos,
  withinBound,
} from '../forms/photo-bound.js'
import {
  type PrintedProtocol,
  type ProtocolPhoto,
  protocolPrintJob,
} from '../forms/protocol-print.js'
import { tradeForms } from '../forms/registry.js'
import type { DocumentFiles } from './document-files.js'
import type { RequestIdentity } from './identity.js'

// The photos of a protocol as its page prints them (#817), for the page of a
// single protocol and for every collection that binds signed protocols in as
// they print on their own (#935): the inspection report of a site, the papers
// for the grid operator, the folder of a PV system and the papers of a
// funding programme.

/** A version of a file a photo field names, as the database gives it. */
interface PhotoVersion {
  readonly id: string
  readonly fileName: string
  readonly mediaType: string
  readonly sha256: string
  readonly sizeBytes: number
  /** When the server wrote the version, in the order of every write of the business. */
  readonly changeSequence: number
}

/**
 * The version of each file a protocol shows (#817), from its versions newest
 * first: the newest one; for a signed protocol the newest the server had when
 * it was signed, so that a version laid over it later does not change the
 * page, and the first one where all came after. "When" is the sequence of the
 * writes, which a version, written once, and a signed protocol, which no write
 * changes, keep: a moment would be the same for a signature and a version sent
 * in one transmission.
 */
export function shownVersions(
  versions: readonly PhotoVersion[],
  signedAt: number | null,
): Map<string, PhotoVersion> {
  const byFile = new Map<string, PhotoVersion[]>()

  // Grouped in one pass: a file may have many versions.
  for (const version of versions) {
    const list = byFile.get(version.id)

    if (list) {
      list.push(version)
    } else {
      byFile.set(version.id, [version])
    }
  }

  const shown = new Map<string, PhotoVersion>()

  for (const [id, newestFirst] of byFile) {
    const version = shownPhotoVersion(newestFirst, (each) => each.changeSequence, signedAt)

    if (version) {
      shown.set(id, version)
    }
  }

  return shown
}

/**
 * The photos a page reads, by the id of their file: the pictures among the
 * versions it shows, in order, while they stay within `printedPhotos`.
 */
export function photosToRead(
  versions: ReadonlyMap<string, PhotoVersion>,
  uses: ReadonlyMap<string, number>,
  bound: PhotoBound = printedPhotos,
): [string, PhotoVersion][] {
  // A photo several fields name is printed once for each: counted so.
  return withinBound(
    [...versions].filter(([, version]) => isProtocolPhoto(version.mediaType)),
    ([, version]) => version.sizeBytes,
    bound,
    ([id]) => uses.get(id) ?? 1,
  )
}

/** The record of a protocol, as far as its photos ask it. */
export type ProtocolRecord = Pick<
  typeof formRecords.$inferSelect,
  'installationId' | 'applianceId' | 'jobId' | 'status' | 'changeSequence'
>

/** The versions a protocol may show, how often each is named and where its files lie. */
export interface ProtocolPhotoSource {
  readonly versions: ReadonlyMap<string, PhotoVersion>
  readonly uses: ReadonlyMap<string, number>
  readonly home: NonNullable<PrintedProtocol['photoHome']>
}

/** Where the files of what a protocol is about lie: its installation, its appliance, or the job of an acceptance. */
export function photoHomeOf(record: ProtocolRecord): ProtocolPhotoSource['home'] {
  return record.installationId ? 'installation' : record.applianceId ? 'appliance' : 'job'
}

/**
 * The versions of the photos a protocol names, without their bytes, read in
 * the transaction of the page. Only for whoever may read files.
 */
export async function protocolPhotoSource(
  tx: TenantTransaction,
  identity: RequestIdentity,
  record: ProtocolRecord,
  definition: FormDefinition,
  values: FormValues,
): Promise<ProtocolPhotoSource> {
  // A photo value is the id of a file since #933; a protocol signed
  // before may still hold another text, which names no file and would
  // break the query (#817).
  const uses = chosenPhotos(definition, values)
  const chosen = [...uses.keys()].filter(isUuid)
  const signed = record.status === 'signed'
  // The files a protocol may name are those the screen offered: of the
  // installation, of the appliance, or of the job of an acceptance. A
  // signed one was signed with such a file (opengewerk#934), and a file
  // a signed protocol names stays where it hangs (migration 0144), so
  // that its page does not change; one signed before with a file of
  // something else says where the photo lies.
  const ofSubject = record.installationId
    ? eq(attachments.installationId, record.installationId)
    : record.applianceId
      ? eq(attachments.applianceId, record.applianceId)
      : record.jobId
        ? eq(attachments.jobId, record.jobId)
        : null
  // A signed protocol keeps its photo when the file goes to the bin after
  // it was signed, and shows none that lay there before: its page does
  // not change. Only a purge, which deletes the versions, takes it
  // (opengewerk#817). A file in the bin is not changed any more, so its
  // last write is the one that put it there.
  const kept = signed
    ? [or(isNull(attachments.deletedAt), gt(attachments.changeSequence, record.changeSequence))]
    : [isNull(attachments.deletedAt), isNull(attachmentVersions.deletedAt)]
  const photoRows =
    chosen.length === 0 || ofSubject === null || !isAllowed(identity, 'attachment.read')
      ? []
      : await tx
          .select({
            id: attachments.id,
            // The name of the version, which is written once, and not the
            // title of the file, which may change after a signature.
            fileName: attachmentVersions.fileName,
            mediaType: attachmentVersions.mediaType,
            sizeBytes: attachmentVersions.sizeBytes,
            sha256: attachmentVersions.sha256,
            changeSequence: attachmentVersions.changeSequence,
          })
          .from(attachments)
          .innerJoin(attachmentVersions, eq(attachmentVersions.attachmentId, attachments.id))
          .where(and(inArray(attachments.id, chosen as never[]), ofSubject, ...kept))
          // Newest first by id, as every list of files on a device shows
          // them; the sequence of the writes only bounds a signed one.
          .orderBy(asc(attachments.id), desc(attachmentVersions.id))

  return {
    versions: shownVersions(photoRows, signed ? record.changeSequence : null),
    uses,
    home: photoHomeOf(record),
  }
}

/**
 * The protocol with the bytes of its photos, as many as one request to the
 * renderer takes beside its page (#817). A photo past the bound, or one whose
 * stored file is gone, says where it lies.
 */
export async function withPhotos(
  files: DocumentFiles,
  protocol: PrintedProtocol,
  source: ProtocolPhotoSource,
  budget?: PhotoBudget,
): Promise<PrintedProtocol> {
  const located: PrintedProtocol = { ...protocol, photoHome: source.home }
  const photos = new Map<string, ProtocolPhoto>()

  // The page without its photos, as the renderer gets it, tells what is left.
  const pageBytes = Buffer.byteLength(
    JSON.stringify(protocolPrintJob({ ...located, photos: new Map() })),
  )

  const page = photoBound(pageBytes)
  const bound = budget
    ? { count: Math.min(page.count, budget.count), bytes: Math.min(page.bytes, budget.bytes) }
    : page

  for (const [id, version] of photosToRead(source.versions, source.uses, bound)) {
    const times = Math.max(1, source.uses.get(id) ?? 1)

    // What the page reads, read or not, is gone from what the collection has left.
    if (budget) {
      budget.count -= times
      budget.bytes -= version.sizeBytes * times
    }

    try {
      photos.set(id, {
        title: version.fileName,
        mediaType: version.mediaType,
        bytes: await files.read(version.sha256),
      })
    } catch (error) {
      // A stored file that is gone or damaged is a fault of the
      // installation, and the page says where the photo lies rather than
      // failing as a whole.
      if (!(error instanceof InternalServerErrorException)) {
        throw error
      }
    }
  }

  return { ...located, photos }
}

/**
 * The photos of signed protocols a collection binds in, by the id of each
 * (#935), read in a transaction of their own: a signed protocol does not
 * change, nor where a file it names hangs (opengewerk#934), and whether a file
 * went to the bin before or after the signature is in the sequence of writes.
 */
export async function photoSourcesOf(
  database: Database,
  identity: RequestIdentity,
  records: readonly (typeof formRecords.$inferSelect)[],
): Promise<ReadonlyMap<string, ProtocolPhotoSource>> {
  if (records.length === 0) {
    return new Map()
  }

  return database.forTenant(identity, async (tx) => {
    const sources = new Map<string, ProtocolPhotoSource>()

    for (const record of records) {
      const definition = tradeForms.definitionFor(record.definitionKey, record.definitionVersion)

      if (definition) {
        sources.set(
          record.id,
          await protocolPhotoSource(
            tx,
            identity,
            record,
            definition,
            readFormValues(record.values) ?? {},
          ),
        )
      }
    }

    return sources
  })
}

/** The protocol with its photos where its record has a source, and as it is otherwise. */
export async function withPhotosOf(
  files: DocumentFiles,
  protocol: PrintedProtocol,
  source: ProtocolPhotoSource | undefined,
  budget: PhotoBudget,
): Promise<PrintedProtocol> {
  return source ? withPhotos(files, protocol, source, budget) : protocol
}

/** What a collection has left of its photos, taken down by each page that reads some (#935). */
export interface PhotoBudget {
  count: number
  bytes: number
}

/** The budget of one collection, a fresh one for each request. */
export function collectionBudget(): PhotoBudget {
  return { count: printedCollection.count, bytes: printedCollection.bytes }
}

/**
 * The pages of a collection, rendered one after another, the renderer of an
 * instance being a single browser. Each page is built before the renderer is
 * asked: a fault of the store while it reads its photos is one of the server,
 * not of the renderer, and is not answered with what the store said.
 */
export async function printPages(
  render: Renderer,
  identity: RequestIdentity,
  pages: readonly Page[],
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = []

  for (const page of pages) {
    const job = typeof page === 'function' ? await page() : page

    try {
      parts.push(await render(job, identity))
    } catch (error) {
      throw rendererFault(error)
    }
  }

  return parts
}

/** What a failure of the renderer, or of binding what it rendered, answers. */
export function rendererFault(error: unknown): Error {
  if (error instanceof RendererUnavailableError) {
    return new ServiceUnavailableException(error.message)
  }

  return new BadGatewayException(error instanceof Error ? error.message : String(error))
}

/**
 * A page of a collection: a print job, or one built only when it is printed,
 * as a protocol whose photos would otherwise all lie in memory at once (#935).
 */
export type Page = Parameters<Renderer>[0] | (() => Promise<Parameters<Renderer>[0]>)
