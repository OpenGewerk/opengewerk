import { createServer, type Server, type Socket } from 'node:net'

/** A message as the fake server received it: the envelope and the raw text. */
export interface ReceivedMail {
  readonly from: string
  readonly to: readonly string[]
  readonly data: string
}

export interface FakeSmtpOptions {
  /** When set, the server asks for a login and takes only this one. */
  readonly credentials?: { readonly user: string; readonly password: string }
  /** Takes the connection and never says a word, the way a hung server does. */
  readonly silent?: boolean
  /** Recipients refused with a 550, the answer for a mailbox that does not exist. */
  readonly refuse?: readonly string[]
  /** Senders refused with a 553, the answer for an address the login may not send from. */
  readonly refuseSenders?: readonly string[]
  /**
   * The same, and only at RCPT TO, as Postfix answers by default: every
   * restriction waits for the recipient (`smtpd_delay_reject`).
   */
  readonly refuseSendersAtRecipient?: readonly string[]
  /**
   * Recipients refused with an answer that names the sender as well, as an
   * access rule of a server may.
   */
  readonly refuseNamingBoth?: readonly string[]
  /** Recipients turned down for now with a 450, the answer of greylisting. */
  readonly defer?: readonly string[]
  /** Recipients refused with an answer that names no address, as Exim and Exchange answer. */
  readonly refuseWithoutAddress?: readonly string[]
  /** Recipients refused with an answer that names the sender alone, as the one to ask. */
  readonly refuseNamingSender?: readonly string[]
  /** Takes a message and never says whether it took it, the way a server that hangs over one does. */
  readonly stallAfterData?: boolean
  /** Milliseconds it waits before it answers DATA, the way a server that is slow to take a message does. */
  readonly slowData?: number
  /** Milliseconds it stops reading once it asked for the message, the way a server behind a slow line takes it. */
  readonly readsLate?: number
}

export interface FakeSmtpServer {
  readonly port: number
  readonly received: readonly ReceivedMail[]
  /** How many connections are open right now. */
  open(): number
  /**
   * How far the conversations got (#1054): how often a sender said DATA,
   * counted as it says it, before any wait of `slowData`, and how often the
   * server stopped reading for `readsLate`. A test of a deadline shows with
   * them that it reached the part it is about, and did not run out before.
   */
  readonly reached: { readonly data: number; readonly pausedReading: number }
  close(): Promise<void>
}

/**
 * A mail server for the tests, on a free port of this machine.
 *
 * Just enough SMTP for nodemailer without TLS: the greeting, EHLO, a plain
 * login when asked for, the envelope, the data and goodbye. The real protocol
 * has more; a test needs to see what arrived and how a refusal and a silence
 * look to the sender, and a dependency that speaks all of SMTP would bring its
 * own types into conflict with the ones nodemailer ships.
 */
export async function fakeSmtpServer(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const received: ReceivedMail[] = []
  const sockets = new Set<Socket>()
  const reached = { data: 0, pausedReading: 0 }

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)

    if (options.silent) {
      return
    }

    let buffer = ''
    let inData = false
    let from = ''
    let to: string[] = []
    let lines: string[] = []
    let signedIn = options.credentials === undefined

    const say = (line: string) => {
      socket.write(`${line}\r\n`)
    }

    say('220 opengewerk-test ESMTP')

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')

      let end = buffer.indexOf('\r\n')

      while (end !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf('\r\n')

        if (inData) {
          if (line === '.') {
            inData = false
            received.push({ from, to, data: lines.join('\r\n') })

            if (!options.stallAfterData) {
              say('250 2.0.0 Ok: queued')
            }
          } else {
            lines.push(line.startsWith('..') ? line.slice(1) : line)
          }

          continue
        }

        const command = line.slice(0, 4).toUpperCase()

        if (command === 'EHLO' || command === 'HELO') {
          say('250-opengewerk-test')

          if (options.credentials) {
            say('250-AUTH PLAIN')
          }

          say('250 8BITMIME')
        } else if (command === 'AUTH') {
          const [, , encoded] = line.split(' ')
          const [, user, password] = Buffer.from(encoded ?? '', 'base64')
            .toString('utf8')
            .split('\u0000')

          if (user === options.credentials?.user && password === options.credentials?.password) {
            signedIn = true
            say('235 2.7.0 Authentication successful')
          } else {
            say('535 5.7.8 Authentication credentials invalid')
          }
        } else if (command === 'MAIL') {
          if (!signedIn) {
            say('530 5.7.0 Authentication required')
          } else if (options.refuseSenders?.includes(/<([^>]*)>/.exec(line)?.[1] ?? '')) {
            say('553 5.7.1 Sender address rejected: not owned by user')
          } else {
            from = /<([^>]*)>/.exec(line)?.[1] ?? ''
            to = []
            say('250 2.1.0 Ok')
          }
        } else if (command === 'RCPT') {
          const recipient = /<([^>]*)>/.exec(line)?.[1] ?? ''

          if (options.refuseSendersAtRecipient?.includes(from)) {
            say(`553 5.7.1 <${from}>: Sender address rejected: not owned by user`)
          } else if (options.refuseNamingBoth?.includes(recipient)) {
            say(
              `554 5.7.1 <${recipient}>: Recipient address rejected: Access denied; from=<${from}> to=<${recipient}>`,
            )
          } else if (options.refuseWithoutAddress?.includes(recipient)) {
            say('550 5.1.1 User unknown')
          } else if (options.refuseNamingSender?.includes(recipient)) {
            say(`550 5.1.1 Recipient unknown; contact <${from}>`)
          } else if (options.defer?.includes(recipient)) {
            say(`450 4.2.0 <${recipient}>: Recipient address rejected: Greylisted, try again later`)
          } else if (options.refuse?.includes(recipient)) {
            say(`550 5.1.1 <${recipient}>: Recipient address rejected: User unknown`)
          } else {
            to.push(recipient)
            say('250 2.1.5 Ok')
          }
        } else if (command === 'DATA') {
          lines = []
          reached.data += 1

          const takeData = () => {
            if (socket.destroyed) {
              return
            }

            inData = true
            say('354 End data with <CR><LF>.<CR><LF>')

            if (options.readsLate !== undefined) {
              reached.pausedReading += 1
              socket.pause()
              setTimeout(() => {
                socket.resume()
              }, options.readsLate)
            }
          }

          if (options.slowData === undefined) {
            takeData()
          } else {
            setTimeout(takeData, options.slowData)
          }
        } else if (command === 'RSET' || command === 'NOOP') {
          say('250 2.0.0 Ok')
        } else if (command === 'QUIT') {
          say('221 2.0.0 Bye')
          socket.end()
        } else {
          say('502 5.5.2 Command not recognized')
        }
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('The fake mail server has no port.')
  }

  return {
    port: address.port,
    received,
    open: () => sockets.size,
    reached,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy()
        }

        server.close(() => {
          resolve()
        })
      }),
  }
}

/** A port on this machine where nothing listens, for a refused connection. */
export async function closedPort(): Promise<number> {
  const server = createServer()

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()

  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (address === null || typeof address === 'string') {
    throw new Error('No port came back.')
  }

  return address.port
}
