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

import { flatLineOf, type PeriodLine, layOutPeriod, periodValues } from '../contracts/recurring.js'
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

/**
 * The line that carries the flat price of the contract, as the invoice named
 * it when it took it (#1037), or null where it named none or the office has
 * taken the line away. A flat line the office adds is never it.
 */
function takenFlatLine(document: DocumentRow, lines: readonly LineRow[]): LineRow | null {
  const id = document.takenOver?.flatLineId ?? null

  return id === null ? null : (lines.find((line) => line.id === id) ?? null)
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

/**
 * The values of a draft that its contract and customer have otherwise today,
 * of those it still holds as it took them (`takenOver`). A value the office
 * changed in the draft is the office's, and nothing offers to undo it. Of a
 * draft laid out before the field, what it took is not known, and it hears
 * only of the day of the maintenance, which the server alone writes.
 */
async function draftChanges(
  tx: TenantTransaction,
  document: DocumentRow,
  contract: ContractRow,
  lines: readonly LineRow[],
): Promise<RecurringChange[]> {
  const taken = document.takenOver

  if (document.serviceFrom === null || document.serviceUntil === null) {
    return []
  }

  const values = await periodValues(
    tx,
    contract,
    { from: document.serviceFrom as IsoDate, until: document.serviceUntil as IsoDate },
    document.customerId,
  )
  const changes: RecurringChange[] = []
  const flat = takenFlatLine(document, lines)

  if (
    flat !== null &&
    taken !== null &&
    flat.unitPriceCents === taken.flatCents &&
    values.flatCents !== null &&
    flat.unitPriceCents !== values.flatCents &&
    isFullPeriod(contract, document)
  ) {
    changes.push({ field: 'flatCents', was: flat.unitPriceCents, now: values.flatCents })
  }

  if (
    taken !== null &&
    document.taxTreatment === taken.taxTreatment &&
    document.taxTreatment !== values.taxTreatment
  ) {
    changes.push({ field: 'taxTreatment', was: document.taxTreatment, now: values.taxTreatment })
  }

  const supplyOn = (document.supplyOn as IsoDate | null) ?? null

  if (supplyOn !== values.supplyOn) {
    changes.push({ field: 'supplyOn', was: supplyOn, now: values.supplyOn })
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

      if (changes.length === 0) {
        return { applied: [] }
      }

      // What it takes now is what it took, for the next change to be told
      // from one the office makes after. A draft without it hears only of
      // the day, which is not in it.
      const set: Partial<typeof documents.$inferInsert> = {}
      let takenOver = document.takenOver

      for (const change of changes) {
        if (change.field === 'taxTreatment') {
          set.taxTreatment = change.now as DocumentRow['taxTreatment']
          takenOver = takenOver && { ...takenOver, taxTreatment: change.now }
        } else if (change.field === 'supplyOn') {
          set.supplyOn = change.now
        } else if (change.field === 'flatCents') {
          const flat = takenFlatLine(document, lines)

          if (flat !== null && change.now !== null) {
            takenOver = takenOver && { ...takenOver, flatCents: change.now }

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

      await tx
        .update(documents)
        .set({ ...set, takenOver })
        .where(eq(documents.id, document.id))

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

      const old = await linesOf(tx, document.id)
      // The line of the flat price as the invoice named it; one laid out
      // before it named any has its one flat line for it.
      const flatId =
        document.takenOver !== null ? document.takenOver.flatLineId : (flatLineOf(old)?.id ?? null)
      const flatAt = old.findIndex((line) => line.id === flatId)
      const lines: PeriodLine[] = old.map((line) => ({
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
        articleId: line.articleId,
        emergencySurcharge: line.emergencySurcharge,
      }))
      // Its own checks: issued and nothing that builds on it or came in on it.
      const cancellation = await cancelInvoice(tx, identity, document.id)
      const renewed = await layOutPeriod(
        tx,
        contract,
        { from: document.serviceFrom as IsoDate, until: document.serviceUntil as IsoDate },
        todayInGermany(),
        {
          lines,
          flatAt: flatAt === -1 ? null : flatAt,
          customerId: document.customerId,
          siteId: document.siteId,
        },
        identity.userId,
      )

      return { cancellation, renewed }
    })
  }
}
