import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Delete,
  ForbiddenException,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common'
import {
  cancellationOf,
  closesProgressInvoices,
  continuesChain,
  declinedOfferRefusal,
  currentContent,
  type CustomerId,
  type DeductionContent,
  defaultPatterns,
  type DocumentContent,
  type DocumentId,
  type DocumentKind,
  documentKinds,
  type DocumentStatus,
  documentTextProblem,
  type EInvoiceGap,
  type InstructionGap,
  isAllowed,
  isCancellable,
  isInvoice,
  type IsoDate,
  lineLimits,
  type MissingDetail,
  missingDetails,
  noInstructionChoices,
  numberFromPattern,
  numberRangeOf,
  paymentTermProblem,
  RuleError,
  shippedRules,
  repricedFrom,
  successorsOf,
  type TaxTreatment,
  whyFixed,
  mayDeleteDraft,
  notOwnDraft,
} from '@opengewerk/domain'
import {
  Database,
  pick,
  requireFields,
  requireSomething,
  type TenantTransaction,
} from '@opengewerk/platform-server'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { assignDocumentNumber } from '../database/number-ranges.js'
import {
  documentInstructionChoices,
  documentLines,
  documents,
  offerDeclines,
  documentSnapshots,
  documentSources,
  numberRanges,
  payments,
} from '../database/schema/index.js'
import { articlePricesOn, type PriceOfDay, pricedFromArticle } from '../documents/article-prices.js'
import { contentAndGapsOf, issuerOf, withStoredLogo } from '../documents/content.js'
import { contractFlatLineFor } from '../contracts/invoice.js'
import { followPeriod } from '../contracts/period-day.js'
import {
  followCall,
  refreshSurchargeLine,
  surchargeTermsOfDocument,
} from '../service-calls/on-call.js'
import { deductionsFor, paymentsOfADraft, showsReceivedPayments } from '../documents/deductions.js'
import { choicesOf } from '../documents/instructions.js'
import { proposedTreatment } from '../documents/treatment.js'
import { documentTitle } from '../documents/template.js'
import { RequiresPermission } from './authorization.js'
import { requireReferences } from './references.js'
import { eInvoiceRefusals } from './e-invoice.controller.js'
import { CurrentIdentity, type RequestIdentity } from './identity.js'
import { todayInGermany, yearInGermany } from '../today.js'

/** What stands between a draft and its number, whatever the list it comes from. */
type Missing = MissingDetail | EInvoiceGap | InstructionGap

/**
 * What a document says, put together for issuing, and what it still lacks.
 *
 * A date the rules have nothing for is the one way this can fail on input
 * rather than on a bug: a document dated 2005 has no VAT rate and no limit
 * for a small amount in the packages, and the engine says so instead of
 * guessing. That is something the person issuing can fix, so it comes back as
 * a refusal with the sentence.
 *
 * What an invoice lacks includes, once the law requires the e-invoice of it,
 * what the e-invoice lacks. From then on a PDF alone is not a proper invoice,
 * and an invoice that could only go out as one is not issued; before then it
 * is, and the office sees on its screen what the e-invoice would still need.
 */
export async function contentForIssuing(
  tx: TenantTransaction,
  document: typeof documents.$inferSelect,
): Promise<{ content: DocumentContent; missing: readonly Missing[] }> {
  try {
    // The predecessors a successor takes off are read with a share lock, so a
    // cancellation of one of them waits for the issuing and then sees the
    // successor that builds on it.
    const { content, gaps } = await contentAndGapsOf(tx, document, shippedRules, {
      lockPredecessors: true,
    })

    return {
      content,
      missing: [
        ...missingDetails(shippedRules, content),
        ...(await eInvoiceRefusals(tx, content)),
        ...gaps,
      ],
    }
  } catch (error) {
    if (error instanceof RuleError) {
      throw new UnprocessableEntityException(error.message)
    }

    throw error
  }
}

/**
 * The progress invoices a final invoice takes off whose payments the office
 * has not confirmed (#189), by number.
 *
 * The body of an issuing carries, under `received`, what the screen showed as
 * received on each progress invoice, keyed by its number. A progress invoice
 * missing there is not confirmed, and neither is one whose amount differs from
 * what the payments add up to now: somebody recorded or removed a payment
 * after the screen was drawn, and what goes out would not be what was checked.
 */
function unconfirmedPayments(
  deductions: readonly DeductionContent[],
  body: unknown,
): readonly string[] {
  const received =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['received']
      : undefined
  const confirmed =
    typeof received === 'object' && received !== null && !Array.isArray(received)
      ? (received as Record<string, unknown>)
      : {}

  return deductions
    .filter((deduction) => confirmed[deduction.number] !== (deduction.received?.grossCents ?? 0))
    .map((deduction) => deduction.number)
}

/** The numbers of the progress invoices named in a sentence: "A", "A und B", "A, B und C". */
function listed(numbers: readonly string[]): string {
  return numbers.length < 2
    ? numbers.join('')
    : `${numbers.slice(0, -1).join(', ')} und ${numbers.at(-1) ?? ''}`
}

/** The refusal for a document that lacks mandatory details, the same for every route. */
function lacking(missing: readonly Missing[]): UnprocessableEntityException {
  // A sentence for whoever reads only `message`, and the list for a screen
  // that wants to point at each field.
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message:
      'Der Beleg kann noch nicht festgeschrieben werden, es fehlen Pflichtangaben. ' +
      missing.map((entry) => entry.message).join(' '),
    missing,
  })
}

/**
 * The refusal for a second successor out of the same document (#129), naming
 * the one the chain goes on at. Every kind a successor can be is a feminine
 * noun, Auftragsbestätigung, Abschlagsrechnung and Rechnung, but for the
 * Lieferschein (#299), which takes the masculine articles.
 */
function branchRefusal(successor: {
  readonly kind: DocumentKind
  readonly status: DocumentStatus
  readonly number: string | null
}): string {
  const title = documentTitle(successor.kind)
  const masculine = successor.kind === 'delivery_note'
  const [some, the, it] = masculine ? ['ein', 'der', 'ihm'] : ['eine', 'die', 'ihr']

  if (successor.status === 'draft') {
    return (
      `Aus diesem Beleg ist schon ${some} ${title} entstanden, noch als Entwurf. Die Kette geht ` +
      `bei ${it} weiter und verzweigt sich nicht; soll es ein anderer Folgebeleg sein, zuerst ` +
      'den Entwurf löschen.'
    )
  }

  // Signed on site and not issued yet: fixed, without a number.
  if (successor.number === null) {
    return (
      `Aus diesem Beleg ist schon ${some} ${title} entstanden, unterschrieben und noch ohne ` +
      `Nummer. Die Kette geht bei ${it} weiter und verzweigt sich nicht.`
    )
  }

  return (
    `Aus diesem Beleg ist schon ${the} ${title} ${successor.number} entstanden. Die Kette geht bei ` +
    `${it} weiter und verzweigt sich nicht, damit keine Rechnung ein zweites Mal stellt, was eine ` +
    'andere schon gestellt hat.' +
    (isCancellable(successor.kind)
      ? ' Soll sie ersetzt werden, wird sie storniert; danach entsteht der neue Folgebeleg ' +
        'wieder aus diesem.'
      : '')
  )
}

/** The states a document is issued from: a draft, or a report the customer signed. */
const issuable: readonly DocumentStatus[] = ['draft', 'signed']

const writableFields = [
  'customerId',
  'jobId',
  'siteId',
  'installationId',
  // Not `predecessorDocumentId`. The link back is made by the route that makes
  // a successor, out of the last link of the chain and nowhere else (#129); a
  // document that could name any predecessor could branch the chain.
  'kind',
  'documentDate',
  // When the work was done. Required on most invoices, see `missingDetails`,
  // and entered by whoever writes the document, not worked out.
  'serviceFrom',
  'serviceUntil',
  'subject',
  'introText',
  'closingText',
  // Writable while the document is a draft, and refused afterwards by the
  // trigger like every other field. The proposal above is right in the common
  // case and cannot be right in all of them.
  'taxTreatment',
  // The document's own payment term, or null for the business's setting.
  'paymentTermDays',
  // The store a delivery note is delivered from (#299), chosen in the office.
  // A report gets its store on site; any other kind none, which the check
  // `documents_store_of_a_report` refuses.
  'storeId',
] as const

/**
 * Refuses a payment term no form of this system would send, with the sentence
 * the form shows. Null is not refused: it hands the document back to the
 * business's setting. The check in the database would refuse the rest too,
 * with a sentence written for a developer.
 */
function checkPaymentTerm(values: Partial<Record<string, unknown>>): void {
  if (values['paymentTermDays'] === undefined || values['paymentTermDays'] === null) {
    return
  }

  const problem = paymentTermProblem(values['paymentTermDays'])

  if (problem !== null) {
    throw new BadRequestException(problem)
  }
}

/**
 * A document made a moment ago as it stands after what followed in the same
 * transaction: whether it follows its call and the version the line of the
 * surcharge gave it (#1097), which the row its insert returned does not know.
 */
async function asItStands(
  tx: TenantTransaction,
  created: typeof documents.$inferSelect,
): Promise<typeof documents.$inferSelect> {
  const [now] = await tx.select().from(documents).where(eq(documents.id, created.id))

  return now ?? created
}

/** Refuses a text longer than a document holds (`documentTextLimits`), as the check in the database does. */
function checkTexts(values: Partial<Record<string, unknown>>): void {
  const problem =
    documentTextProblem('subject', values['subject']) ??
    documentTextProblem('introText', values['introText']) ??
    documentTextProblem('closingText', values['closingText'])

  if (problem !== null) {
    throw new BadRequestException(problem)
  }
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly database: Database) {}

  @Get()
  @RequiresPermission('document.read')
  list(@CurrentIdentity() identity: RequestIdentity) {
    return this.database.forTenant(identity, (tx) =>
      tx.select().from(documents).where(isNull(documents.deletedAt)),
    )
  }

  @Post()
  @RequiresPermission('document.write')
  async create(@CurrentIdentity() identity: RequestIdentity, @Body() body: unknown) {
    const values = pick(body, writableFields)
    requireFields(values, ['customerId', 'kind', 'documentDate'])
    checkPaymentTerm(values)
    checkTexts(values)

    const [created] = await this.database.forTenant(identity, async (tx) => {
      // Before the proposal, which reads the customer: one of another
      // business would be proposed for as if it were none.
      await requireReferences(tx, documents, values, true)

      return tx
        .insert(documents)
        .values({
          ...(values as typeof documents.$inferInsert),
          tenantId: identity.tenantId,
          // Whoever made it (#786), and so may delete it while it is a draft.
          createdBy: identity.userId,
          // Worked out once, here, and then it belongs to the document. Asking
          // the customer record again on reading would rewrite an invoice from
          // last year the day a customer's flag changes.
          taxTreatment:
            (values['taxTreatment'] as TaxTreatment | undefined) ??
            (await proposedTreatment(
              tx,
              values['customerId'] as CustomerId,
              values['documentDate'] as IsoDate,
            )),
        })
        .returning()
    })

    return created
  }

  @Patch(':id')
  @RequiresPermission('document.write')
  async update(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const values = pick(body, writableFields)
    requireSomething(values)
    checkPaymentTerm(values)
    checkTexts(values)

    return this.database.forTenant(identity, async (tx) => {
      await requireReferences(tx, documents, values, false)

      // The period as it was, read under the lock the update takes anyway, so
      // that the day of a maintenance follows a period that moves and not one
      // that is sent again as it stands (#1037).
      const [before] =
        values['serviceFrom'] !== undefined || values['serviceUntil'] !== undefined
          ? await tx
              .select({ serviceFrom: documents.serviceFrom, serviceUntil: documents.serviceUntil })
              .from(documents)
              .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))
              .for('update')
          : []

      const [updated] = await tx
        .update(documents)
        .set(values as Partial<typeof documents.$inferInsert>)
        // Only a draft can be changed. A document that has been issued is
        // corrected by a cancellation or a credit note, never edited; that is
        // leading decision 4 and it is not negotiable by a PATCH.
        .where(
          and(
            eq(documents.id, id as DocumentId),
            eq(documents.status, 'draft'),
            isNull(documents.deletedAt),
          ),
        )
        .returning()

      if (updated) {
        // A draft moved to another job has the surcharge of that call (#1087),
        // and one whose tax changes works it out with that tax.
        if (surchargeTermsOfDocument.some((field) => values[field] !== undefined)) {
          await refreshSurchargeLine(tx, updated.id)
        }

        // A recurring invoice whose period moves takes the day of the
        // maintenance that period pays for (#1037).
        if (
          before &&
          (before.serviceFrom !== updated.serviceFrom ||
            before.serviceUntil !== updated.serviceUntil)
        ) {
          return (await followPeriod(tx, updated.id)) ?? updated
        }

        return updated
      }

      // Nothing changed, and there are two very different reasons for that.
      // A document that is not there is a 404. One that is there and fixed
      // gets the sentence why, because "not found" for a quote the office is
      // looking at would send somebody searching for a fault that is none.
      const [existing] = await tx
        .select({ kind: documents.kind, status: documents.status })
        .from(documents)
        .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))

      const reason = existing ? whyFixed(existing) : null

      if (reason === null) {
        throw new NotFoundException()
      }

      throw new ConflictException(reason)
    })
  }

  /**
   * Issuing a document. Its own right, and the reason the two are separate:
   * a technician writes the report on site, the office turns it into something
   * the bookkeeping is built on.
   *
   * From here the document is fixed. The number is handed out inside this
   * transaction, so a failure further down takes the number back with it and
   * leaves no hole in the sequence.
   *
   * Before the number, the mandatory details. An invoice that lacks one of
   * them is refused with a list of what is missing, each item naming the
   * paragraph, and the counter is not touched: section 4.2 wants the check
   * before the fixing, and a number spent on an invoice that then cannot go
   * out would be a hole the next tax audit asks about.
   *
   * After the number, the snapshot. What the document says is written down in
   * the same transaction, so that the PDF printed from it next week or in ten
   * years shows the customer's address of today and not of then.
   *
   * This route exists only on the server, and that is the answer to "issuing
   * works online only": there is no offline path to it. A device without a
   * network can write drafts and nothing else.
   *
   * A signed report is issued the same way. The customer's signature froze
   * what it says; issuing adds the number and the moment, and the trigger on
   * the table lets exactly that through and nothing more.
   *
   * A final invoice that takes off progress invoices is issued only once the
   * office has confirmed, for each of them, what came in (#189). It takes off
   * exactly the payments recorded, and a payment nobody recorded is money the
   * invoice asks for again; this step is where somebody looks at the list
   * before it goes out. Refused with 409 and `confirm: 'payments'`, and the
   * numbers still to confirm under `unconfirmed`.
   */
  @Post(':id/issue')
  @RequiresPermission('document.issue')
  async issue(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.database.forTenant(identity, async (tx) => {
      // The document and its whole chain upwards, locked together before
      // anything is written, in the order of their ids, the order a
      // transmission from a device locks the documents it comes to
      // (opengewerk#1094). The predecessor is fixed below and the deductions
      // read every link above it; locked one after the other, or after a
      // write, issuing could hold one the transmission waits for and wait
      // for one it holds. The links are made with each document and never
      // change (#129), so the chain is walked without a lock first. The lock
      // a transmission takes, and no stronger: a key share, as the first file
      // of a document above takes it for its reference, goes through.
      const chain: DocumentId[] = [id as DocumentId]

      for (let link: DocumentId | null = id as DocumentId; link !== null;) {
        const [found] = await tx
          .select({ predecessorDocumentId: documents.predecessorDocumentId })
          .from(documents)
          .where(eq(documents.id, link))

        // A document not to be seen yet, one being made right now, is not
        // there to issue: its chain could not be locked whole.
        if (!found && chain.length === 1) {
          throw new NotFoundException()
        }

        const next: DocumentId | null = found?.predecessorDocumentId ?? null

        link = next !== null && !chain.includes(next) ? next : null

        if (link !== null) {
          chain.push(link)
        }
      }

      await tx
        .select({ id: documents.id })
        .from(documents)
        .where(inArray(documents.id, chain))
        .orderBy(documents.id)
        .for('no key update')

      // Locked before anything is read that the snapshot freezes: a line
      // route (`no key update`), a change to the head (an update) and the
      // trigger on the lines (`for share`) wait for this row, so the snapshot
      // holds what the document says when it is issued, and a write that
      // comes later finds it fixed. Not `for update` (#1095): that would hold
      // up every check of a foreign key that points here, the first PDF of the
      // document kept meanwhile among them, which takes the chain of the log
      // first and so would wait in a circle with this transaction.
      const [existing] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))
        .for('no key update')

      if (!existing) {
        throw new NotFoundException()
      }

      if (!issuable.includes(existing.status)) {
        throw new ConflictException('Der Beleg ist schon festgeschrieben.')
      }

      // An invoice made on site out of a report the customer signed (#292)
      // finds the report without its number: the technician may make the
      // draft and may not issue. The report is issued here first, in the same
      // transaction, so that the chain is fixed from its start and the report
      // has its number before the invoice made out of it.
      if (existing.predecessorDocumentId !== null) {
        const [predecessor] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, existing.predecessorDocumentId), isNull(documents.deletedAt)))
          .for('no key update')

        if (predecessor && isSignedReport(predecessor)) {
          await fixDocument(tx, identity, predecessor)
        }
      }

      // One moment for the date and the issuing, so that an invoice issued
      // across midnight in Germany is not dated the day before its issue.
      // Dated before the line of the surcharge is worked out the last time:
      // without a day of work, its tax is the one of that date, as the totals'
      // is (the review of #1112).
      const issuedAt = new Date()
      const dated = await datedForIssue(tx, existing, todayInGermany(issuedAt))

      // The line of the surcharge as everything stands now, once more before
      // it is frozen (#1087): a change that raced the draft into being, or
      // one that came before its line, shows here at the latest. After the
      // locks above, in their order. A surcharge that is due and is not on
      // the draft, for want of room or for its size, is not left off in
      // silence.
      const surchargeWaits = await refreshSurchargeLine(tx, existing.id)

      if (surchargeWaits === 'no rules for the call') {
        throw new UnprocessableEntityException(
          'Der Notdienstzuschlag lässt sich nicht rechnen: Für den Tag des Anrufs kennt ' +
            'OpenGewerk keine Regeln. Den Zeitpunkt des Anrufs am Auftrag prüfen.',
        )
      }

      if (surchargeWaits === 'waits for room') {
        throw new ConflictException(
          'Für den Notdienstzuschlag ist kein Platz mehr: Ein Beleg hat höchstens ' +
            `${lineLimits.lines.toLocaleString('de-DE')} Positionen. Sobald eine entfernt ist, ` +
            'kommt er dazu, dann lässt sich der Beleg festschreiben.',
        )
      }

      if (surchargeWaits === 'too large') {
        throw new ConflictException(
          'Der Notdienstzuschlag wäre größer, als eine Position fassen kann. Die Stunden ' +
            'prüfen; stimmen sie, den Zuschlag selbst eintragen: die Zeile des Zuschlags von ' +
            'Hand ändern oder, steht keine da, eine Position „Notdienstzuschlag“ anlegen.',
        )
      }

      const { content, missing } = await contentForIssuing(tx, dated)

      if (missing.length > 0) {
        throw lacking(missing)
      }

      const unconfirmed = closesProgressInvoices(content)
        ? unconfirmedPayments(content.deductions, body)
        : []

      if (unconfirmed.length > 0) {
        throw new ConflictException({
          message:
            'Die Schlussrechnung zieht ab, was auf die Abschlagsrechnungen eingegangen ist. Noch ' +
            `nicht bestätigt ist der Eingang auf ${listed(unconfirmed)}.`,
          confirm: 'payments',
          unconfirmed,
        })
      }

      return issueWith(tx, identity, dated, content, issuedAt)
    })
  }

  /**
   * The next document in the chain of section 1.4, made out of this one: an
   * order confirmation out of a quote, an invoice out of what the work was
   * agreed or recorded on, the next progress invoice out of the one before.
   * Which kind may follow which is `successorKinds` in `domain`.
   *
   * On the server and in one transaction, because it is a head and every line
   * of the predecessor. Through the outbox it would be dozens of operations
   * arriving one by one, and a connection lost halfway would leave an order
   * confirmation with half the positions of the quote it confirms.
   *
   * Only out of an issued document. What the customer accepted is the quote
   * that went out, not a draft that may still change after the confirmation
   * has been written against it.
   *
   * And only out of the last link (#129). A document that already has a
   * successor that counts gets no second one: a final invoice made out of the
   * quote next to a progress invoice made out of it would deduct nothing of
   * it, because the deductions follow a chain upwards and never sideways.
   *
   * The lines are copied and not referenced. The confirmation is a document of
   * its own: it may drop a position the customer did not order, and it is
   * frozen on its own when it is issued. The link back is the predecessor
   * reference, which is what the quantity comparison of section 1.4 walks.
   *
   * The tax treatment comes along from the predecessor rather than being
   * proposed anew. The confirmation confirms that deal, and a treatment
   * somebody chose by hand on the quote is part of it.
   *
   * The texts above and below the lines stay behind. They were written for
   * the letter the quote was, and an order confirmation that opens with
   * "thank you for your enquiry" answers a question nobody asked any more.
   *
   * The time of the work comes along where the predecessor knows it. A report
   * is written on the day of the work, so its date is the date of service of
   * the invoice made out of it, which section 14 (4) number 6 UStG asks for;
   * any other predecessor passes on the period it states, if it states one.
   */
  @Post(':id/successors')
  @RequiresPermission('document.write')
  async successor(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const values = pick(body, ['kind', 'documentDate'] as const)
    requireFields(values, ['kind'])

    if (!(documentKinds as readonly string[]).includes(String(values.kind))) {
      throw new BadRequestException(`Unbekannte Belegart: ${String(values.kind)}`)
    }

    const kind = values.kind as DocumentKind
    const documentDate = (values.documentDate as IsoDate | undefined) ?? todayInGermany()

    return this.database.forTenant(identity, async (tx) => {
      // Locked, so that two successors made at the same moment wait for each
      // other, and the second finds the first in the check below.
      const [predecessor] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))
        .for('update')

      if (!predecessor) {
        throw new NotFoundException()
      }

      if (!successorsOf(predecessor.kind).includes(kind)) {
        throw new BadRequestException(
          `Aus einem Beleg der Art ${documentTitle(predecessor.kind)} entsteht keine ` +
            `${documentTitle(kind)}.`,
        )
      }

      // A report the customer signed is fixed by the signature, and the
      // invoice out of it is made on site, as a draft (#292); the report gets
      // its number when the invoice is issued. Any other predecessor is
      // issued first.
      if (
        predecessor.status !== 'issued' &&
        !(kind === 'final_invoice' && isSignedReport(predecessor))
      ) {
        throw new ConflictException(
          predecessor.status === 'draft'
            ? 'Ein Folgebeleg entsteht aus einem festgeschriebenen Beleg, und dieser ist noch ein ' +
                'Entwurf. Erst festschreiben, dann den Folgebeleg anlegen.'
            : 'Aus einem stornierten Beleg entsteht kein Folgebeleg.',
        )
      }

      // An offer the office marked as declined gets no successor until the
      // mark is taken back (#841).
      const [declined] = await tx
        .select({ id: offerDeclines.id })
        .from(offerDeclines)
        .where(eq(offerDeclines.documentId, predecessor.id))

      if (declined) {
        throw new ConflictException(declinedOfferRefusal)
      }

      // One successor that counts, so that the chain does not branch (#129).
      // The unique index `documents_one_successor` holds the same rule behind
      // this for every other way in.
      const [later] = (
        await tx
          .select({ kind: documents.kind, status: documents.status, number: documents.number })
          .from(documents)
          .where(
            and(eq(documents.predecessorDocumentId, predecessor.id), isNull(documents.deletedAt)),
          )
      ).filter(continuesChain)

      if (later) {
        throw new ConflictException(branchRefusal(later))
      }

      // A report in a collective invoice that counts has that invoice as its
      // one successor (#135). The trigger of migration 0041 says the same for
      // every other way in.
      const [collected] = await tx
        .select({ kind: documents.kind, status: documents.status, number: documents.number })
        .from(documentSources)
        .innerJoin(documents, eq(documents.id, documentSources.documentId))
        .where(
          and(
            eq(documentSources.sourceDocumentId, predecessor.id),
            isNull(documentSources.releasedAt),
          ),
        )
        .limit(1)

      if (collected) {
        throw new ConflictException(branchRefusal(collected))
      }

      const [created] = await tx
        .insert(documents)
        .values({
          tenantId: identity.tenantId,
          createdBy: identity.userId,
          customerId: predecessor.customerId,
          jobId: predecessor.jobId,
          siteId: predecessor.siteId,
          installationId: predecessor.installationId,
          predecessorDocumentId: predecessor.id,
          kind,
          documentDate,
          subject: predecessor.subject,
          taxTreatment: predecessor.taxTreatment,
          // A term the quote stated for itself was agreed with the customer,
          // and the invoice out of it asks for the same. Without one, the
          // successor follows the setting on its own date, as it would anyway.
          paymentTermDays: predecessor.paymentTermDays,
          serviceFrom:
            predecessor.serviceFrom ??
            (predecessor.kind === 'time_and_material_report' ? predecessor.documentDate : null),
          serviceUntil: predecessor.serviceUntil,
        })
        .returning()

      if (!created) {
        throw new Error('The successor was written and is not readable afterwards.')
      }

      // The kind of contract belongs to the deal and not to the letter: the
      // order confirmation of a delivery is about a delivery as well. What is
      // switched on or off stays behind, because the successor is a different
      // kind and gets the proposal for its own.
      const { variant } = await choicesOf(tx, predecessor.id)

      if (variant !== noInstructionChoices.variant) {
        await tx
          .insert(documentInstructionChoices)
          .values({ tenantId: identity.tenantId, documentId: created.id, variant })
      }

      // The invoice out of the report of a maintenance whose contract has a
      // flat price per maintenance carries that price as its one line (#294);
      // what came on top the office adds to the draft.
      const flat =
        predecessor.kind === 'time_and_material_report'
          ? await contractFlatLineFor(tx, predecessor.jobId)
          : null

      if (flat) {
        await tx
          .insert(documentLines)
          .values({ tenantId: identity.tenantId, documentId: created.id, position: 1, ...flat })

        // An emergency call under such a contract carries its surcharge as
        // well, as the collective invoice of its job does (#1096); in percent
        // it counts the hours of the draft, of which a flat price has none.
        await followCall(tx, created.id)

        return await asItStands(tx, created)
      }

      const lines = await tx
        .select()
        .from(documentLines)
        .where(and(eq(documentLines.documentId, predecessor.id), isNull(documentLines.deletedAt)))
        .orderBy(asc(documentLines.position), asc(documentLines.id))

      // A report carries no prices. The invoice made out of it gives a line
      // taken from an article the price of the invoice's date (#296); every
      // other successor keeps the prices of its predecessor, an invoice out
      // of a delivery note those its order confirmation agreed (#299).
      const prices = !repricedFrom(predecessor.kind)
        ? new Map<string, PriceOfDay>()
        : await articlePricesOn(
            tx,
            lines.map((line) => line.articleId),
            created.documentDate,
          )

      const priced = lines.map((original) => pricedFromArticle(original, prices))

      if (priced.length > 0) {
        await tx.insert(documentLines).values(
          priced.map((line) => ({
            tenantId: identity.tenantId,
            documentId: created.id,
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
          })),
        )
      }

      // The invoice out of a report follows its call (#1097): the report of
      // an emergency call gives it the surcharge the business set for its
      // kind (#293), as the last line, and one whose job becomes an emergency
      // call later gets it then.
      if (predecessor.kind === 'time_and_material_report') {
        await followCall(tx, created.id)

        return await asItStands(tx, created)
      }

      return created
    })
  }

  /**
   * The progress invoices this document takes off, oldest first. Empty for a
   * kind that deducts nothing.
   *
   * A draft gets them out of its chain, as they stand in the snapshots of the
   * progress invoices. An issued document gets the list it froze, and that is
   * also how a cancellation shows the deductions it turns round: it has no
   * chain of its own to walk, only the mirror of its invoice.
   */
  @Get(':id/deductions')
  @RequiresPermission('document.read')
  async deductions(@CurrentIdentity() identity: RequestIdentity, @Param('id') id: string) {
    return this.database.forTenant(identity, async (tx) => {
      const [document] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))

      if (!document) {
        throw new NotFoundException()
      }

      if (showsReceivedPayments(document) && !isAllowed(identity, 'payment.read')) {
        throw new ForbiddenException(paymentsOfADraft)
      }

      if (document.status === 'issued' || document.status === 'cancelled') {
        const [snapshot] = await tx
          .select({ content: documentSnapshots.content })
          .from(documentSnapshots)
          .where(eq(documentSnapshots.documentId, document.id))

        if (snapshot) {
          return currentContent(snapshot.content).deductions
        }
      }

      try {
        return await deductionsFor(tx, document)
      } catch (error) {
        if (error instanceof RuleError) {
          throw new UnprocessableEntityException(error.message)
        }

        throw error
      }
    })
  }

  /**
   * Cancelling an invoice, section 4.2 and leading decision 4: an issued
   * invoice is never changed and never deleted, it is cancelled by an invoice
   * of its own that turns every figure round, and both stay in the books.
   *
   * One step and one transaction, like issuing. The cancellation is made, its
   * lines are written as the mirror of the invoice's, its mandatory details
   * are checked, it gets the next number of the invoice sequence and its
   * snapshot, and the invoice becomes `cancelled`. A failure anywhere takes all
   * of it back and leaves no hole in the numbers. What it says comes out of
   * the invoice's own snapshot, see `cancellationOf`.
   *
   * Its right is the right to issue: a cancellation is a booking as much as
   * the invoice was, and a technician writes neither.
   *
   * Not while another issued invoice builds on this one. A progress invoice
   * that a later invoice deducted is part of that invoice's figures, and
   * cancelling it from under it would leave the later one deducting something
   * that no longer stands. The later one goes first.
   *
   * The transaction marks itself with `app.cancelling`, the one mark the
   * database accepts for making a document of this kind; see migration 0016.
   */
  @Post(':id/cancellation')
  @RequiresPermission('document.issue')
  async cancel(@CurrentIdentity() identity: RequestIdentity, @Param('id') id: string) {
    return this.database.forTenant(identity, (tx) => cancelInvoice(tx, identity, id))
  }

  /**
   * What the next number will be. The client shows it while somebody is still
   * writing the document, and it is a preview and not a promise: whoever
   * issues first takes it, and the next one moves on. It is built by the same
   * function that builds the real one, so the two cannot drift apart.
   */
  @Get('next-number/:kind')
  @RequiresPermission('document.read')
  async nextNumber(@CurrentIdentity() identity: RequestIdentity, @Param('kind') kind: string) {
    if (!(documentKinds as readonly string[]).includes(kind)) {
      throw new BadRequestException(`Unbekannte Belegart: ${kind}`)
    }

    const key = numberRangeOf(kind as DocumentKind)

    return this.database.forTenant(identity, async (tx) => {
      const [range] = await tx
        .select()
        .from(numberRanges)
        .where(and(eq(numberRanges.tenantId, identity.tenantId), eq(numberRanges.key, key)))

      const pattern = range?.pattern ?? defaultPatterns[key]
      const counter = range?.nextValue ?? 1

      return {
        preview: numberFromPattern(pattern, { counter, year: yearInGermany() }),
        pattern,
      }
    })
  }

  /**
   * Only a draft, and the database says so too. A document that has been
   * issued is cancelled, never removed, not even by marking it: that is
   * leading decision 4, and the trigger on the table refuses it whichever way
   * somebody comes. A draft of one's own goes with the right to write
   * documents, somebody else's only with `document.delete` (#786). Marked and
   * kept in the change log, as the GoBD ask of a deletion (Rz. 59 and 110).
   */
  @Delete(':id')
  @RequiresPermission('document.write')
  async remove(@CurrentIdentity() identity: RequestIdentity, @Param('id') id: string) {
    return this.database.forTenant(identity, async (tx) => {
      const [draft] = await tx
        .select({ status: documents.status, createdBy: documents.createdBy })
        .from(documents)
        .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))
        .for('update')

      if (
        draft !== undefined &&
        draft.status === 'draft' &&
        !mayDeleteDraft(draft, identity.userId, (right) => isAllowed(identity, right))
      ) {
        throw new ForbiddenException(notOwnDraft)
      }

      const [removed] = await tx
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(documents.id, id as DocumentId),
            eq(documents.status, 'draft'),
            isNull(documents.deletedAt),
          ),
        )
        .returning()

      if (removed) {
        return removed
      }

      // The same two answers as a refused change: not there, or there and
      // past the point where it could be removed, with the sentence why.
      const [existing] = await tx
        .select({ kind: documents.kind, status: documents.status })
        .from(documents)
        .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))

      const reason = existing ? whyFixed(existing) : null

      if (reason === null) {
        throw new NotFoundException()
      }

      throw new ConflictException(reason)
    })
  }
}

type DocumentRow = typeof documents.$inferSelect

/**
 * An invoice as it is issued: with the day of its issue as its date (#1039).
 * An invoice states the day it was issued on (§ 14 Abs. 4 Satz 1 Nr. 3 UStG),
 * and a draft keeps the date it was written with or given, which can be a
 * day before or ahead. So the date is set to today in Germany, in the
 * transaction and under the lock of the issuing, before anything is read
 * that goes by it: the payment term, the statement of cash accounting, and
 * the rate of an invoice without a day of work. A recurring invoice a lead
 * made ahead of its period is dated on that day as well: the period of
 * service on it says what it is for. Any other document keeps its date; the
 * duty is the invoice's, and a quote or a report is dated as written.
 */
async function datedForIssue(
  tx: TenantTransaction,
  document: DocumentRow,
  today: IsoDate,
): Promise<DocumentRow> {
  // Only a draft: an invoice a customer signed in a version before 0.6.3 is
  // fixed, and issuing it is all that is left (#1039, the review).
  if (!isInvoice(document.kind) || document.status !== 'draft') {
    return document
  }

  if (document.documentDate === today) {
    return document
  }

  const [dated] = await tx
    .update(documents)
    .set({ documentDate: today })
    .where(eq(documents.id, document.id))
    .returning()

  return dated ?? document
}

/** A report the customer signed and nobody issued yet, which a signature fixed without a number. */
function isSignedReport(document: Pick<DocumentRow, 'kind' | 'status'>): boolean {
  return document.status === 'signed' && document.kind === 'time_and_material_report'
}

/**
 * Cancels an issued invoice (#74): the cancellation invoice with every figure
 * turned round, issued at once, and the invoice cancelled, in the transaction
 * of the caller. The route of the cancellation calls it, and so does laying
 * the period of a recurring invoice out again (#1037).
 */
export async function cancelInvoice(
  tx: TenantTransaction,
  identity: RequestIdentity,
  id: string,
): Promise<DocumentRow> {
  // Locked before the checks below, which guard state that others write:
  // issuing a successor reads this invoice with a share lock and a
  // payment locks it for update, so the cancellation waits for them or
  // they wait for it, and whichever comes second sees what the first left.
  const [original] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, id as DocumentId), isNull(documents.deletedAt)))
    .for('update')

  if (!original) {
    throw new NotFoundException()
  }

  if (original.kind === 'cancellation_invoice') {
    throw new BadRequestException(
      'Eine Stornorechnung wird nicht storniert. Soll die Leistung wieder berechnet werden, ' +
        'entsteht dafür eine neue Rechnung.',
    )
  }

  if (!isCancellable(original.kind)) {
    throw new BadRequestException(
      'Storniert wird nur eine Rechnung. Ein anderer Beleg, der nicht mehr gilt, wird durch ' +
        'einen neuen ersetzt.',
    )
  }

  if (original.status === 'draft') {
    throw new ConflictException(
      'Ein Entwurf wird nicht storniert, sondern gelöscht: er steht noch in keinen Büchern.',
    )
  }

  if (original.status !== 'issued') {
    throw new ConflictException('Die Rechnung ist schon storniert.')
  }

  const [later] = await tx
    .select({ kind: documents.kind, number: documents.number })
    .from(documents)
    .where(
      and(
        eq(documents.predecessorDocumentId, original.id),
        eq(documents.status, 'issued'),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1)

  if (later) {
    // A final invoice that builds on this one takes it off, which is what
    // makes it a Schlussrechnung (#132).
    const title = later.kind === 'final_invoice' ? 'Schlussrechnung' : documentTitle(later.kind)

    throw new ConflictException(
      `Auf diese Rechnung baut die ${title} ${later.number ?? ''} auf. ` +
        'Erst jene stornieren, dann diese.',
    )
  }

  const [paid] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.documentId, original.id))
    .limit(1)

  if (paid) {
    // Money that came in on a cancelled invoice would count nowhere: a
    // final invoice passes a cancelled progress invoice over (#189). It
    // belongs to the invoice that replaces this one, and somebody who
    // knows moves it there, rather than the cancellation guessing.
    throw new ConflictException(
      'Auf diese Rechnung sind Zahlungseingänge erfasst. Eine stornierte Rechnung zählt ' +
        'nirgends mehr mit, deshalb die Eingänge vor dem Stornieren entfernen und an der ' +
        'Rechnung erfassen, die diese ersetzt.',
    )
  }

  const [snapshot] = await tx
    .select({ content: documentSnapshots.content })
    .from(documentSnapshots)
    .where(eq(documentSnapshots.documentId, original.id))

  if (!snapshot) {
    throw new UnprocessableEntityException(
      'Für diese Rechnung ist nicht festgehalten, was sie gestellt hat, deshalb lässt sich ' +
        'ihr Spiegel nicht schreiben.',
    )
  }

  // One moment for the date, the number and the issue, so that a
  // cancellation made around midnight does not carry the day before its
  // issue (#1039, the review).
  const issuedAt = new Date()
  const documentDate = todayInGermany(issuedAt)
  const content = cancellationOf(currentContent(snapshot.content), {
    number: null,
    documentDate,
    issuer: await issuerOf(tx, identity.tenantId),
  })
  // Not held back for the e-invoice, unlike an invoice: a cancellation that
  // cannot be written leaves an invoice standing that should not stand,
  // which is worse than a cancellation whose e-invoice lacks a value. It
  // names the same customer as the invoice, so on that side it lacks at
  // most what the invoice lacked, and the office sees it on its screen.
  const missing = missingDetails(shippedRules, content)

  if (missing.length > 0) {
    throw lacking(missing)
  }

  await tx.execute(sql`select set_config('app.cancelling', 'on', true)`)

  const [created] = await tx
    .insert(documents)
    .values({
      tenantId: identity.tenantId,
      createdBy: identity.userId,
      customerId: original.customerId,
      jobId: original.jobId,
      siteId: original.siteId,
      installationId: original.installationId,
      predecessorDocumentId: original.id,
      kind: 'cancellation_invoice',
      documentDate,
      serviceFrom: original.serviceFrom,
      serviceUntil: original.serviceUntil,
      // The day of the maintenance its invoice paid for (#1037).
      supplyOn: original.supplyOn,
      subject: original.subject,
      taxTreatment: original.taxTreatment,
    })
    .returning()

  if (!created) {
    throw new Error('The cancellation was written and is not readable afterwards.')
  }

  const lines = await tx
    .select()
    .from(documentLines)
    .where(and(eq(documentLines.documentId, original.id), isNull(documentLines.deletedAt)))
    .orderBy(asc(documentLines.position), asc(documentLines.id))

  if (lines.length > 0) {
    await tx.insert(documentLines).values(
      lines.map((line) => ({
        tenantId: identity.tenantId,
        documentId: created.id,
        kind: line.kind,
        position: line.position,
        designation: line.designation,
        description: line.description,
        // The mirror: the quantity turned round, the price as it was, so
        // the total comes out turned round by the same arithmetic.
        quantityMilli: -line.quantityMilli || 0,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        priceBase: line.priceBase,
        vatRate: line.vatRate,
        netCents: -line.netCents || 0,
      })),
    )
  }

  const number = await assignDocumentNumber(tx, identity.tenantId, 'cancellation_invoice', issuedAt)

  const [issued] = await tx
    .update(documents)
    .set({ status: 'issued', number, issuedAt, issuedBy: identity.userId, updatedAt: issuedAt })
    .where(and(eq(documents.id, created.id), eq(documents.status, 'draft')))
    .returning()

  await tx.insert(documentSnapshots).values({
    tenantId: identity.tenantId,
    documentId: created.id,
    content: await withStoredLogo(tx, identity.tenantId, { ...content, number }),
  })

  // The status and nothing else, which is exactly what the trigger on the
  // table lets through for an issued document. Checked on `issued` again:
  // two cancellations of the same invoice at the same moment would both
  // have passed the check above, and the second finds nothing to cancel
  // here and takes its own cancellation back with it.
  const [cancelled] = await tx
    .update(documents)
    .set({ status: 'cancelled', updatedAt: issuedAt })
    .where(
      and(
        eq(documents.id, original.id),
        eq(documents.status, 'issued'),
        isNull(documents.deletedAt),
      ),
    )
    .returning({ id: documents.id })

  if (!issued || !cancelled) {
    throw new ConflictException('Die Rechnung ist inzwischen storniert worden.')
  }

  return withIssuedTotals(tx, issued)
}

/**
 * Issues a document that is locked and whose content is known: the number,
 * the moment, who issued it, and the snapshot of what it says, in the
 * transaction of the caller.
 */
export async function issueWith(
  tx: TenantTransaction,
  // Nobody for a recurring invoice the deadline engine issues by itself (#295).
  identity: Pick<RequestIdentity, 'tenantId'> & { readonly userId: string | null },
  existing: DocumentRow,
  content: DocumentContent,
  issuedAt: Date = new Date(),
): Promise<DocumentRow> {
  const number = await assignDocumentNumber(tx, identity.tenantId, existing.kind, issuedAt)

  // `deletedAt` a second time, and not out of habit. The lock above keeps
  // a deletion out since the read, and this condition still holds if the
  // lock is ever taken away: what comes out of that race cannot be
  // repaired on a running installation. The number is spent, the entry is
  // in the hash chain, and the document is fixed and out of every list at
  // the same time.
  const [issued] = await tx
    .update(documents)
    .set({ status: 'issued', number, issuedAt, issuedBy: identity.userId, updatedAt: issuedAt })
    .where(
      and(
        eq(documents.id, existing.id),
        inArray(documents.status, [...issuable]),
        isNull(documents.deletedAt),
      ),
    )
    .returning()

  if (!issued) {
    throw new NotFoundException()
  }

  await tx.insert(documentSnapshots).values({
    tenantId: identity.tenantId,
    documentId: issued.id,
    content: await withStoredLogo(tx, identity.tenantId, { ...content, number }),
  })

  return withIssuedTotals(tx, issued)
}

/**
 * The row of a document just issued, read again once its snapshot is written:
 * the trigger on the snapshot copies its totals onto the document (#1035),
 * after the update that issued it returned.
 */
async function withIssuedTotals(tx: TenantTransaction, issued: DocumentRow): Promise<DocumentRow> {
  const [current] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, issued.tenantId), eq(documents.id, issued.id)))

  return current ?? issued
}

/**
 * Issues a signed report on the way to the invoice made out of it (#292). It
 * lacks nothing a report could lack, or the invoice is not issued either and
 * the office hears what the report lacks.
 */
async function fixDocument(
  tx: TenantTransaction,
  identity: RequestIdentity,
  report: DocumentRow,
): Promise<DocumentRow> {
  const { content, missing } = await contentForIssuing(tx, report)

  if (missing.length > 0) {
    throw lacking(missing)
  }

  return issueWith(tx, identity, report, content)
}
