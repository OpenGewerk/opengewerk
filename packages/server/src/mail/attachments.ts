import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import {
  type AppointmentId,
  berlinClock,
  type DocumentId,
  formatFor,
  type IsoDate,
  type JobId,
  RuleError,
  shippedRules,
} from '@opengewerk/domain'
import {
  type Database,
  type MailAttachment,
  MailDeliveryError,
  type TenantTransaction,
} from '@opengewerk/platform-server'
import { eq } from 'drizzle-orm'

import type { DocumentFiles, MailedFile } from '../api/document-files.js'
import { dutyOf } from '../api/e-invoice.controller.js'
import { frozenContent } from '../documents/content.js'
import { todayInGermany } from '../today.js'
import { appointments, documents, jobs } from '../database/schema/index.js'
import { customerRestricted } from '../privacy/customer-erasure.js'
import { appointmentInvitation } from '../notifications/confirmation-mail.js'
import {
  CallCustomerChanged,
  CallInstructionsRefused,
  callPrintFacts,
} from '../service-calls/instructions.js'
import type { OutboxRow } from './outbox.js'

/** Where the files a message carries come from. Handed to the job, so a test can bring its own. */
export type AttachmentSource = (row: OutboxRow) => Promise<readonly MailAttachment[]>

/** A number as it may stand in a file name. A number pattern may well contain a slash. */
function safe(number: string): string {
  return number.replaceAll(/[\\/:*?"<>|]+/g, '-')
}

function fileNameOf(file: MailedFile, attachment: 'pdf' | 'zugferd' | 'xrechnung'): string {
  if (file.number === null) {
    // A report signed on site, before the office gave it a number. Named the
    // way its PDF is named when somebody opens it.
    return `${file.heading} unterschrieben.pdf`
  }

  return attachment === 'xrechnung'
    ? `XRechnung ${safe(file.number)}.xml`
    : `${file.heading} ${safe(file.number)}.pdf`
}

/**
 * The files of issued documents, from the same place the routes hand them out
 * from.
 *
 * A document keeps one PDF, one XRechnung and one ZUGFeRD PDF, each made the
 * first time somebody asks and read from then on. The message asks the same
 * way, so a customer who later downloads the invoice gets the bytes the mail
 * carried, and a document whose PDF nobody opened yet has it printed now.
 *
 * What stands in the way sorts into two. A renderer that is not running, a
 * file store that does not answer: those pass, and the message waits for the
 * next attempt like it waits for a mail server. A document that has no file
 * to give, because it lost its number or lacks what its e-invoice needs, will
 * not have one an hour later either, and the message is given up on with the
 * reason.
 */
export function documentAttachments(files: DocumentFiles): AttachmentSource {
  return async (row) => {
    if (row.documentId === null || row.attachment === null) {
      throw new MailDeliveryError(
        'Der Nachricht fehlt der Beleg, den sie tragen soll.',
        'EDOCUMENT',
        null,
        { permanent: true },
      )
    }

    try {
      const file = await files.forMail(
        { tenantId: row.tenantId, reason: 'mail' },
        row.documentId,
        row.attachment,
      )

      return [
        {
          filename: fileNameOf(file, row.attachment),
          content: file.bytes,
          contentType: row.attachment === 'xrechnung' ? 'application/xml' : 'application/pdf',
        },
      ]
    } catch (error) {
      const final =
        error instanceof NotFoundException ||
        error instanceof ConflictException ||
        error instanceof UnprocessableEntityException ||
        error instanceof RuleError

      throw new MailDeliveryError(
        `Der Anhang ließ sich nicht erzeugen: ${error instanceof Error ? error.message : String(error)}`,
        final ? 'EDOCUMENT' : 'EATTACHMENT',
        null,
        { permanent: final },
      )
    }
  }
}

/**
 * The files of a message, with the instructions of a service call (#292)
 * beside those of a document: the PDF of the instructions, printed when the
 * message goes out, in the words of the day of the request signed at the door
 * or of the day the office asked. A call that gets none any more, or whose
 * letterhead lacks what the words need, will not print an hour later either,
 * and the message is given up on with the reason.
 *
 * Printed only for the customer the message was written for. The worker asks
 * that before (`refuseWithheldCustomerMail`), in a transaction of its own; a
 * job given to another customer right after would print the new customer's
 * name and address for the first one's. So it is asked again on the very row
 * the PDF is printed from.
 */
export function withCallInstructions(
  files: DocumentFiles,
  database: Database,
  others: AttachmentSource,
): AttachmentSource {
  return async (row) => {
    // The confirmation of a service call carries them for a consumer (#315).
    const carries =
      row.kind === 'job_instructions' || (row.kind === 'job_received' && row.attachment === 'pdf')

    if (!carries) {
      return others(row)
    }

    if (row.jobId === null) {
      throw new MailDeliveryError(
        'Der Nachricht fehlt der Auftrag, um den es geht.',
        'EDOCUMENT',
        null,
        {
          permanent: true,
        },
      )
    }

    const jobId = row.jobId
    const printedFor = { tenantId: row.tenantId }

    try {
      const facts = await database.forTenant({ tenantId: row.tenantId, reason: 'mail' }, (tx) =>
        callPrintFacts(
          tx,
          jobId,
          row.earlyStartRequestId,
          berlinClock(row.createdAt).day,
          row.customerId,
        ),
      )

      return [
        {
          filename: 'Belehrungen.pdf',
          content: await files.printCallInstructions(facts, printedFor),
          contentType: 'application/pdf',
        },
      ]
    } catch (error) {
      if (error instanceof CallCustomerChanged) {
        throw new MailDeliveryError(reassignedCustomerMail, 'ECUSTOMER', null, { permanent: true })
      }

      const final = error instanceof CallInstructionsRefused

      throw new MailDeliveryError(
        `Der Anhang ließ sich nicht erzeugen: ${error instanceof Error ? error.message : String(error)}`,
        final ? 'EDOCUMENT' : 'EATTACHMENT',
        null,
        { permanent: final },
      )
    }
  }
}

/**
 * The files of a message, with the calendar file of an appointment (#315)
 * beside the others: made when the confirmation goes out, from the
 * appointment as it is then, so that a calendar holds what the board holds.
 * An appointment there is no trace of any more gives up the message.
 *
 * Made only for the customer the message was written for, asked on the read
 * the file is made from: the worker asks before, in a transaction of its own,
 * and a job given to another customer right after would carry the other's
 * place to the first one's address.
 */
export function withAppointmentInvitation(
  database: Database,
  others: AttachmentSource,
): AttachmentSource {
  return async (row) => {
    if (row.kind !== 'appointment_confirmation') {
      return others(row)
    }

    const appointmentId = row.appointmentId

    const file =
      appointmentId === null
        ? null
        : await database.forTenant({ tenantId: row.tenantId, reason: 'mail' }, (tx) =>
            appointmentInvitation(tx, row.tenantId, appointmentId as AppointmentId, {
              name: row.recipientName ?? row.recipientAddress,
              address: row.recipientAddress,
            }),
          )

    if (file === null) {
      throw new MailDeliveryError(
        'Den Termin dieser Nachricht gibt es nicht mehr.',
        'EDOCUMENT',
        null,
        {
          permanent: true,
        },
      )
    }

    if (row.customerId !== null && file.customerId !== row.customerId) {
      throw new MailDeliveryError(reassignedCustomerMail, 'ECUSTOMER', null, { permanent: true })
    }

    return [
      {
        filename: 'Termin.ics',
        content: new TextEncoder().encode(file.text),
        contentType: `text/calendar; charset=utf-8; method=${file.method}`,
      },
    ]
  }
}

/** Why a message to a customer restricted since it was written stays unsent. */
export const restrictedCustomerMail =
  'Der Kunde ist auf einen Antrag auf Löschung eingeschränkt. Die Nachricht geht deshalb nicht mehr hinaus.'

/** Why a message about a job that belongs to another customer now stays unsent. */
export const reassignedCustomerMail =
  'Der Auftrag gehört inzwischen zu einem anderen Kunden. Die Nachricht geht deshalb nicht mehr hinaus.'

/** Why an invoice that was to go as a PDF stays unsent once its transition ended. */
export const lapsedTransitionMail =
  'Diese Rechnung sollte als PDF hinausgehen, wie es der Übergang nach § 27 Abs. 38 UStG erlaubte. ' +
  'Der Übergang endete vor dem Versand, und eine Rechnung, die danach übermittelt wird, muss eine ' +
  'E-Rechnung sein. Dieser fehlen dafür Angaben, und was sie bei der Ausstellung festgeschrieben hat, ' +
  'ändert sich nicht mehr. Die Nachricht geht deshalb nicht hinaus: Die Rechnung lässt sich stornieren ' +
  'und mit den fehlenden Angaben neu stellen; welche das sind, sagt das Verschicken.'

/**
 * Why such an invoice stays unsent in the last minutes before its transition
 * ends: asked for while a PDF was still allowed, it would reach the mail
 * server only after midnight (`transmittedBy`). Until then sending it again
 * gives the same answer, from midnight on it names what is missing.
 */
export const closingTransitionMail =
  'Diese Rechnung sollte als PDF hinausgehen, wie es der Übergang nach § 27 Abs. 38 UStG erlaubt. ' +
  'Der Übergang endet um Mitternacht, und vorher erreicht die Nachricht den Mailserver nicht sicher; ' +
  'eine Rechnung, die danach übermittelt wird, muss eine E-Rechnung sein. Dieser fehlen dafür Angaben, ' +
  'und was sie bei der Ausstellung festgeschrieben hat, ändert sich nicht mehr. Die Nachricht geht ' +
  'deshalb nicht hinaus: Die Rechnung lässt sich stornieren und mit den fehlenden Angaben neu stellen; ' +
  'welche das sind, sagt das Verschicken ab Mitternacht.'

/**
 * How far ahead of the moment it asks the outbox looks for the end of a
 * transition, so that a message that passes the question cannot reach the
 * mail server after midnight. After the last question the way is bounded:
 * the question's own transaction, half a minute for a connection and two
 * minutes for each of its six statements (its begin, the settings of the
 * business, the frozen content, the claim of the transition twice, its
 * commit), fifteen seconds for the name of the server (`destinationOf`) and
 * two minutes for the message (`whole` in `smtpTransport`): 14 minutes 45
 * seconds at the most, so that the twenty leave room and are not to be cut.
 * The two minutes end the conversation with the server as well, not only the
 * wait for it (opengewerk#1036).
 */
const transmittingAhead = 20 * 60 * 1000

/**
 * The day a message sent from this moment reaches the mail server by, at the
 * latest, in Germany: the day the outbox asks the transition about.
 */
export function transmittedBy(now: Date): IsoDate {
  return todayInGermany(new Date(now.getTime() + transmittingAhead))
}

/**
 * Whether an invoice asked for as a PDF may still leave as one (#1018). The
 * transition of section 27 (38) UStG asks when an invoice is transmitted, and
 * the answer at the request (`attachmentFor`) holds for the day it was asked
 * for: a message asked for on the last day of the transition and sent after
 * midnight would carry a PDF the law no longer allows. So the worker asks
 * again, for the day it reaches the mail server by (`transmittedBy`), before
 * the file is made and once more after, and gives the message up with the
 * reason rather than send it: that the transition ended, or, asked on the
 * day it ends (`askedOn`), that it ends before the message would arrive. A
 * message whose invoice goes as an e-invoice, or whose customer needs none,
 * is not touched.
 */
export async function refuseLapsedTransition(
  database: Database,
  row: OutboxRow,
  sentOn: IsoDate = todayInGermany(),
  askedOn: IsoDate = sentOn,
): Promise<void> {
  if (row.kind !== 'document' || row.attachment !== 'pdf' || row.documentId === null) {
    return
  }

  const documentId = row.documentId as DocumentId
  const lapsed = await database.forTenant(
    { tenantId: row.tenantId, reason: 'mail' },
    async (tx) => {
      const content = await frozenContent(tx, documentId)

      if (content === null || formatFor(shippedRules, content).format !== 'e_invoice') {
        return false
      }

      if (!(await dutyOf(tx, content, sentOn)).required) {
        return false
      }

      // Ended already, or ending before the message reaches the server.
      return (await dutyOf(tx, content, askedOn)).required ? 'ended' : 'ending'
    },
  )

  if (lapsed !== false) {
    throw new MailDeliveryError(
      lapsed === 'ended' ? lapsedTransitionMail : closingTransitionMail,
      'ETRANSITION',
      null,
      { permanent: true },
    )
  }
}

/**
 * Whether a message to a customer may still go, asked by the worker of every
 * message as it leaves, with a file or without, before any file of it is
 * made. Not when its customer was restricted on a request for deletion since
 * it was written (Art. 18 DSGVO): raising a message asks that already
 * (#845). And not when what it is about belongs to another customer now: a
 * job given to somebody else after the mail was written, whose details its
 * file would carry to the address of the first. Given up on with the reason,
 * like a message whose document has no file to give.
 */
export async function refuseWithheldCustomerMail(
  database: Database,
  row: OutboxRow,
): Promise<void> {
  const reason = await database.forTenant(
    { tenantId: row.tenantId, reason: 'mail' },
    async (tx) => {
      const current = await customerOfMessage(tx, row)

      // A mail from before the customer was kept with it names none; its
      // customer is the one of what it is about.
      if (row.customerId !== null && current !== null && current !== row.customerId) {
        return reassignedCustomerMail
      }

      const customerId = row.customerId ?? current

      return customerId !== null && (await customerRestricted(tx, customerId))
        ? restrictedCustomerMail
        : null
    },
  )

  if (reason !== null) {
    throw new MailDeliveryError(
      reason,
      reason === restrictedCustomerMail ? 'ERESTRICTED' : 'ECUSTOMER',
      null,
      { permanent: true },
    )
  }
}

/** The cause of a reminder to a customer: `customer_reminder:<kind>:<customer>:<…>`. */
const reminderCause = /^customer_reminder:[^:]+:([0-9a-f-]{36}):/

/**
 * The customer a message is about, through what it names: its document, its
 * job or its appointment, and for a reminder its cause, which is all a
 * reminder names. Null for a message to somebody in the business, which
 * names none of them.
 */
async function customerOfMessage(tx: TenantTransaction, row: OutboxRow): Promise<string | null> {
  if (row.kind === 'customer_reminder') {
    return reminderCause.exec(row.cause)?.[1] ?? null
  }

  if (row.documentId !== null) {
    const [found] = await tx
      .select({ customerId: documents.customerId })
      .from(documents)
      .where(eq(documents.id, row.documentId))

    return found?.customerId ?? null
  }

  const jobId = row.jobId ?? (await jobOfMessage(tx, row))

  if (jobId === null) {
    return null
  }

  const [job] = await tx
    .select({ customerId: jobs.customerId })
    .from(jobs)
    .where(eq(jobs.id, jobId as JobId))

  return job?.customerId ?? null
}

/**
 * The job of a message that names its appointment instead. One about a request
 * for an early start names its job as well.
 */
async function jobOfMessage(tx: TenantTransaction, row: OutboxRow): Promise<string | null> {
  if (row.appointmentId !== null) {
    const [found] = await tx
      .select({ jobId: appointments.jobId })
      .from(appointments)
      .where(eq(appointments.id, row.appointmentId))

    return found?.jobId ?? null
  }

  return null
}

/**
 * The files of every message this application sends: what the worker of a
 * running instance is given, and a test that wants all of it.
 */
export function mailAttachments(files: DocumentFiles, database: Database): AttachmentSource {
  return withAppointmentInvitation(
    database,
    withCallInstructions(files, database, documentAttachments(files)),
  )
}
