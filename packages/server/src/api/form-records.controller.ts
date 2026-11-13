import {
  BadGatewayException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common'
import {
  acceptanceOf,
  applianceSubject,
  type FormRecordStatus,
  type IsoDate,
  isAllowed,
  isProtocolPhoto,
  readFormValues,
  shippedRules,
  warrantyTerms,
  yearsText,
} from '@opengewerk/domain'
import {
  addressLines,
  Database,
  isUuid,
  present,
  RENDERER,
  type Renderer,
  RendererUnavailableError,
} from '@opengewerk/platform-server'
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import type { Response } from 'express'

import {
  appliances,
  attachments,
  attachmentVersions,
  formRecords,
  installations,
  jobs,
  letterheads,
  sites,
  tenants,
} from '../database/schema/index.js'
import {
  chosenPhotos,
  type PrintedProtocol,
  protocolPrintJob,
  type ProtocolPhoto,
} from '../forms/protocol-print.js'
import { tradeForms, tradeRules } from '../forms/registry.js'
import { RequiresPermission } from './authorization.js'
import { DocumentFiles } from './document-files.js'
import { CurrentIdentity, type RequestIdentity } from './identity.js'

/** A version of a file a photo field names, as the database gives it. */
interface PhotoVersion {
  readonly id: string
  readonly fileName: string
  readonly mediaType: string
  readonly sha256: string
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
  const shown = new Map<string, PhotoVersion>()
  const first = new Map<string, PhotoVersion>()

  for (const version of versions) {
    first.set(version.id, version)

    if (!shown.has(version.id) && (signedAt === null || version.changeSequence <= signedAt)) {
      shown.set(version.id, version)
    }
  }

  for (const [id, version] of first) {
    if (!shown.has(id)) {
      shown.set(id, version)
    }
  }

  return shown
}

/** "Gewährleistung bis 05.11.2031: fünf Jahre ab der Abnahme (§ 634a Abs. 1 Nr. 2 BGB)." and the parts, where they end sooner (#310). */
export function warrantyNotes(
  values: Parameters<typeof acceptanceOf>[0],
  acceptedOn: IsoDate,
): readonly string[] {
  const acceptance = acceptanceOf(values)
  const terms = acceptance ? warrantyTerms(acceptedOn, acceptance, shippedRules) : null
  const day = (on: IsoDate) => `${on.slice(8, 10)}.${on.slice(5, 7)}.${on.slice(0, 4)}`

  if (acceptance?.result === 'refused') {
    return ['Abnahme verweigert: die Gewährleistung beginnt nicht.']
  }

  return terms === null
    ? []
    : [
        `Gewährleistung bis ${day(terms.whole.endsOn)}: ${yearsText(terms.whole.years)} ab der Abnahme (${terms.whole.source}).`,
        ...(terms.parts === null
          ? []
          : [
              `Für wartungsbedürftige Teile ohne übertragene Wartung bis ${day(terms.parts.endsOn)}: ${yearsText(terms.parts.years)} (${terms.parts.source}).`,
            ]),
      ]
}

/**
 * The PDF of a filled form (#78), the test protocol of #79 first.
 *
 * Under the right of the installation it hangs on, like its circuit chart;
 * the test of an appliance of the register under the same (#303). A photo a
 * field names is on the page for whoever may see the files (#817); in a draft
 * only one of the files of what was tested, in a signed protocol the file it
 * names wherever it hangs now (opengewerk#934).
 * Printed on every request out of the record and kept nowhere: a signed
 * protocol does not change, and everything it depends on is in it.
 */
@Controller('form-records')
export class FormRecordsController {
  constructor(
    private readonly database: Database,
    private readonly files: DocumentFiles,
    @Inject(RENDERER) private readonly render: Renderer,
  ) {}

  @Get(':id/pdf')
  @RequiresPermission('installation.read')
  async print(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!isUuid(id)) {
      throw new NotFoundException()
    }

    const gathered = await this.database.forTenant(
      identity,
      async (tx): Promise<PrintedProtocol & { readonly versions: Map<string, PhotoVersion> }> => {
        const [record] = await tx
          .select()
          .from(formRecords)
          .where(and(eq(formRecords.id, id as never), isNull(formRecords.deletedAt)))
        const definition = record
          ? tradeForms.definitionFor(record.definitionKey, record.definitionVersion)
          : null

        if (!record || !definition) {
          throw new NotFoundException()
        }

        const [installation] = record.installationId
          ? await tx.select().from(installations).where(eq(installations.id, record.installationId))
          : []
        const [appliance] = record.applianceId
          ? await tx.select().from(appliances).where(eq(appliances.id, record.applianceId))
          : []
        // A form of a job alone is its acceptance (#310): the job is what it is about.
        const [job] =
          !record.installationId && !record.applianceId && record.jobId
            ? await tx.select().from(jobs).where(eq(jobs.id, record.jobId))
            : []
        const siteId = installation?.siteId ?? appliance?.siteId ?? job?.siteId
        const [site] = siteId ? await tx.select().from(sites).where(eq(sites.id, siteId)) : []
        const [letterhead] = await tx
          .select({ companyName: letterheads.companyName, phone: letterheads.phone })
          .from(letterheads)
          .where(eq(letterheads.tenantId, identity.tenantId))
        const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
        const companyName = letterhead?.companyName ?? null
        const values = readFormValues(record.values) ?? {}
        // The check of the values takes any short text for a photo; only an id
        // can name a file, and anything else would break the query (#817).
        const chosen = chosenPhotos(definition, values).filter(isUuid)
        const signed = record.status === 'signed'
        // The files a draft may name are those the screen offered: of the
        // installation, of the appliance, or of the job of an acceptance. A
        // signed protocol names its file for good, wherever it is hung later,
        // so that its page does not change (opengewerk#817); whoever may read
        // files may read every one of the business anyway.
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
          ? [
              or(
                isNull(attachments.deletedAt),
                gt(attachments.changeSequence, record.changeSequence),
              ),
            ]
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
                  sha256: attachmentVersions.sha256,
                  changeSequence: attachmentVersions.changeSequence,
                })
                .from(attachments)
                .innerJoin(attachmentVersions, eq(attachmentVersions.attachmentId, attachments.id))
                .where(
                  and(
                    inArray(attachments.id, chosen as never[]),
                    ...(signed ? [] : [ofSubject]),
                    ...kept,
                  ),
                )
                // Newest first in the order of the writes, which also tells two
                // versions of one transmission apart.
                .orderBy(asc(attachments.id), desc(attachmentVersions.changeSequence))

        return {
          versions: shownVersions(photoRows, signed ? record.changeSequence : null),
          definition,
          values,
          performedOn: record.performedOn as IsoDate,
          status: record.status as FormRecordStatus,
          keeper: {
            name: present(companyName) ? companyName : (tenant?.name ?? ''),
            phone: letterhead?.phone ?? null,
          },
          installation:
            installation?.designation ??
            (appliance
              ? applianceSubject(appliance)
              : job
                ? [job.designation, job.number].filter(present).join(', ')
                : ''),
          appliance: appliance
            ? {
                protectionClass: appliance.protectionClass,
                cordLengthMilli: appliance.cordLengthMilli,
              }
            : null,
          site: site
            ? [site.designation, ...addressLines(site, 'DE')].filter(present).join(', ')
            : '',
          rules: tradeRules,
          notes:
            definition.purpose === 'acceptance'
              ? warrantyNotes(readFormValues(record.values) ?? {}, record.performedOn as IsoDate)
              : [],
          photoHome: record.installationId
            ? 'installation'
            : record.applianceId
              ? 'appliance'
              : 'job',
        }
      },
    )

    const { versions, ...printed } = gathered
    const photos = new Map<string, ProtocolPhoto>()

    for (const [id, version] of versions) {
      if (isProtocolPhoto(version.mediaType)) {
        photos.set(id, {
          title: version.fileName,
          mediaType: version.mediaType,
          bytes: await this.files.read(version.sha256),
        })
      }
    }

    const protocol: PrintedProtocol = { ...printed, photos }
    let bytes: Uint8Array

    try {
      bytes = await this.render(protocolPrintJob(protocol), identity)
    } catch (error) {
      if (error instanceof RendererUnavailableError) {
        throw new ServiceUnavailableException(error.message)
      }

      throw new BadGatewayException(error instanceof Error ? error.message : String(error))
    }

    const name =
      `${protocol.definition.title} ${protocol.installation} ${protocol.performedOn}.pdf`.replaceAll(
        /[/:*?"<>|]+/g,
        '-',
      )

    response.setHeader('Cache-Control', 'no-store')

    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="Protokoll.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
      length: bytes.byteLength,
    })
  }
}
