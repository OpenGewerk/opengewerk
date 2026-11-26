import { UnprocessableEntityException } from '@nestjs/common'
import {
  type BilledPeriod,
  type ContractRateDay,
  type CustomerId,
  type IsoDate,
  lastServiceDay,
  type LineKind,
  type LineUnit,
  type MaintenanceContractId,
  nextPeriod,
  type PaymentRhythm,
  periodText,
  type PriceBase,
  priceUnitLabel,
  type RenewalKind,
  supplyDayOf,
  type TaxTreatment,
  type VatRate,
} from '@opengewerk/domain'
import { newId, type TenantTransaction } from '@opengewerk/platform-server'
import { and, eq, isNull } from 'drizzle-orm'

import { contentForIssuing, issueWith } from '../api/documents.controller.js'
import { documentLines, documents, maintenanceContracts } from '../database/schema/index.js'
import type { DeadlineRow } from '../deadlines/engine.js'
import { proposedTreatment } from '../documents/treatment.js'

type ContractRow = typeof maintenanceContracts.$inferSelect

type DocumentRow = typeof documents.$inferSelect

/**
 * A line of a recurring invoice as it is written. Laid out again after a
 * cancellation, a line keeps its article and the mark of the surcharge of an
 * emergency call (#1037), as a document made from another one does.
 */
export interface PeriodLine {
  readonly kind: LineKind
  readonly position: number
  readonly designation: string
  readonly description: string | null
  readonly quantityMilli: number
  readonly unit: LineUnit
  readonly unitPriceCents: number
  readonly priceBase: PriceBase
  readonly vatRate: VatRate
  readonly netCents: number
  readonly articleId: (typeof documentLines.$inferSelect)['articleId']
  readonly emergencySurcharge: boolean
}

/**
 * The one line that carries the flat price, as the deadline writes it, or
 * null where there is none or more than one. Asked of an invoice laid out
 * before it named that line (`takenOver`), when its period is laid out again.
 */
export function flatLineOf<Line extends Pick<PeriodLine, 'kind' | 'unit'>>(
  lines: readonly Line[],
): Line | null {
  const flat = lines.filter((line) => line.unit === 'flat_rate' && line.kind === 'item')

  return flat.length === 1 ? (flat[0] ?? null) : null
}

/**
 * What a recurring invoice takes from its contract and its customer when it
 * is made (#1037): how it is taxed, the day of the maintenance its period
 * pays for where the contract wants the rate of that day, and the flat price.
 * A draft that holds other values than these was made before a change; the
 * office hears of it and takes them over.
 *
 * Taxed as of the day of the supply, the day its rate is of as well: the
 * maintenance where the contract names it, so that one of a time the
 * business claimed section 19 for stays without VAT when it is billed after,
 * and otherwise the end of the period, when a running service is done. Until
 * #1037 it was the first day of the period.
 */
export async function periodValues(
  tx: TenantTransaction,
  contract: ContractRow,
  period: Pick<BilledPeriod, 'from' | 'until'>,
): Promise<{
  readonly taxTreatment: TaxTreatment
  readonly supplyOn: IsoDate | null
  readonly flatCents: number | null
}> {
  const supplyOn = supplyDayOf(
    {
      rateDay: contract.rateDay as ContractRateDay,
      firstVisitOn: contract.firstVisitOn as IsoDate,
      intervalMonths: contract.intervalMonths,
    },
    period,
  )

  return {
    taxTreatment: await proposedTreatment(
      tx,
      contract.customerId as CustomerId,
      supplyOn ?? period.until,
    ),
    supplyOn,
    flatCents: contract.flatCents,
  }
}

/** The one line of a recurring invoice: the flat price of the period. */
export function flatLine(
  contract: ContractRow,
  period: Pick<BilledPeriod, 'from' | 'until'>,
  flatCents: number | null,
): PeriodLine {
  const rhythm = contract.paymentRhythm as PaymentRhythm

  return {
    kind: 'item',
    position: 1,
    designation: contract.designation,
    description: `Pauschale ${priceUnitLabel[rhythm]} nach dem Wartungsvertrag ${contract.number}, Leistungszeitraum ${periodText(period)}.`,
    quantityMilli: 1000,
    unit: 'flat_rate',
    unitPriceCents: flatCents ?? 0,
    priceBase: 1,
    vatRate: 'standard',
    netCents: flatCents ?? 0,
    articleId: null,
    emergencySurcharge: false,
  }
}

/** Lines handed to a period laid out again, and which of them carries the flat price. */
export interface HandedLines {
  readonly lines: readonly PeriodLine[]
  /** Where in `lines` the line of the flat price stands, or null for none. */
  readonly flatAt: number | null
}

/**
 * The draft of the recurring invoice of a period, with the values of its
 * contract and customer of today (`periodValues`), and with the flat price as
 * its one line unless it is handed the lines to take (#1037): laying a
 * period out again after a cancellation keeps what the invoice billed. It
 * notes what it took (`takenOver`): the line of the flat price by its id and
 * the price that line has, so that a later change of the contract is told
 * from one made in the draft.
 */
export async function layOutPeriod(
  tx: TenantTransaction,
  contract: ContractRow,
  period: Pick<BilledPeriod, 'from' | 'until'>,
  today: IsoDate,
  handed?: HandedLines,
  // Who lays it out, for a draft the office makes; nobody for the deadline's.
  createdBy: string | null = null,
): Promise<DocumentRow> {
  const values = await periodValues(tx, contract, period)
  const written = handed?.lines ?? [flatLine(contract, period, values.flatCents)]
  const flatAt = handed ? handed.flatAt : 0
  const ids = written.map(() => newId<'document-line'>())
  const flat = flatAt === null ? undefined : written[flatAt]
  const [created] = await tx
    .insert(documents)
    .values({
      tenantId: contract.tenantId,
      customerId: contract.customerId,
      siteId: contract.siteId,
      kind: 'recurring_invoice',
      documentDate: today,
      subject: `${contract.designation}, ${periodText(period)}`,
      serviceFrom: period.from,
      serviceUntil: period.until,
      supplyOn: values.supplyOn,
      maintenanceContractId: contract.id,
      taxTreatment: values.taxTreatment,
      takenOver: {
        flatLineId: flat && flatAt !== null ? (ids[flatAt] ?? null) : null,
        flatCents: flat?.unitPriceCents ?? null,
        taxTreatment: values.taxTreatment,
      },
      createdBy,
    })
    .returning()

  if (!created) {
    throw new Error('The recurring invoice was written and is not readable afterwards.')
  }

  if (written.length > 0) {
    await tx.insert(documentLines).values(
      written.map((line, index) => ({
        ...line,
        id: ids[index],
        tenantId: contract.tenantId,
        documentId: created.id,
      })),
    )
  }

  return created
}

/**
 * The invoice of a period of a maintenance contract paid per period (#295),
 * made when the deadline "Rechnung eines Wartungsvertrags" falls due on the
 * first day of the period: a recurring invoice with the period as the time of
 * service and the flat price as its one line. Dated on the day it is made,
 * which is the day of its issue where it is issued by itself (section 14 (4)
 * sentence 1 no. 3 UStG), also when a lead on the deadline makes it before
 * its period: the period of service says what it is for. One that waits as a
 * draft is dated anew when the office issues it (#1039). Until #1017 it was
 * dated on the first day of its period, also when it was made later, after a
 * time the instance was down, and until #1039 when it was made earlier,
 * because the rules taxed a document by its date; they tax by the day of the
 * work now, and the period of service carries that.
 *
 * The first invoice of a contract waits as a draft, so that somebody looks at
 * it once. After it, a contract that wants it has each one issued at once,
 * by nobody, and the notifications send it to the customer. A period cut
 * short by the end of the contract stays a draft: only the office knows what
 * that part costs. So does an invoice that still lacks something to be
 * issued; the office sees what on its screen.
 *
 * Once per contract and start of a period: the key on the documents holds
 * that, and the deadline moves on to the next period once this one exists.
 */
export async function contractInvoice(
  tx: TenantTransaction,
  deadline: DeadlineRow,
  today: IsoDate,
  now: Date = new Date(),
): Promise<void> {
  const [contract] = await tx
    .select()
    .from(maintenanceContracts)
    .where(eq(maintenanceContracts.id, String(deadline.sourceId) as MaintenanceContractId))

  if (!contract || contract.priceKind !== 'flat' || contract.flatCents === null) {
    return
  }

  const terms = {
    startsOn: contract.startsOn as IsoDate,
    termMonths: contract.termMonths,
    renewal: contract.renewal as RenewalKind,
    renewalMonths: contract.renewalMonths,
    noticeMonths: contract.noticeMonths,
    endsOn: contract.endsOn as IsoDate | null,
  }
  const rhythm = contract.paymentRhythm as PaymentRhythm
  const period = nextPeriod(
    { startsOn: terms.startsOn, paymentRhythm: rhythm },
    { lastBilledFrom: null, notBefore: deadline.dueOn as IsoDate, lastDay: lastServiceDay(terms) },
  )

  if (period === null || period.from !== deadline.dueOn) {
    return
  }

  const made = await tx
    .select({ serviceFrom: documents.serviceFrom })
    .from(documents)
    .where(eq(documents.maintenanceContractId, contract.id))

  if (made.some((row) => row.serviceFrom === period.from)) {
    return
  }

  const created = await layOutPeriod(tx, contract, period, today)

  if (made.length === 0 || !contract.issueByItself || period.cut) {
    return
  }

  const [locked] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, created.id), isNull(documents.deletedAt)))
    .for('update')

  if (!locked) {
    return
  }

  let ready: Awaited<ReturnType<typeof contentForIssuing>>

  try {
    ready = await contentForIssuing(tx, locked)
  } catch (error) {
    // A rule with nothing for the day: the invoice waits as a draft, where the
    // office reads the sentence when it issues it.
    if (error instanceof UnprocessableEntityException) {
      return
    }

    throw error
  }

  if (ready.missing.length === 0) {
    await issueWith(tx, { tenantId: locked.tenantId, userId: null }, locked, ready.content, now)
  }
}
