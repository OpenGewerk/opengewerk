import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common'
import {
  type DocumentId,
  type FundingEvidence,
  fundingChecklist,
  fundingKinds,
  type FundingProgramId,
  filledDeclaration,
  type InstallationId,
  inStructureOrder,
  type IsoDate,
  readFormValues,
  type TenantId,
} from '@opengewerk/domain'
import {
  addressLines,
  Database,
  isUuid,
  present,
  RENDERER,
  type Renderer,
  type TenantTransaction,
} from '@opengewerk/platform-server'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Response } from 'express'

import {
  attachments,
  attachmentVersions,
  customers,
  documents,
  formRecords,
  fundingPrograms,
  installations,
  inverters,
  jobs,
  letterheads,
  pvModules,
  pvStrings,
  sites,
  tenants,
} from '../database/schema/index.js'
import { day } from '../forms/appliance-report.js'
import {
  declarationJob,
  enclosedSaid,
  type FundingLine,
  type FundingPapers,
  type FundingPhoto,
  type FundingSerial,
  fundingCoverJob,
  photosJob,
  serialNumbersJob,
} from '../forms/funding-papers.js'
import { kilowattHourText, kilowattText } from '../forms/grid-documents.js'
import { bound } from '../forms/inspection-report.js'
import { photoBound, printedTextBytes, withinBound } from '../forms/photo-bound.js'
import { protocolPrintJob } from '../forms/protocol-print.js'
import { tradeForms, tradeRules } from '../forms/registry.js'
import { todayInGermany } from '../today.js'
import { RequiresPermission } from './authorization.js'
import { DocumentFiles } from './document-files.js'
import {
  collectionBudget,
  type Page,
  photoSourcesOf,
  printPages,
  withPhotosOf,
} from './protocol-photos.js'
import { CurrentIdentity, type RequestIdentity } from './identity.js'
import { pdf, safe } from './pv-documents.controller.js'

/** The invoices that count as proof: what was billed, not a correction or a cancellation. */
const invoiceKinds = ['progress_invoice', 'partial_invoice', 'final_invoice'] as const

/** The photos a page can show. */
const photoTypes = ['image/jpeg', 'image/png', 'image/webp']

function maker(part: { readonly manufacturer: string | null; readonly model: string | null }) {
  const said = [part.manufacturer, part.model].filter(present).join(' ')

  return said === '' ? null : said
}

/** "1 Foto", "3 Fotos". */
function photosText(count: number): string {
  return `${String(count)} ${count === 1 ? 'Foto' : 'Fotos'}`
}

/** What the papers print and what they bind behind the pages. */
interface Gathered {
  readonly papers: FundingPapers
  readonly evidence: readonly FundingEvidence[]
  readonly protocols: readonly (typeof formRecords.$inferSelect)[]
  /** The photos the papers lay in, within the bound of a page (#940). */
  readonly photos: readonly (Omit<FundingPhoto, 'bytes'> & { readonly sha256: string })[]
  /** How many photos among the files of the installation they do not lay in. */
  readonly morePhotos: number
  readonly invoices: readonly DocumentId[]
}

/**
 * The papers of a funding programme for an installation (#307): a PV system,
 * a battery or a wallbox, and a programme for its kind. Not found for anything
 * else, for one that is not there, and for one of another business.
 */
async function gather(
  tx: TenantTransaction,
  tenantId: TenantId,
  installationId: string,
  programId: string,
  on: IsoDate,
): Promise<Gathered> {
  if (!isUuid(installationId) || !isUuid(programId)) {
    throw new NotFoundException()
  }

  const [installation] = await tx
    .select()
    .from(installations)
    .where(
      and(eq(installations.id, installationId as InstallationId), isNull(installations.deletedAt)),
    )
  const [program] = await tx
    .select()
    .from(fundingPrograms)
    .where(eq(fundingPrograms.id, programId as FundingProgramId))

  if (
    !installation ||
    !program ||
    !(fundingKinds as readonly string[]).includes(installation.kind) ||
    !program.kinds.includes(installation.kind)
  ) {
    throw new NotFoundException()
  }

  const [site] = await tx
    .select()
    .from(sites)
    .where(and(eq(sites.id, installation.siteId), isNull(sites.deletedAt)))

  if (!site) {
    throw new NotFoundException()
  }

  const [customer] = await tx.select().from(customers).where(eq(customers.id, site.customerId))
  const [letterhead] = await tx.select().from(letterheads).where(eq(letterheads.tenantId, tenantId))
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
  const companyName = letterhead?.companyName ?? null
  const keeper = {
    name: present(companyName) ? companyName : (tenant?.name ?? ''),
    address: letterhead ? addressLines(letterhead, 'DE').join(', ') : '',
    phone: letterhead?.phone ?? null,
    email: letterhead?.email ?? null,
  }

  // The newest signed protocol of each form that puts the installation into operation.
  const signed = await tx
    .select()
    .from(formRecords)
    .where(
      and(
        eq(formRecords.installationId, installation.id),
        eq(formRecords.status, 'signed'),
        isNull(formRecords.deletedAt),
      ),
    )
    .orderBy(desc(formRecords.performedOn), desc(formRecords.updatedAt), desc(formRecords.id))
  const newestOf = new Map<string, typeof formRecords.$inferSelect>()

  for (const record of signed) {
    const definition = tradeForms.definitionFor(record.definitionKey, record.definitionVersion)

    if (definition?.purpose === 'commissioning' && !newestOf.has(record.definitionKey)) {
      newestOf.set(record.definitionKey, record)
    }
  }

  const protocols = [...newestOf.values()]
  const commissionedOn =
    (protocols[0]?.performedOn as IsoDate | undefined) ??
    (installation.commissionedOn as IsoDate | null)

  // The photos among the files of the installation, each in its newest version.
  const files = await tx
    .select({
      id: attachments.id,
      title: attachments.title,
      fileName: attachmentVersions.fileName,
      mediaType: attachmentVersions.mediaType,
      sha256: attachmentVersions.sha256,
      sizeBytes: attachmentVersions.sizeBytes,
      createdAt: attachmentVersions.createdAt,
    })
    .from(attachments)
    .innerJoin(attachmentVersions, eq(attachmentVersions.attachmentId, attachments.id))
    .where(
      and(
        eq(attachments.installationId, installation.id),
        isNull(attachments.deletedAt),
        isNull(attachmentVersions.deletedAt),
      ),
    )
    .orderBy(desc(attachmentVersions.createdAt), desc(attachmentVersions.id))
  const newestFile = new Map<string, (typeof files)[number]>()

  for (const file of files) {
    if (!newestFile.has(file.id)) {
      newestFile.set(file.id, file)
    }
  }

  const photos = [...newestFile.values()]
    .filter((file) => photoTypes.includes(file.mediaType))
    .map((file) => ({
      title: file.title,
      fileName: file.fileName,
      mediaType: file.mediaType,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      takenOn: file.createdAt.toISOString().slice(0, 10) as IsoDate,
    }))

  // The invoices issued for the installation, or for a job at it.
  const jobsAtIt = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.installationId, installation.id), isNull(jobs.deletedAt)))
  const invoices = await tx
    .select({ id: documents.id, number: documents.number, documentDate: documents.documentDate })
    .from(documents)
    .where(
      and(
        inArray(documents.kind, [...invoiceKinds]),
        eq(documents.status, 'issued'),
        isNull(documents.deletedAt),
        jobsAtIt.length === 0
          ? eq(documents.installationId, installation.id)
          : or(
              eq(documents.installationId, installation.id),
              inArray(
                documents.jobId,
                jobsAtIt.map((job) => job.id),
              ),
            ),
      ),
    )
    .orderBy(documents.documentDate, documents.number)

  // The serial numbers of the installation, and of a PV system's inverters, modules and what belongs to it.
  const serials: FundingSerial[] = []
  const named = (what: string, serialNumber: string | null) => {
    if (present(serialNumber)) {
      serials.push({ what, serialNumber })
    }
  }

  named(
    [installation.designation, maker(installation)].filter(present).join(', '),
    installation.serialNumber,
  )

  if (installation.kind === 'pv_system') {
    const ownInverters = (
      await tx
        .select()
        .from(inverters)
        .where(and(eq(inverters.installationId, installation.id), isNull(inverters.deletedAt)))
    ).sort(inStructureOrder)

    for (const inverter of ownInverters) {
      named(
        [inverter.designation, maker(inverter)].filter(present).join(', '),
        inverter.serialNumber,
      )
    }

    const strings =
      ownInverters.length === 0
        ? []
        : (
            await tx
              .select()
              .from(pvStrings)
              .where(
                and(
                  inArray(
                    pvStrings.inverterId,
                    ownInverters.map((inverter) => inverter.id),
                  ),
                  isNull(pvStrings.deletedAt),
                ),
              )
          ).sort(inStructureOrder)

    for (const pvString of strings) {
      const modules = (
        await tx
          .select()
          .from(pvModules)
          .where(and(eq(pvModules.pvStringId, pvString.id), isNull(pvModules.deletedAt)))
      ).sort((left, right) => left.position - right.position)

      modules.forEach((module, index) => {
        named(
          [`Modul ${String(index + 1)} in ${pvString.designation}`, maker(module)]
            .filter(present)
            .join(', '),
          module.serialNumber,
        )
      })
    }

    const companions = (
      await tx
        .select()
        .from(installations)
        .where(and(eq(installations.pvSystemId, installation.id), isNull(installations.deletedAt)))
    ).sort((left, right) => left.designation.localeCompare(right.designation, 'de'))

    for (const companion of companions) {
      named(
        [companion.designation, maker(companion)].filter(present).join(', '),
        companion.serialNumber,
      )
    }
  }

  const site_ = [site.designation, addressLines(site, 'DE').join(', ')].filter(present).join(', ')
  const declaration =
    program.evidence.some((entry) => entry.source === 'declaration') && present(program.declaration)
      ? filledDeclaration(program.declaration, {
          betreiber: customer?.name ?? null,
          objekt: site_,
          anlage: [installation.designation, maker(installation)].filter(present).join(', '),
          seriennummer: installation.serialNumber,
          leistung:
            installation.ratedPowerW === null ? null : kilowattText(installation.ratedPowerW),
          kapazität:
            installation.usableCapacityWh === null
              ? null
              : kilowattHourText(installation.usableCapacityWh),
          inbetriebnahme: commissionedOn === null ? null : day(commissionedOn),
          betrieb: keeper.name,
          datum: day(on),
        })
      : null

  const unlisted: FundingPapers = {
    program: { name: program.name, sponsor: program.sponsor, url: program.url },
    keeper,
    customer: {
      name: customer?.name ?? '',
      address: customer ? addressLines(customer, 'DE').join(', ') : '',
    },
    site: { designation: site.designation, address: addressLines(site, 'DE').join(', ') },
    installation: {
      kind: installation.kind,
      designation: installation.designation,
      maker: maker(installation),
      serialNumber: installation.serialNumber,
      ratingW: installation.ratedPowerW,
      capacityWh: installation.usableCapacityWh,
      commissionedOn,
    },
    lines: [],
    declaration,
    serials,
  }
  // The page of photos without them, as the renderer gets it, tells what
  // is left (#940): the photos are laid in in order, within the bound.
  const pageBytes = Buffer.byteLength(JSON.stringify(photosJob(unlisted, [], on, 0)))
  const enclosed = withinBound(
    photos,
    // Its title, twice, and file name go into the page with it.
    (photo) =>
      photo.sizeBytes + printedTextBytes(photo.title, photo.title, photo.fileName, photo.mediaType),
    photoBound(pageBytes),
  )
  const checklist = fundingChecklist(program.evidence, {
    invoices: invoices.length,
    commissioning: protocols.length,
    photos: enclosed.length,
    serialNumbers: serials.length,
    declaration: present(program.declaration),
  })
  const lines: FundingLine[] = checklist.map((entry) => {
    if (entry.state === 'operator') {
      return { ...entry, said: null }
    }

    const said = enclosedSaid[entry.source as Exclude<typeof entry.source, 'operator'>]

    if (entry.state === 'missing') {
      // Photos there are, but none fits into the papers.
      return {
        ...entry,
        said:
          entry.source === 'photos' && photos.length > 0
            ? `${photosText(photos.length)} unter den Dateien der Anlage, zu groß zum Beilegen`
            : said.missing,
      }
    }

    switch (entry.source) {
      case 'invoice':
        return {
          ...entry,
          said: invoices
            .map((invoice) => `${invoice.number ?? ''} vom ${day(invoice.documentDate as IsoDate)}`)
            .join(', '),
        }
      case 'commissioning':
        return {
          ...entry,
          said: protocols
            .map((record) => `unterschrieben am ${day(record.performedOn as IsoDate)}`)
            .join(', '),
        }
      case 'photos':
        return {
          ...entry,
          said:
            enclosed.length === photos.length
              ? `${photosText(photos.length)} unter den Dateien der Anlage`
              : `${String(enclosed.length)} von ${photosText(photos.length)} unter den Dateien der Anlage, die übrigen liegen dort`,
        }
      default:
        return { ...entry, said: said.enclosed }
    }
  })
  return {
    evidence: program.evidence,
    protocols,
    photos: enclosed,
    morePhotos: photos.length - enclosed.length,
    invoices: invoices.map((invoice) => invoice.id),
    papers: { ...unlisted, lines },
  }
}

/**
 * The papers of a funding programme at an installation (#307), as one PDF:
 * the list of proofs first, then what OpenGewerk lays in, in the order the
 * list says. With the right to the programmes, which the owner and the office
 * have: the papers lay in invoices.
 */
@Controller('installations/:installationId/funding')
export class FundingPapersController {
  constructor(
    private readonly database: Database,
    private readonly files: DocumentFiles,
    @Inject(RENDERER) private readonly render: Renderer,
  ) {}

  @Get(':programId')
  @RequiresPermission('funding_program.read')
  async papers(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('installationId') installationId: string,
    @Param('programId') programId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const on = todayInGermany()
    const gathered = await this.database.forTenant(identity, (tx) =>
      gather(tx, identity.tenantId, installationId, programId, on),
    )
    const { papers, evidence } = gathered
    const asks = (source: FundingEvidence['source']) =>
      evidence.some((entry) => entry.source === source)
    const jobs: Page[] = [fundingCoverJob(papers, on)]

    if (asks('declaration') && papers.declaration !== null) {
      jobs.push(declarationJob(papers, papers.declaration, on))
    }

    if (asks('serial_numbers') && papers.serials.length > 0) {
      jobs.push(serialNumbersJob(papers, on))
    }

    if (asks('commissioning')) {
      // Each protocol as it prints on its own, its photos included (#935).
      const budget = collectionBudget()
      const sources = await photoSourcesOf(this.database, identity, gathered.protocols)

      for (const record of gathered.protocols) {
        const definition = tradeForms.definitionFor(record.definitionKey, record.definitionVersion)

        if (definition) {
          jobs.push(async () =>
            protocolPrintJob(
              await withPhotosOf(
                this.files,
                {
                  definition,
                  values: readFormValues(record.values) ?? {},
                  performedOn: record.performedOn as IsoDate,
                  status: 'signed',
                  keeper: { name: papers.keeper.name, phone: papers.keeper.phone },
                  installation: papers.installation.designation,
                  appliance: null,
                  site: [papers.site.designation, papers.site.address].filter(present).join(', '),
                  rules: tradeRules,
                },
                sources.get(record.id),
                budget,
              ),
            ),
          )
        }
      }
    }

    // The page of photos keeps its own bound, chosen with the cover that
    // names them (#940), and reads them only when it is printed (#935).
    if (asks('photos') && gathered.photos.length > 0) {
      jobs.push(async () => {
        const photos: FundingPhoto[] = []

        for (const photo of gathered.photos) {
          photos.push({ ...photo, bytes: await this.files.read(photo.sha256) })
        }

        return photosJob(papers, photos, on, gathered.morePhotos)
      })
    }

    const parts = await this.printed(identity, jobs)

    // Behind the pages the invoices, as each went to the customer.
    if (asks('invoice')) {
      for (const invoice of gathered.invoices) {
        parts.push((await this.files.issued(identity, invoice, 'pdf')).bytes)
      }
    }

    return pdf(
      response,
      parts.length === 1 && parts[0] ? parts[0] : await bound(parts, 'Förderunterlagen'),
      `Förderunterlagen ${safe(papers.program.name)} ${safe(papers.installation.designation)}`,
    )
  }

  /** The pages one after another: the renderer of an instance is a single browser. */
  private printed(identity: RequestIdentity, jobs: readonly Page[]): Promise<Uint8Array[]> {
    return printPages(this.render, identity, jobs)
  }
}
