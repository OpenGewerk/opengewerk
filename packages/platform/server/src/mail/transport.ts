import { domainToASCII } from 'node:url'

import { createTransport } from 'nodemailer'

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

/**
 * Whether a refusal is about the sender of the mail (opengewerk#1102). At
 * `MAIL FROM` it is. At `RCPT TO` it is where the answer names the sender in
 * angle brackets and not the recipient, as Postfix does: "553 5.7.1
 * <post@nord.example.de>: Sender address rejected". A recipient it refuses
 * it names as well, and that stays a refusal of the message. Where both are
 * one address, a mail of the instance to its own mailbox, the answer says
 * which side it means. An address with a domain in umlauts the server names
 * as nodemailer sent it, with the domain as its A-label.
 */
function aboutTheSender(
  command: string | null,
  answer: string,
  mail: OutgoingMail | undefined,
): boolean {
  if (command === 'MAIL FROM') {
    return true
  }

  if (command !== 'RCPT TO' || mail === undefined) {
    return false
  }

  const said = answer.toLowerCase()
  const sender = bracketed(mail.from.address)
  const recipient = bracketed(mail.to.address)
  const names = (forms: readonly string[]) => forms.some((form) => said.includes(form))

  if (!names(sender)) {
    return false
  }

  return sender[0] === recipient[0]
    ? said.includes('sender') && !said.includes('recipient')
    : !names(recipient)
}

/**
 * An address in angle brackets as a server may name it in an answer: as it
 * is stored, and with its domain as the A-label nodemailer sends,
 * `xn--mller-elektro-wob.de` for `müller-elektro.de`. Small letters both.
 */
function bracketed(address: string): readonly [string, ...string[]] {
  const stored = address.toLowerCase()
  const at = stored.lastIndexOf('@')
  const domain = at < 0 ? '' : stored.slice(at + 1)
  const label = domain === '' ? '' : domainToASCII(domain)
  const sent = label === '' || label === domain ? stored : `${stored.slice(0, at)}@${label}`

  return sent === stored ? [`<${stored}>`] : [`<${stored}>`, `<${sent}>`]
}

function asDeliveryError(error: unknown, mail?: OutgoingMail): MailDeliveryError {
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
    { command, refusedSender: aboutTheSender(command, answer, mail) },
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
      const deadline = new AbortController()
      const timer = setTimeout(() => {
        deadline.abort()
      }, timeouts.whole ?? defaultTimeouts.whole)

      try {
        await transport.sendMail({
          from: { name: mail.from.name, address: mail.from.address },
          replyTo: mail.replyTo ?? undefined,
          to: mail.to.name ? { name: mail.to.name, address: mail.to.address } : mail.to.address,
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

        throw asDeliveryError(error, mail)
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
