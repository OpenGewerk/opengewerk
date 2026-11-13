import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common'
import { Database, isUuid, RENDERER, type Renderer } from '@opengewerk/platform-server'
import type { Response } from 'express'

import { bound, type InspectionReport, inspectionReportJob } from '../forms/inspection-report.js'
import { protocolPrintJob } from '../forms/protocol-print.js'
import { tradeRules } from '../forms/registry.js'
import { RequiresPermission } from './authorization.js'
import { DocumentFiles } from './document-files.js'
import { CurrentIdentity, type RequestIdentity } from './identity.js'
import {
  collectionBudget,
  type Page,
  photoSourcesOf,
  printPages,
  rendererFault,
  withPhotosOf,
} from './protocol-photos.js'
import { reportedAppliances, reportedInstallations, siteHead } from './site-reports.js'

/**
 * The test of the electrical installation of a site (#302), as one PDF: the
 * report with the result of the whole and a line for each installation and
 * appliance, then the last protocol of each installation as it prints on its
 * own. Under the right of the installations, like the protocols it is made
 * of, and printed on every request, kept nowhere.
 */
@Controller('sites/:siteId/inspection-report')
export class InspectionReportController {
  constructor(
    private readonly database: Database,
    private readonly files: DocumentFiles,
    @Inject(RENDERER) private readonly render: Renderer,
  ) {}

  @Get()
  @RequiresPermission('installation.read')
  async print(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('siteId') siteId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!isUuid(siteId)) {
      throw new NotFoundException()
    }

    const report = await this.database.forTenant(
      identity,
      async (tx): Promise<InspectionReport> => {
        const head = await siteHead(tx, identity.tenantId, siteId)

        if (!head) {
          throw new NotFoundException()
        }

        return {
          ...head,
          installations: await reportedInstallations(tx, siteId),
          appliances: await reportedAppliances(tx, siteId),
        }
      },
    )
    const name = `Prüfung der Elektroinstallation ${report.site} ${report.on}`.replaceAll(
      /[/:*?"<>|]+/g,
      '-',
    )

    // Each protocol as it prints on its own, its photos included (#935).
    const sources = await photoSourcesOf(
      this.database,
      identity,
      report.installations.flatMap((entry) => (entry.last?.record ? [entry.last.record] : [])),
    )
    const budget = collectionBudget()
    // Each protocol's page is built when it is printed (#935).
    const pages: Page[] = [
      inspectionReportJob(report),
      ...report.installations.flatMap((entry) => {
        if (!entry.last) {
          return []
        }

        const { record, ...last } = entry.last

        return [
          async () =>
            protocolPrintJob(
              await withPhotosOf(
                this.files,
                {
                  ...last,
                  status: 'signed',
                  keeper: report.keeper,
                  installation: entry.designation,
                  appliance: null,
                  site: report.site,
                  rules: tradeRules,
                },
                record ? sources.get(record.id) : undefined,
                budget,
              ),
            ),
        ]
      }),
    ]
    const parts = await printPages(this.render, identity, pages)
    let bytes: Uint8Array

    try {
      bytes = await bound(parts, name)
    } catch (error) {
      throw rendererFault(error)
    }

    response.setHeader('Cache-Control', 'no-store')

    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="Pruefung.pdf"; filename*=UTF-8''${encodeURIComponent(`${name}.pdf`)}`,
      length: bytes.byteLength,
    })
  }
}
