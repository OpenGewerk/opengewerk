import { afterEach, describe, expect, it } from 'vitest'

import { checkMailServer } from './check.js'
import { unreachableName } from './reach.js'
import type { MailConfiguration } from './configuration.js'
import { closedPort, type FakeSmtpServer, fakeSmtpServer } from './test-smtp.js'
import { MailDeliveryError, type OutgoingMail, smtpTransport } from './transport.js'

/**
 * The one sender, against a mail server on this machine: what arrives, and
 * what a refusal, a silence and a closed port look like from this side. The
 * check behind "Verbindung prüfen" is held here as well, because it is the
 * same conversation cut short.
 */

const short = { connection: 800, greeting: 800, socket: 2_000 }

let server: FakeSmtpServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

function settings(port: number, over: Partial<MailConfiguration> = {}): MailConfiguration {
  return {
    host: '127.0.0.1',
    port,
    security: 'none',
    user: null,
    password: null,
    from: 'rechnung@nord.example.de',
    ...over,
  }
}

const letter: OutgoingMail = {
  from: { name: 'Elektro Nord GmbH', address: 'rechnung@nord.example.de' },
  replyTo: 'buero@nord.example.de',
  to: { name: 'Familie Berg', address: 'berg@example.de' },
  subject: 'Rechnung RE-2026-0042',
  text: 'Guten Tag,\n\nanbei die Rechnung.\n',
  attachments: [
    {
      filename: 'RE-2026-0042.pdf',
      content: new TextEncoder().encode('%PDF-1.7 stand-in'),
      contentType: 'application/pdf',
    },
  ],
}

async function failureOf(work: Promise<unknown>): Promise<MailDeliveryError> {
  try {
    await work
  } catch (error) {
    if (error instanceof MailDeliveryError) {
      return error
    }

    throw error
  }

  throw new Error('It went through, and it was expected not to.')
}

describe('a message', () => {
  it('arrives with its sender, its recipient and its attachment', async () => {
    server = await fakeSmtpServer()
    const transport = smtpTransport(settings(server.port), short)

    await transport.send(letter)
    transport.close()

    expect(server.received).toHaveLength(1)

    const [mail] = server.received

    expect(mail?.from).toBe('rechnung@nord.example.de')
    expect(mail?.to).toEqual(['berg@example.de'])
    expect(mail?.data).toContain('From: Elektro Nord GmbH <rechnung@nord.example.de>')
    expect(mail?.data).toContain('Reply-To: buero@nord.example.de')
    expect(mail?.data).toContain('Subject: Rechnung RE-2026-0042')
    expect(mail?.data).toMatch(/filename=RE-2026-0042\.pdf/)
    expect(mail?.data).toContain(Buffer.from('%PDF-1.7 stand-in').toString('base64'))
  })

  it('is refused for good when the server says a mailbox does not exist', async () => {
    server = await fakeSmtpServer({ refuse: ['berg@example.de'] })
    const transport = smtpTransport(settings(server.port), short)

    const failure = await failureOf(transport.send(letter))
    transport.close()

    expect(failure.code).toBe('EENVELOPE')
    expect(failure.permanent).toBe(true)
  })

  it('is no refusal of the sender when the server names the recipient (opengewerk#1102)', async () => {
    server = await fakeSmtpServer({ refuse: ['berg@example.de'] })
    const transport = smtpTransport(settings(server.port), short)

    const failure = await failureOf(transport.send(letter))
    transport.close()

    expect(failure).toMatchObject({ command: 'RCPT TO', refusedSender: false, permanent: true })
  })

  it.each([
    ['at MAIL FROM', { refuseSenders: ['rechnung@nord.example.de'] }, 'MAIL FROM'],
    [
      'at RCPT TO, as Postfix does',
      { refuseSendersAtRecipient: ['rechnung@nord.example.de'] },
      'RCPT TO',
    ],
  ] as const)(
    'is a refusal of the sender for now when the server turns it away %s (opengewerk#1102)',
    async (_where, options, command) => {
      server = await fakeSmtpServer(options)
      const transport = smtpTransport(settings(server.port), short)

      const failure = await failureOf(transport.send(letter))
      transport.close()

      expect(failure).toMatchObject({ command, refusedSender: true, permanent: false })
      expect(server.received).toEqual([])
    },
  )

  it('tells the sender from the recipient by what the server says, where both are one address (opengewerk#1102)', async () => {
    const toItself = { ...letter, to: { name: null, address: 'rechnung@nord.example.de' } }

    server = await fakeSmtpServer({ refuseSendersAtRecipient: ['rechnung@nord.example.de'] })
    const refusingSender = smtpTransport(settings(server.port), short)
    const sender = await failureOf(refusingSender.send(toItself))
    refusingSender.close()
    await server.close()

    server = await fakeSmtpServer({ refuse: ['rechnung@nord.example.de'] })
    const refusingRecipient = smtpTransport(settings(server.port), short)
    const recipient = await failureOf(refusingRecipient.send(toItself))
    refusingRecipient.close()

    expect(sender).toMatchObject({ refusedSender: true, permanent: false })
    expect(recipient).toMatchObject({ refusedSender: false, permanent: true })
  })

  it('is refused for now when the server takes the connection and says nothing', async () => {
    server = await fakeSmtpServer({ silent: true })
    const transport = smtpTransport(settings(server.port), short)

    const failure = await failureOf(transport.send(letter))
    transport.close()

    expect(failure.code).toBe('ETIMEDOUT')
    expect(failure.permanent).toBe(false)
  })

  /**
   * A server that takes the message and never says whether it took it, and
   * keeps the connection: the timeouts for a step and for silence did not end
   * that, and the job that sends the messages of every business waited for it.
   */
  it('is refused for now when the server does not take it within the time a message has', async () => {
    server = await fakeSmtpServer({ stallAfterData: true })
    const transport = smtpTransport(settings(server.port), { ...short, socket: 10_000, whole: 500 })
    const started = performance.now()

    const failure = await failureOf(transport.send(letter))
    transport.close()

    expect(failure.code).toBe('ETIMEDOUT')
    expect(failure.permanent).toBe(false)
    expect(performance.now() - started).toBeLessThan(3000)
  })

  /**
   * A server that answers every step in time, only DATA later than the time a
   * message has. Waiting less was not enough: nodemailer went on in the
   * background and the message arrived after the outbox had counted it as not
   * sent, to go out a second time (opengewerk#1036).
   */
  it('reaches the server no more once the time a message has is over', async () => {
    const slow = await fakeSmtpServer({ slowData: 600 })
    server = slow
    const transport = smtpTransport(settings(slow.port), { ...short, socket: 10_000, whole: 300 })

    const failure = await failureOf(transport.send(letter))

    expect(failure.code).toBe('ETIMEDOUT')
    expect(failure.permanent).toBe(false)
    // The deadline ran out while the server held back its answer to DATA,
    // not before: on a slow machine it can end earlier and prove nothing.
    expect(slow.reached.data).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 1_200))
    transport.close()

    expect(slow.received).toEqual([])
    expect(slow.open()).toBe(0)
  })

  /**
   * What still waits in this process when the time is over is dropped, not
   * handed to the server (`socketCloseTimeout: 0`). Ended the gentle way, a
   * server that stopped reading for a while got the whole message after the
   * deadline (opengewerk#1036, the review). The message is larger than what
   * the system takes from a socket that nobody reads.
   */
  it('drops what waits to go out once the time a message has is over', async () => {
    const late = await fakeSmtpServer({ readsLate: 1_500 })
    server = late
    const transport = smtpTransport(settings(late.port), { ...short, socket: 10_000, whole: 500 })
    const large: OutgoingMail = {
      ...letter,
      attachments: [
        {
          filename: 'Plan.pdf',
          content: new Uint8Array(32 * 1024 * 1024),
          contentType: 'application/pdf',
        },
      ],
    }

    const failure = await failureOf(transport.send(large))

    expect(failure.code).toBe('ETIMEDOUT')
    // The server asked for the message and stopped reading before the
    // deadline ran out (#1054).
    expect(late.reached).toEqual({ data: 1, pausedReading: 1 })

    await new Promise((resolve) => setTimeout(resolve, 3_000))
    transport.close()

    expect(late.received).toEqual([])
    expect(late.open()).toBe(0)
  })

  it('is refused for now when nothing listens on the port', async () => {
    const transport = smtpTransport(settings(await closedPort()), short)

    const failure = await failureOf(transport.send(letter))
    transport.close()

    expect(failure.permanent).toBe(false)
  })

  it('is refused for now, not for good, when the login fails', async () => {
    // A password being changed is a passing fault from the point of view of a
    // message. Given up on, the message would be lost over it.
    server = await fakeSmtpServer({ credentials: { user: 'rechnung', password: 'richtig' } })
    const transport = smtpTransport(
      settings(server.port, { user: 'rechnung', password: 'falsch' }),
      short,
    )

    const failure = await failureOf(transport.send(letter))
    transport.close()

    expect(failure.code).toBe('EAUTH')
    expect(failure.permanent).toBe(false)
  })
})

describe('the check of a mail server', () => {
  it('is satisfied by a server that greets and takes the login', async () => {
    server = await fakeSmtpServer({ credentials: { user: 'rechnung', password: 'richtig' } })
    const configuration = settings(server.port, { user: 'rechnung', password: 'richtig' })

    await expect(
      checkMailServer(smtpTransport(configuration, short), configuration),
    ).resolves.toEqual({ outcome: 'ready' })
  })

  it('names the login when the server refuses it', async () => {
    server = await fakeSmtpServer({ credentials: { user: 'rechnung', password: 'richtig' } })
    const configuration = settings(server.port, { user: 'rechnung', password: 'falsch' })
    const check = await checkMailServer(smtpTransport(configuration, short), configuration)

    expect(check.outcome).toBe('refused')
    expect(check.outcome === 'refused' ? check.reason : '').toContain(
      'Stimmen Benutzername und Passwort?',
    )
  })

  it('names the server when its name does not exist', async () => {
    const configuration = settings(25, { host: 'kein-mailserver.invalid' })
    const check = await checkMailServer(smtpTransport(configuration, short), configuration)

    expect(check.outcome).toBe('refused')
    expect(check.outcome === 'refused' ? check.reason : '').toBe(
      unreachableName('kein-mailserver.invalid'),
    )
  })

  it('says that nobody answers, and that server or port may be wrong', async () => {
    const configuration = settings(await closedPort())
    const check = await checkMailServer(smtpTransport(configuration, short), configuration)

    expect(check.outcome).toBe('unreachable')
    expect(check.outcome === 'unreachable' ? check.reason : '').toContain(
      'vielleicht stimmen Server oder Port nicht',
    )
  })

  it('counts a server that hangs as one that does not answer', async () => {
    server = await fakeSmtpServer({ silent: true })
    const configuration = settings(server.port)
    const check = await checkMailServer(smtpTransport(configuration, short), configuration)

    expect(check.outcome).toBe('unreachable')
  })
})

describe('a refusal that does not come from the server', () => {
  it('is for good when whoever raised it says so, whatever its code', () => {
    expect(
      new MailDeliveryError('Die Datei fehlt.', 'EFILE', null, { permanent: true }).permanent,
    ).toBe(true)
    expect(new MailDeliveryError('Die Datei fehlt.', 'EFILE', null).permanent).toBe(false)
  })

  it('is for good for a destination or an invitation, which do not change by waiting', () => {
    expect(new MailDeliveryError('Intern.', 'EDESTINATION', null).permanent).toBe(true)
    expect(new MailDeliveryError('Abgelaufen.', 'EINVITATION', null).permanent).toBe(true)
  })
})
