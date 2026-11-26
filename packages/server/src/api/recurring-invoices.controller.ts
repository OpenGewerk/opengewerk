import { ConflictException, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common'
import {
  type DocumentId,
  type IsoDate,
  lastServiceDay,
  lineNetCents,
  type MaintenanceContractId,
  nextPeriod,
  type PaymentRhythm,
  type RecurringChange,
  type RenewalKind,
  RuleError,
  shippedRules,
  totalsFor,
} from '@opengewerk/domain'
import { Database, type TenantTransaction } from '@opengewerk/platform-server'
import { and, asc, eq, isNull } from 'drizzle-orm'

import { type PeriodLine, layOutPeriod, periodValues } from '../contracts/recurring.js'
import { documentLines, documents, maintenanceContracts } from '../database/schema/index.js'
import { todayInGermany } from '../today.js'
import { RequiresPermission } from './authorization.js'
import { cancelInvoice } from './documents.controller.js'
import { CurrentIdentity, type RequestIdentity } from './identity.js'

type DocumentRow = typeof documents.$inferSelect
type ContractRow = typeof maintenanceContracts.$inferSelect
type LineRow = typeof documentLines.$inferSelect

/**
 * Whether a period is a full one of its contract: the price of a period cut
 * short by the end of the contract is the office's, and no flat price of the
 * contract is the price of it.
 */
function isFullPeriod(contract: ContractRow, document: DocumentRow): boolean {
  if (document.serviceFrom === null || document.serviceUntil === null) {
    return false
  }

  const period = nextPeriod(
    {
      startsOn: contract.startsOn as IsoDate,
      paymentRhythm: contract.paymentRhythm as PaymentRhythm,
    },
    {
      lastBilledFrom: null,
      notBefore: document.serviceFrom as IsoDate,
      lastDay: lastServiceDay({
        startsOn: contract.startsOn as IsoDate,
        termMonths: contract.termMonths,
        renewal: contract.renewal as RenewalKind,
        renewalMonths: contract.renewalMonths,
        noticeMonths: contract.noticeMonths,
        endsOn: contract.endsOn as IsoDate | null,
      }),
    },
  )

  return (
    period !== null &&
    !period.cut &&
    period.from === document.serviceFrom &&
    period.until === document.serviceUntil
  )
}

/** The one line that carries the flat price, as the deadline wrote it. */
function flatLineOf(lines: readonly LineRow[]): LineRow | null {
  const flat = lines.filter((line) => line.unit === 'flat_rate' && line.kind === 'item')

  return flat.length === 1 ? (flat[0] ?? null) : null
}

async function linesOf(tx: TenantTransaction, documentId: DocumentId): Promise<LineRow[]> {
  return tx
    .select()
    .from(documentLines)
    .where(and(eq(documentLines.documentId, documentId), isNull(documentLines.deletedAt)))
    .orderBy(asc(documentLines.position), asc(documentLines.id))
}

async function contractOf(
  tx: TenantTransaction,
  document: DocumentRow,
): Promise<ContractRow | null> {
  if (document.maintenanceContractId === null) {
    return null
  }

  const [contract] = await tx
    .select()
    .from(maintenanceContracts)
    .where(eq(maintenanceContracts.id, document.maintenanceContractId as MaintenanceContractId))

  return contract ?? null
}

/** The values of a draft that differ from those of its contract and customer today. */
async function draftChanges(
  tx: TenantTransaction,
  document: DocumentRow,
  contract: ContractRow,
  lines: readonly LineRow[],
): Promise<RecurringChange[]> {
  if (document.serviceFrom === null || document.serviceUntil === null) {
    return []
  }

  const values = await periodValues(tx, contract, {
    from: document.serviceFrom as IsoDate,
    until: document.serviceUntil as IsoDate,
  })
  const changes: RecurringChange[] = []
  const flat = flatLineOf(lines)

  if (
    flat !== null &&
    values.flatCents !== null &&
    flat.unitPriceCents !== values.flatCents &&
    isFullPeriod(contract, document)
  ) {
    changes.push({ field: 'flatCents', was: flat.unitPriceCents, now: values.flatCents })
  }

  if (document.taxTreatment !== values.taxTreatment) {
    changes.push({ field: 'taxTreatment', was: document.taxTreatment, now: values.taxTreatment })
  }

  if ((document.supplyOn ?? null) !== values.supplyOn) {
    changes.push({
      field: 'supplyOn',
      was: (document.supplyOn as IsoDate | null) ?? null,
      now: values.supplyOn,
    })
  }

  return changes
}

/**
 * The rates an issued invoice stated that the running version knows
 * otherwise for its day of supply. Read from what it froze (#1035) against
 * the totals of its lines by today's rules; a day the rules do not cover
 * says nothing either way.
 */
function issuedChanges(document: DocumentRow, lines: readonly LineRow[]): RecurringChange[] {
  const frozen = document.issuedTotals

  if (frozen === null) {
    return []
  }

  let now: ReturnType<typeof totalsFor>

  try {
    now = totalsFor(shippedRules, lines, {
      documentDate: document.documentDate as IsoDate,
      serviceFrom: document.serviceFrom as IsoDate | null,
      serviceUntil: document.serviceUntil as IsoDate | null,
      supplyOn: document.supplyOn as IsoDate | null,
      taxTreatment: document.taxTreatment,
    })
  } catch (error) {
    if (error instanceof RuleError) {
      return []
    }

    throw error
  }

  const supplyOn = (document.supplyOn ??
    document.serviceUntil ??
    document.serviceFrom ??
    document.documentDate) as IsoDate

  return frozen.byRate.flatMap((stated): RecurringChange[] => {
    const today = now.byRate.find((entry) => entry.rate === stated.rate)

    return today !== undefined && today.basisPoints !== stated.basisPoints
      ? [
          {
            field: 'rate',
            rate: stated.rate,
            supplyOn,
            was: stated.basisPoints,
            now: today.basisPoints,
          },
        ]
      : []
  })
}

async function recurringDocument(
  tx: TenantTransaction,
  documentId: string,
  lock: boolean,
): Promise<DocumentRow> {
  const query = tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId as DocumentId), isNull(documents.deletedAt)))
  const [document] = lock ? await query.for('update') : await query

  if (!document) {
    throw new NotFoundException()
  }

  return document
}

/**
 * What has changed for a recurring invoice since it was made, and the two
 * ways to act on it (#1037, Feature-Gliederung 3.5). A draft takes over the
 * values its contract and customer have today; an issued invoice stays as it
 * is, and laying its period out again cancels it and makes a new draft with
 * the same lines and today's values, which the office issues.
 */
@Controller('documents/:documentId')
export class RecurringInvoicesController {
  constructor(private readonly database: Database) {}

  @Get('recurring-check')
  @RequiresPermission('document.read')
  check(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly changes: RecurringChange[] }> {
    return this.database.forTenant(identity, async (tx) => {
      const document = await recurringDocument(tx, documentId, false)

      if (document.kind !== 'recurring_invoice') {
        return { changes: [] }
      }

      const lines = await linesOf(tx, document.id)

      if (document.status === 'issued') {
        return { changes: issuedChanges(document, lines) }
      }

      const contract = await contractOf(tx, document)

      return {
        changes:
          document.status === 'draft' && contract !== null
            ? await draftChanges(tx, document, contract, lines)
            : [],
      }
    })
  }

  /** Takes over the values of today into a draft: nothing else of it changes. */
  @Post('recurring-refresh')
  @RequiresPermission('document.write')
  refresh(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly applied: RecurringChange[] }> {
    return this.database.forTenant(identity, async (tx) => {
      // Locked, so that the values are taken over into the draft as it is
      // and not beside a change that is being written to it.
      const document = await recurringDocument(tx, documentId, true)

      if (document.kind !== 'recurring_invoice' || document.status !== 'draft') {
        throw new ConflictException('Neue Werte übernimmt nur eine Dauerrechnung im Entwurf.')
      }

      const contract = await contractOf(tx, document)

      if (contract === null) {
        throw new ConflictException('Diese Dauerrechnung gehört zu keinem Wartungsvertrag mehr.')
      }

      const lines = await linesOf(tx, document.id)
      const changes = await draftChanges(tx, document, contract, lines)

      for (const change of changes) {
        if (change.field === 'taxTreatment') {
          await tx
            .update(documents)
            .set({ taxTreatment: change.now as DocumentRow['taxTreatment'] })
            .where(eq(documents.id, document.id))
        } else if (change.field === 'supplyOn') {
          await tx
            .update(documents)
            .set({ supplyOn: change.now })
            .where(eq(documents.id, document.id))
        } else if (change.field === 'flatCents') {
          const flat = flatLineOf(lines)

          if (flat !== null && change.now !== null) {
            await tx
              .update(documentLines)
              .set({
                unitPriceCents: change.now,
                netCents: lineNetCents({
                  quantityMilli: flat.quantityMilli,
                  unitPriceCents: change.now,
                  priceBase: flat.priceBase,
                }),
              })
              .where(eq(documentLines.id, flat.id))
          }
        }
      }

      return { applied: changes }
    })
  }

  /**
   * Cancels an issued recurring invoice and lays its period out again as a
   * draft with the same lines and today's values. One step, so that the
   * period is never left without an invoice in between.
   */
  @Post('renewal')
  @RequiresPermission('document.issue')
  renewal(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly cancellation: DocumentRow; readonly renewed: DocumentRow }> {
    return this.database.forTenant(identity, async (tx) => {
      const document = await recurringDocument(tx, documentId, true)

      if (document.kind !== 'recurring_invoice') {
        throw new ConflictException('Neu angelegt wird nur eine Dauerrechnung.')
      }

      const contract = await contractOf(tx, document)

      if (contract === null || document.serviceFrom === null || document.serviceUntil === null) {
        throw new ConflictException('Diese Dauerrechnung gehört zu keinem Wartungsvertrag mehr.')
      }

      const lines: PeriodLine[] = (await linesOf(tx, document.id)).map((line) => ({
        kind: line.kind,
        position: line.position,
        designation: line.designation,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        priceBase: line.priceBase,
        vatRate: line.vatRate,
        netCents: line.netCents,
      }))
      // Its own checks: issued and nothing that builds on it or came in on it.
      const cancellation = await cancelInvoice(tx, identity, document.id)
      const renewed = await layOutPeriod(
        tx,
        contract,
        { from: document.serviceFrom as IsoDate, until: document.serviceUntil as IsoDate },
        todayInGermany(),
        lines,
        identity.userId,
      )

      return { cancellation, renewed }
    })
  }
}
