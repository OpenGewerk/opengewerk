import { createTransport } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'

import type { MailConfiguration } from './configuration.js'

/** A file that goes along with a message. */
export interface MailAttachment {
  readonly filename: string
  readonly content: Uint8Array
  readonly contentType: string
}

/** One message as it leaves, fully put together. */
export interface OutgoingMail {
  readonly from: { readonly name: string; readonly address: string }
  readonly replyTo: string | null
  readonly to: { readonly name: string | null; readonly address: string }
  readonly subject: string
  readonly text: string
  readonly attachments: readonly MailAttachment[]
}

/**
 * Why a message did not go out, with what the mail server or the connection
 * said. `code` is nodemailer's (`EAUTH`, `ETIMEDOUT`, `EDNS` and so on), and
 * `responseCode` the three digits of the server's answer when there was one.
 *
 * Whoever raises one while putting a message together knows sometimes that
 * trying again cannot help, and says so with `permanent`: a file the message
 * is about that cannot be made out of content that will not change.
 */
export class MailDeliveryError extends Error {
  private readonly declaredPermanent: boolean

  /**
   * The command of the conversation the server answered with the refusal,
   * `MAIL FROM` for a sender it does not take, `RCPT TO` for a recipient;
   * null where none was under way.
   */
  readonly command: string | null

  /**
   * Whether the server turned the sender away (opengewerk#1102): at
   * `MAIL FROM`, or at `RCPT TO` with an answer about the sender, as Postfix
   * gives it in its default of answering every restriction there.
   */
  readonly refusedSender: boolean

  constructor(
    message: string,
    readonly code: string | null,
    readonly responseCode: number | null,
    options: {
      readonly permanent?: boolean
      readonly command?: string | null
      readonly refusedSender?: boolean
    } = {},
  ) {
    super(message)
    this.declaredPermanent = options.permanent ?? false
    this.command = options.command ?? null
    this.refusedSender = options.refusedSender ?? this.command === 'MAIL FROM'
  }

  /**
   * Whether trying again cannot help. A server that says no with a five
   * hundred to a recipient, or an address nobody can deliver to, will say the
   * same an hour later. Everything else, a timeout, a refused connection, a
   * login that failed because somebody is changing the password, may be gone
   * by then, and giving up on it would lose a message over a passing fault.
   */
  get permanent(): boolean {
    // `EINVITATION`: an invitation that was called back, used or has run out
    // gives no link, and it does not become open again. `EDESTINATION`: a
    // mail server in an internal network or on a port that is not for mail
    // stays where it is until somebody changes the settings.
    // A sender the server does not take is about the settings, not the
    // message (opengewerk#1102), and is tried again like a server that does
    // not take anything right now: up to the last attempt of the outbox.
    // nodemailer calls it an envelope error as well.
    if (this.refusedSender && !this.declaredPermanent) {
      return false
    }

    // An envelope the server turned down for now, with a four hundred, is
    // tried again: greylisting, a mailbox that is full this hour
    // (opengewerk#1103).
    const forNow = this.responseCode !== null && this.responseCode >= 400 && this.responseCode < 500

    if (
      this.declaredPermanent ||
      (this.code === 'EENVELOPE' && !forNow) ||
      this.code === 'EINVITATION' ||
      this.code === 'EDESTINATION'
    ) {
      return true
    }

    return (
      this.code !== 'EAUTH' &&
      this.responseCode !== null &&
      this.responseCode >= 500 &&
      this.responseCode < 600
    )
  }
}

/**
 * The one thing that talks to a mail server.
 *
 * Everything else writes a row into an outbox, and a test holds that nothing
 * but this file imports nodemailer. So there is one sender, one set of
 * timeouts and one place to look when a message did not arrive.
 */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>
  /** Connects, greets and signs in, and sends nothing. For the check of a connection. */
  verify(): Promise<void>
  close(): void
}

/** The addresses of a message as nodemailer sends them after `MAIL FROM` and `RCPT TO`. */
interface SentEnvelope {
  readonly from: string
  readonly to: readonly string[]
}

/**
 * The envelope nodemailer makes out of the same fields the message is sent
 * with. It puts a local part in quotes, escapes what needs it, drops what it
 * does not send and writes a domain as an A-label or a U-label; doing that
 * again here went wrong for more than one address (opengewerk#1102). Null
 * where it cannot make one, and then the message never reached a server.
 */
function sentEnvelope(addresses: {
  readonly from: { readonly name: string; readonly address: string }
  readonly to: { readonly name: string; readonly address: string }
}): SentEnvelope | null {
  try {
    const envelope = new MailComposer(addresses).compile().getEnvelope()

    return {
      from: typeof envelope.from === 'string' ? envelope.from.trim() : '',
      to: envelope.to.map((address) => address.trim()),
    }
  } catch {
    return null
  }
}

/**
 * Whether a refusal is about the sender of the mail (opengewerk#1102). At
 * `MAIL FROM` it is. At `RCPT TO` it is where every address the answer names
 * in angle brackets is the sender as it was sent, as Postfix answers: "553
 * 5.7.1 <post@nord.example.de>: Sender address rejected". A recipient it
 * refuses it names as well, in the form nodemailer sent it, which need not be
 * the one stored: `"max..mustermann"@example.de`. So an answer that names any
 * other address stays a refusal of the message. Where sender and recipient
 * went out as one address, the words of the answer outside the addresses say
 * which side it means, since an address may hold either word itself.
 */
function aboutTheSender(
  command: string | null,
  answer: string,
  envelope: SentEnvelope | null,
): boolean {
  if (command === 'MAIL FROM') {
    return true
  }

  if (command !== 'RCPT TO' || envelope === null) {
    return false
  }

  const said = answer.toLowerCase()
  const named = addressesIn(said)
  const sender = `<${envelope.from.toLowerCase()}>`

  if (named.length === 0 || !named.every((address) => address === sender)) {
    return false
  }

  if (envelope.to.some((address) => `<${address.toLowerCase()}>` === sender)) {
    const words = said.replace(/<[^<>]*>/g, ' ')

    return words.includes('sender') && !words.includes('recipient')
  }

  return true
}

/**
 * The parts of an answer in angle brackets that hold an "@", each with its
 * brackets. Read once from left to right, without a pattern: the answer comes
 * from the server of a tenant.
 */
function addressesIn(said: string): string[] {
  const found: string[] = []
  let at = 0

  for (;;) {
    const open = said.indexOf('<', at)
    const close = open < 0 ? -1 : said.indexOf('>', open + 1)

    if (close < 0) {
      break
    }

    // A bracket opened again before it closes starts the address: "<<a@b>".
    const inner = said.lastIndexOf('<', close)
    const part = said.slice(inner, close + 1)

    if (part.includes('@')) {
      found.push(part)
    }

    at = close + 1
  }

  return found
}

function asDeliveryError(error: unknown, envelope: SentEnvelope | null = null): MailDeliveryError {
  if (error instanceof MailDeliveryError) {
    return error
  }

  const detail = (error ?? {}) as {
    message?: unknown
    code?: unknown
    responseCode?: unknown
    command?: unknown
    response?: unknown
  }
  const message = typeof detail.message === 'string' ? detail.message : String(error)
  const command = typeof detail.command === 'string' ? detail.command : null
  const answer = typeof detail.response === 'string' ? detail.response : message

  return new MailDeliveryError(
    message,
    typeof detail.code === 'string' ? detail.code : null,
    typeof detail.responseCode === 'number' ? detail.responseCode : null,
    { command, refusedSender: aboutTheSender(command, answer, envelope) },
  )
}

/** How long the transport waits, in milliseconds. A test shortens them. */
export interface MailTimeouts {
  readonly connection: number
  readonly greeting: number
  readonly socket: number
  /**
   * How long one message has, from the connection to the server's answer
   * that it took it. The other three wait for a step and for silence; a
   * server that answers a little at a time never runs into them, and the job
   * that sends the messages of every business one after the other waited for
   * it without end.
   */
  readonly whole?: number
}

const defaultTimeouts: Required<MailTimeouts> = {
  connection: 15_000,
  greeting: 15_000,
  socket: 60_000,
  whole: 120_000,
}

/**
 * The transport for a configured instance.
 *
 * Timeouts are short on purpose. nodemailer waits two minutes for a greeting
 * by default, and a job that sends one message after the other would sit for
 * that long on every message while the server is gone; the outbox is what
 * waits, not the connection.
 *
 * File and URL access are switched off. Attachments are handed over as bytes,
 * and a message is never meant to make this process read a path or fetch an
 * address named somewhere in its content.
 */
export function smtpTransport(
  configuration: MailConfiguration,
  timeouts: MailTimeouts = defaultTimeouts,
): MailTransport {
  const transport = createTransport({
    host: configuration.host,
    // The name behind an address, for TLS. The connection goes to the address
    // that was checked and the certificate is still held against the name.
    servername: configuration.servername,
    port: configuration.port,
    secure: configuration.security === 'tls',
    requireTLS: configuration.security === 'starttls',
    ignoreTLS: configuration.security === 'none',
    auth:
      configuration.user !== null && configuration.password !== null
        ? { user: configuration.user, pass: configuration.password }
        : undefined,
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
    // A connection that ends is torn down at once. Ended the gentle way, the
    // socket would still hand the server what waits in this process, and
    // after the deadline of a message that can be all of it. What the system
    // has taken already goes out either way.
    socketCloseTimeout: 0,
    disableFileAccess: true,
    disableUrlAccess: true,
  })

  return {
    async send(mail) {
      // The deadline ends the conversation with the server, not only the wait
      // for it: nodemailer drops the connection of a send that is called off,
      // and what of the message has not left this process by then never
      // reaches the server (opengewerk#1036). What has left it, the system
      // still delivers: a message of a few hundred kilobytes has mostly left
      // right after the server asked for it, and a server that takes it then
      // has it, although the outbox counts it as not sent.
      // Objects, with an empty name where there is none: a bare text
      // nodemailer reads with its parser, which takes `a(b)@example.de` for
      // `a@example.de`, and the same address reached another mailbox without
      // a name than with one (opengewerk#1104).
      const addresses = {
        from: { name: mail.from.name, address: mail.from.address },
        to: { name: mail.to.name ?? '', address: mail.to.address },
      }
      const deadline = new AbortController()
      const timer = setTimeout(() => {
        deadline.abort()
      }, timeouts.whole ?? defaultTimeouts.whole)

      try {
        await transport.sendMail({
          from: addresses.from,
          replyTo: mail.replyTo ? { name: '', address: mail.replyTo } : undefined,
          to: addresses.to,
          subject: mail.subject,
          text: mail.text,
          attachments: mail.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: Buffer.from(attachment.content),
            contentType: attachment.contentType,
          })),
          signal: deadline.signal,
        })
      } catch (error) {
        if (deadline.signal.aborted) {
          throw new MailDeliveryError(
            'Der Mailserver hat die Nachricht nicht in der Zeit angenommen, die eine Nachricht hat.',
            'ETIMEDOUT',
            null,
          )
        }

        throw asDeliveryError(error, sentEnvelope(addresses))
      } finally {
        clearTimeout(timer)
      }
    },
    async verify() {
      try {
        await transport.verify()
      } catch (error) {
        throw asDeliveryError(error)
      }
    },
    close() {
      transport.close()
    },
  }
}
