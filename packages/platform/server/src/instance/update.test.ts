import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type InstanceUpdateView, laterVersion } from '@opengewerk/platform-domain'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  type ProbeFoundation,
  probeFoundation,
  type ProbeInstance,
  probeInstance,
  probeOrigin as origin,
  type ProbeVisitors,
  probeVisitors,
} from '../authentication/probe-application.js'
import { addStaffMember } from '../authentication/staff.js'
import { Database } from '../database/database.js'
import type { MailContext } from '../mail/context.js'
import { type FakeSmtpServer, fakeSmtpServer } from '../mail/test-smtp.js'
import { MailDeliveryError, smtpTransport } from '../mail/transport.js'
import { SecretKey } from '../secrets/key.js'
import { probeAccess } from '../authentication/probe-application.js'
import type { AccountMessages } from './account-mail.js'
import { saveInstanceMailServer } from './mail-server.js'
import { appointOperator, removeOperator } from './operators.js'
import {
  type InstanceUpdates,
  markUpdateTold,
  readInstanceUpdate,
  releaseNotes,
  requestInstanceUpdate,
  stillTelling,
  updateTold,
} from './update.js'
import { updateNotices } from '../schema.js'
import { recordFinishedUpdate, reportFinishedUpdate } from './update-reports.js'

/**
 * The update of the instance from its area (opengewerk#1093), on the side of
 * the application: what it reads from the service for updates and holds to
 * its shape, who may ask for an update and only after confirming, what the
 * request says, and that everybody who runs the instance is told once how
 * an update ended.
 */

const password = 'ein-ordentlich-langes-passwort'
const setupCode = 'K7Q4-9PXM'
const mailPassword = 'mail-passwort'
const key = SecretKey.from('u'.repeat(64))

/** Sets the instance up, and so runs it. */
const lea = { email: 'lea@nord.example.de', name: 'Lea Leitung' }
/** Leads the first tenant, and runs nothing. */
const otto = { email: 'otto@nord.example.de', name: 'Otto Zweitleitung' }

const unconfirmed = 'Die Instanz wird erst nach der Bestätigung mit Passwort und Code aktualisiert.'

const messages: AccountMessages = {
  senderName: 'Probewerk',
  accountPath: '/konto',
  passwordReset: ({ name }) => ({ subject: 'Passwort', body: name }),
  passkeyAdded: ({ name }) => ({ subject: 'Passkey', body: name }),
  recoveryCodesRenewed: ({ name }) => ({ subject: 'Codes', body: name }),
  secondFactorChanged: ({ name }) => ({ subject: 'Faktor', body: name }),
  addressConfirmation: ({ name }) => ({ subject: 'Adresse', body: name }),
  addressChanged: ({ name }) => ({ subject: 'Adresse', body: name }),
  operatorsChanged: ({ name }) => ({ subject: 'Verwaltung', body: name }),
  mailServerChanged: ({ name }) => ({ subject: 'Mailserver', body: name }),
  instanceUpdated: ({ name, version, from, succeeded, step, by }) => ({
    subject: `Aktualisierung auf ${version} ${succeeded ? 'durch' : 'abgebrochen'}`,
    body: `Hallo ${name}, von ${from ?? '?'} auf ${version}, Schritt ${step}, angestoßen von ${by}.`,
  }),
}

let foundation: ProbeFoundation
let admin: Pool
let instance: ProbeInstance
let visitors: ProbeVisitors
let database: Database
let smtp: FakeSmtpServer
let mail: MailContext
let folders: string
let updates: InstanceUpdates

const signedIn = new Map<string, string>()
const userIds = new Map<string, string>()
const as = (person: { email: string }) => signedIn.get(person.email) ?? ''

function get(path: string, person?: { email: string }) {
  const asking = instance.http().get(path)

  return person ? asking.set('cookie', as(person)) : asking
}

function post(path: string, person: { email: string }, body: object) {
  return instance.http().post(path).set('cookie', as(person)).set('origin', origin).send(body)
}

const message = (answer: { body: unknown }) => (answer.body as { message: string }).message

/** A file of the service, as it writes them. */
function written(name: string, content: unknown): void {
  writeFileSync(
    join(updates.statusPath, name),
    typeof content === 'string' ? content : JSON.stringify(content),
  )
}

const notes = [
  '> Diese Fassung schließt eine Sicherheitslücke.',
  '',
  '### Behoben',
  '',
  '- Die Zeile des **Notdienstzuschlags** rechnet sich neu',
  '  nach einem Abgleich.',
  '',
  '### Sicherheit',
  '',
  '- Ein Link zum Zurücksetzen galt weiter, siehe [#1080](https://github.com/x/y/issues/1080).',
  '',
  '## Installieren und aktualisieren',
  '',
  '### Nicht mehr',
  '',
  '- `sh docker/start.sh`',
].join('\n')

/** The service as it writes after looking: alive, with 0.3.1 as the newest and the instance ready. */
function serviceFound(over: Record<string, unknown> = {}, alive = new Date()): void {
  written('alive', `${alive.toISOString()}\n`)
  written('available.json', {
    checked_at: '2026-11-24T03:12:00Z',
    mode: 'ready',
    reason: null,
    installed: '0.3.0',
    latest: '0.3.1',
    published_at: '2026-12-02T10:00:00Z',
    url: 'https://github.com/OpenGewerk/opengewerk/releases/tag/v0.3.1',
    notes,
    error: null,
    ...over,
  })
}

function cleared(): void {
  for (const path of [updates.requestsPath, updates.statusPath]) {
    for (const name of readdirSync(path)) {
      rmSync(join(path, name), { force: true })
    }
  }
}

async function view(): Promise<InstanceUpdateView> {
  return (await get('/instance/update', lea).expect(200)).body as InstanceUpdateView
}

/** The request as written, null where there is none; one that is not whole fails the test. */
function requestFile(): Record<string, unknown> | null {
  let written: string

  try {
    written = readFileSync(join(updates.requestsPath, 'request.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }

  return JSON.parse(written) as Record<string, unknown>
}

/** What afterAll closes, each put here once it is open, and closed last first. */
const opened: (() => unknown)[] = []

beforeAll(async () => {
  foundation = await probeFoundation()
  opened.push(() => {
    foundation.remove()
  })
  admin = await foundation.kit.connect()
  opened.push(
    () => admin.end(),
    () => foundation.kit.resetSchema(admin),
  )
  await foundation.empty()

  folders = mkdtempSync(join(tmpdir(), 'instance-update-'))
  opened.push(() => {
    rmSync(folders, { recursive: true, force: true })
  })
  updates = { requestsPath: join(folders, 'requests'), statusPath: join(folders, 'status') }
  for (const path of [updates.requestsPath, updates.statusPath]) {
    mkdirSync(path)
  }

  const url = foundation.kit.applicationDatabaseUrl()

  smtp = await fakeSmtpServer({ credentials: { user: 'instanz', password: mailPassword } })
  opened.push(() => smtp.close())
  mail = { origin, key, connect: (configuration) => smtpTransport(configuration) }
  database = Database.connect(url)
  opened.push(() => database.close())
  instance = await probeInstance(url, {
    setupCode,
    mail,
    version: '0.3.0',
    instanceUpdates: updates,
  })
  opened.push(() => instance.close())
  visitors = probeVisitors(instance, password)

  await instance
    .http()
    .post('/setup')
    .set('origin', origin)
    .send({ setupCode, company: 'Mandant Nord', name: lea.name, email: lea.email, password })
    .expect(201)

  const { rows: tenants } = await admin.query<{ id: string }>('select id from tenants')

  await addStaffMember(instance.authentication, instance.database, {
    ...otto,
    password,
    tenantId: tenants[0]?.id as never,
    roles: ['lead'],
  })

  await visitors.setUpSecondFactor(lea.email)
  await visitors.setUpSecondFactor(otto.email)

  for (const person of [lea, otto]) {
    signedIn.set(person.email, await visitors.signIn(person.email))
  }

  const { rows: users } = await admin.query<{ id: string; email: string }>(
    'select id, email from auth_users',
  )
  for (const user of users) {
    userIds.set(user.email, user.id)
  }
}, 60_000)

// Each on its own, so that one that fails, or a beforeAll that stopped half
// way, leaves nothing else open.
afterAll(async () => {
  const failed: unknown[] = []

  for (const close of opened.reverse()) {
    try {
      await close()
    } catch (error) {
      failed.push(error)
    }
  }

  if (failed.length > 0) {
    throw new AggregateError(failed, 'Nicht alles ließ sich nach den Tests schließen.')
  }
})

beforeEach(() => {
  cleared()
})

describe('the notes of a release', () => {
  it('are the parts of the changelog, Sicherheit first, without the hint, the installation or marks', () => {
    expect(releaseNotes(notes)).toEqual([
      {
        title: 'Sicherheit',
        security: true,
        items: ['Ein Link zum Zurücksetzen galt weiter, siehe #1080.'],
      },
      {
        title: 'Behoben',
        security: false,
        items: ['Die Zeile des Notdienstzuschlags rechnet sich neu nach einem Abgleich.'],
      },
    ])
  })

  it('keep the part Sicherheit when there are more parts than are shown', () => {
    const many = Array.from({ length: 14 }, (_, index) => `### Teil ${String(index)}\n\n- Punkt`)

    const shown = releaseNotes(
      [...many, '### Sicherheit', '', '- Eine Lücke geschlossen.'].join('\n'),
    )

    expect(shown).toHaveLength(12)
    expect(shown[0]).toMatchObject({ title: 'Sicherheit', security: true })
  })

  it('take a link as its words, an image as its description, and brackets that open no link as they stand', () => {
    expect(
      releaseNotes(
        [
          '### Neu',
          '',
          '- Siehe [die Hilfe](https://example.org/hilfe) und ![das Bild](bild.png).',
          '- Ein [Hinweis] ohne Link, [a [b] c](u) und [offen(',
          '*  Mit Stern',
          '+\tMit Plus',
          '-ohne Abstand gehört zum Punkt davor',
          '#### Tiefer gehört auch dazu',
        ].join('\n'),
      ),
    ).toEqual([
      {
        title: 'Neu',
        security: false,
        items: [
          'Siehe die Hilfe und das Bild.',
          'Ein [Hinweis] ohne Link, [a [b] c](u) und [offen(',
          'Mit Stern',
          'Mit Plus -ohne Abstand gehört zum Punkt davor #### Tiefer gehört auch dazu',
        ],
      },
    ])
  })

  // Notes from a page on GitHub, read in time that grows with the line and
  // not with its square (CodeQL, js/polynomial-redos).
  it('read a line of nothing but brackets or white space at once', () => {
    const long = 50_000
    const shown = releaseNotes(
      [
        `### ${'\t'.repeat(long)}Lang`,
        `- ${'['.repeat(long)}`,
        `- ${'[]('.repeat(long)}`,
        `- ${'![a]('.repeat(long)}`,
      ].join('\n'),
    )

    expect(shown).toEqual([
      {
        title: 'Lang',
        security: false,
        items: ['['.repeat(1000), '[]('.repeat(334).slice(0, 1000), '![a]('.repeat(200)],
      },
    ])
  }, 2000)

  // A point that goes on over many lines is read once, not again with every
  // line (the security review of opengewerk#1093).
  it('read a point of many lines at once', () => {
    const lines = 30_000
    const shown = releaseNotes(`### Sicherheit\n- x\n${'a\n'.repeat(lines)}`)

    expect(shown).toEqual([
      {
        title: 'Sicherheit',
        security: true,
        items: [`x${' a'.repeat(lines)}`.slice(0, 1000)],
      },
    ])
  }, 2000)

  it('compare their versions by number and not as text', () => {
    expect(laterVersion('0.10.0', '0.9.9')).toBe(true)
    expect(laterVersion('0.9.9', '0.10.0')).toBe(false)
    expect(laterVersion('1.0.0', '1.0.0')).toBe(false)
  })

  it('put a release after a pre-release of the same numbers, and before the next numbers', () => {
    expect(laterVersion('0.3.0', '0.3.0-rc.1')).toBe(true)
    expect(laterVersion('0.3.0-rc.1', '0.3.0')).toBe(false)
    expect(laterVersion('0.3.1', '0.3.0-rc.1')).toBe(true)
    expect(laterVersion('0.3.0-rc.1', '0.3.1')).toBe(false)
    expect(laterVersion('0.3.0-rc.2', '0.3.0-rc.1')).toBe(false)
  })
})

describe('what the screen reads', () => {
  it('is what the service wrote, held to its shape, with whether the newest is newer than what runs', async () => {
    serviceFound()

    const read = await view()

    expect(read).toMatchObject({
      running: '0.3.0',
      service: 'alive',
      mode: 'ready',
      latest: '0.3.1',
      newer: true,
      url: 'https://github.com/OpenGewerk/opengewerk/releases/tag/v0.3.1',
      run: null,
      pending: null,
      refusal: null,
    })
    expect(read.notes.map((section) => section.title)).toEqual(['Sicherheit', 'Behoben'])
  })

  it('names a pre-release that runs, and a release of the next numbers as newer', async () => {
    serviceFound()

    expect(await readInstanceUpdate(updates, '0.3.0-rc.1')).toMatchObject({
      running: '0.3.0-rc.1',
      latest: '0.3.1',
      newer: true,
    })
    expect(await readInstanceUpdate(updates, '0.3.0; reboot')).toMatchObject({
      running: null,
      newer: false,
    })
  })

  it('leaves out what does not hold: a page that is not on GitHub, a version that is none, an unknown mode', async () => {
    serviceFound({ url: 'https://example.org/v0.3.1', latest: '0.3.1; reboot', mode: 'whatever' })

    expect(await view()).toMatchObject({ url: null, latest: null, newer: false, mode: null })
  })

  it('says when the service is silent, or was never there', async () => {
    expect((await view()).service).toBe('missing')

    serviceFound({}, new Date(Date.now() - 10 * 60_000))

    expect((await view()).service).toBe('silent')
  })

  it('is not there for somebody who does not run the instance, nor for nobody', async () => {
    await get('/instance/update').expect(401)
    await get('/instance/update', otto).expect(403)
    await post('/instance/update', otto, { version: '0.3.1' }).expect(403)

    expect(requestFile()).toBeNull()
  })
})

describe('asking for an update', () => {
  it('is refused without confirming again, and nothing is written', async () => {
    serviceFound()

    const answer = await post('/instance/update', lea, { version: '0.3.1' }).expect(403)

    expect(message(answer)).toBe(unconfirmed)
    expect(requestFile()).toBeNull()
  })

  it('writes the request with the version, who asked and when, after confirming', async () => {
    serviceFound()
    await visitors.reconfirm(lea.email, as(lea))

    const read = (await post('/instance/update', lea, { version: '0.3.1' }).expect(202))
      .body as InstanceUpdateView
    const request = requestFile()

    expect(request).toMatchObject({ version: '0.3.1', by: lea.name })
    expect(String(request?.['id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(read.pending).toMatchObject({ id: request?.['id'], version: '0.3.1' })
  })

  it('is refused before the confirmation is spent when it cannot be, and says why', async () => {
    const refusedFor = async (version: string, expected: string) => {
      const answer = await post('/instance/update', lea, { version }).expect(409)

      expect(message(answer)).toContain(expected)
      expect(requestFile()).toBeNull()
    }

    // Once for all of them: a refusal that spent it would leave the last
    // request without one.
    await visitors.reconfirm(lea.email, as(lea))

    // The service never ran, and one that has been silent for ten minutes.
    await refusedFor('0.3.1', 'läuft nicht')
    serviceFound({}, new Date(Date.now() - 10 * 60_000))
    await refusedFor('0.3.1', 'läuft nicht')

    // Another version than the newest.
    serviceFound()
    await refusedFor('0.3.2', 'neueste Fassung')

    // An instance run from a checkout.
    serviceFound({ mode: 'checkout', reason: 'checkout' })
    await refusedFor('0.3.1', 'nicht aus ihrem Bereich')

    // The newest is what runs.
    serviceFound({ latest: '0.3.0' })
    await refusedFor('0.3.0', 'läuft schon')

    // An update under way.
    serviceFound()
    written('run.json', {
      id: '11111111-2222-4333-8444-555555555555',
      version: '0.3.1',
      from: '0.3.0',
      by: 'Lea Leitung',
      state: 'running',
      step: 2,
      started_at: new Date().toISOString(),
      finished_at: null,
      log: [],
    })
    await refusedFor('0.3.1', 'läuft schon')

    // An update that ended a moment ago, whose mail has not gone out: the
    // next would take its place before anybody was told.
    const ended = (finishedAt: Date) =>
      written('run.json', {
        id: '11111111-2222-4333-8444-555555555555',
        version: '0.3.0',
        from: '0.2.9',
        by: 'Lea Leitung',
        state: 'succeeded',
        step: 5,
        started_at: new Date(finishedAt.getTime() - 60_000).toISOString(),
        finished_at: finishedAt.toISOString(),
        log: [],
      })

    ended(new Date())
    await refusedFor('0.3.1', 'geht gerade noch hinaus')

    // Told, or two minutes later, the next may come: the confirmation was
    // not spent by any of these.
    await markUpdateTold(updates, '11111111-2222-4333-8444-555555555555', { done: true, to: [] })
    const told = await readInstanceUpdate(updates, '0.3.0')

    expect(await stillTelling(updates, told)).toBeNull()
    rmSync(join(updates.requestsPath, 'told-11111111-2222-4333-8444-555555555555'))
    ended(new Date(Date.now() - 3 * 60_000))
    await post('/instance/update', lea, { version: '0.3.1' }).expect(202)
  })

  it('is refused while a request waits for the service, and shows the refusal of the service', async () => {
    serviceFound()
    const id = await requestInstanceUpdate(updates, '0.3.1', 'Lea Leitung')

    await visitors.reconfirm(lea.email, as(lea))
    await post('/instance/update', lea, { version: '0.3.1' }).expect(409)

    written('refusal.json', {
      id,
      version: '0.3.1',
      reason: 'elsewhere',
      at: new Date().toISOString(),
    })

    expect(await view()).toMatchObject({ pending: null, refusal: { id, reason: 'elsewhere' } })
  })

  it('takes nothing but a version of the form 1.2.3', async () => {
    serviceFound()
    await visitors.reconfirm(lea.email, as(lea))

    for (const version of [undefined, 3, '0.3.1 && reboot', '../0.3.1']) {
      await post('/instance/update', lea, { version }).expect(400)
    }

    expect(requestFile()).toBeNull()
  })
})

describe('telling how an update ended', () => {
  const finished = (state: 'succeeded' | 'failed', finishedAt = new Date()) =>
    written('run.json', {
      id: '22222222-2222-4333-8444-555555555555',
      version: '0.3.1',
      from: '0.3.0',
      by: 'Lea Leitung',
      state,
      step: state === 'failed' ? 0 : 5,
      started_at: new Date(finishedAt.getTime() - 60_000).toISOString(),
      finished_at: finishedAt.toISOString(),
      log: [],
    })

  const reporting = () => ({ database, mail, messages, updates })
  const toldOf = () =>
    smtp.received.filter((sent) => sent.data?.includes('Subject: Aktualisierung auf 0.3.1'))

  beforeAll(async () => {
    await saveInstanceMailServer(database, userIds.get(lea.email) ?? '', key, {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      username: 'instanz',
      password: mailPassword,
      fromAddress: 'instanz@nord.example.de',
    })
  })

  it('goes to everybody who runs the instance, once', async () => {
    finished('failed')
    const before = toldOf().length

    expect(await reportFinishedUpdate(reporting())).toBe(true)
    expect(await reportFinishedUpdate(reporting())).toBe(false)

    const told = toldOf().slice(before)

    expect(told.map((sent) => sent.to)).toEqual([[lea.email]])
    expect(told[0]?.data).toContain('abgebrochen')
    expect(told[0]?.data).toContain('Schritt backup')
  })

  it('is tried again a minute later when the mail server could not be reached, and then told once', async () => {
    finished('succeeded')
    const before = toldOf().length
    // The server of the instance, at a port nobody answers on, as when it is
    // down: the transport connects only when it sends.
    const down: MailContext = {
      ...mail,
      connect: (configuration) => smtpTransport({ ...configuration, port: 1 }),
    }

    await expect(reportFinishedUpdate({ ...reporting(), mail: down })).rejects.toThrow()
    expect(toldOf().length).toBe(before)

    // A server that answers, and says at once that it is not available now.
    const closing = createServer((socket) => {
      socket.end('421 4.3.2 Service not available, closing transmission channel\r\n')
    })

    await new Promise<void>((resolve) => closing.listen(0, '127.0.0.1', resolve))

    try {
      const busy: MailContext = {
        ...mail,
        connect: (configuration) =>
          smtpTransport({ ...configuration, port: (closing.address() as AddressInfo).port }),
      }

      await expect(reportFinishedUpdate({ ...reporting(), mail: busy })).rejects.toThrow()
      expect(toldOf().length).toBe(before)
    } finally {
      await new Promise((resolve) => closing.close(resolve))
    }

    expect(await reportFinishedUpdate(reporting())).toBe(true)
    expect(await reportFinishedUpdate(reporting())).toBe(false)
    expect(toldOf().length).toBe(before + 1)
  })

  it.each([
    ['at MAIL FROM', { refuseSenders: ['instanz@nord.example.de'] }],
    ['at RCPT TO, as Postfix does', { refuseSendersAtRecipient: ['instanz@nord.example.de'] }],
  ] as const)(
    'gives up on nobody when the server turns the sender away %s, and tells everybody once it takes it',
    async (_where, refusal) => {
      finished('failed')
      const before = toldOf().length
      const picky = await fakeSmtpServer({
        credentials: { user: 'instanz', password: mailPassword },
        ...refusal,
      })

      try {
        const refusing: MailContext = {
          ...mail,
          connect: (configuration) => smtpTransport({ ...configuration, port: picky.port }),
        }

        await expect(reportFinishedUpdate({ ...reporting(), mail: refusing })).rejects.toThrow()
        expect(picky.received).toEqual([])
      } finally {
        await picky.close()
      }

      expect(await reportFinishedUpdate(reporting())).toBe(true)
      expect(
        toldOf()
          .slice(before)
          .map((sent) => sent.to),
      ).toEqual([[lea.email]])
    },
  )

  it('tells each operator once, tries an address again after a passing refusal and gives it up after a final one', async () => {
    const lead = userIds.get(lea.email) ?? ''
    const second = await appointOperator(database, probeAccess.sentences.instance, lead, otto.email)

    try {
      finished('failed')
      const before = toldOf().length
      // The server of the instance, which turns the mail to Otto away: for
      // now, then for good.
      let ottoRefused = 451
      const picky: MailContext = {
        ...mail,
        connect: (configuration) => {
          const real = smtpTransport(configuration)

          return {
            send: (message) =>
              message.to.address === otto.email
                ? Promise.reject(new MailDeliveryError('Abgewiesen.', null, ottoRefused))
                : real.send(message),
            verify: () => real.verify(),
            close: () => {
              real.close()
            },
          }
        },
      }
      const receivers = () =>
        toldOf()
          .slice(before)
          .map((sent) => sent.to)

      await expect(reportFinishedUpdate({ ...reporting(), mail: picky })).rejects.toThrow()
      await expect(reportFinishedUpdate({ ...reporting(), mail: picky })).rejects.toThrow()

      expect(receivers()).toEqual([[lea.email]])

      ottoRefused = 550

      expect(await reportFinishedUpdate({ ...reporting(), mail: picky })).toBe(true)
      expect(await reportFinishedUpdate(reporting())).toBe(false)
      expect(receivers()).toEqual([[lea.email]])
    } finally {
      await removeOperator(database, probeAccess.sentences.instance, lead, second.userId)
    }
  })

  it('says nothing of an update under way, of one that ended more than a day ago, or without words for it', async () => {
    const before = toldOf().length

    written('run.json', {
      id: '33333333-2222-4333-8444-555555555555',
      version: '0.3.1',
      from: '0.3.0',
      by: 'Lea Leitung',
      state: 'running',
      step: 3,
      started_at: new Date().toISOString(),
      finished_at: null,
      log: [],
    })
    expect(await reportFinishedUpdate(reporting())).toBe(false)

    finished('succeeded', new Date(Date.now() - 25 * 60 * 60_000))
    expect(await reportFinishedUpdate(reporting())).toBe(false)

    finished('succeeded')
    const { instanceUpdated: _, ...withoutWords } = messages
    expect(await reportFinishedUpdate({ ...reporting(), messages: withoutWords })).toBe(false)

    expect(toldOf().length).toBe(before)
  })
})

describe('telling how an update ended, when the mark of who was told fails', () => {
  const finished = (id: string) =>
    written('run.json', {
      id,
      version: '0.3.1',
      from: '0.3.0',
      by: 'Lea Leitung',
      state: 'failed',
      step: 0,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date().toISOString(),
      log: [],
    })

  const reporting = () => ({ database, mail, messages, updates })

  // On its own as well, without the mail server the group before sets up.
  beforeAll(async () => {
    await saveInstanceMailServer(database, userIds.get(lea.email) ?? '', key, {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      username: 'instanz',
      password: mailPassword,
      fromAddress: 'instanz@nord.example.de',
    })
  })

  const toLea = () =>
    smtp.received.filter(
      (sent) =>
        sent.data?.includes('Subject: Aktualisierung auf 0.3.1') &&
        sent.to.includes(lea.email.toLowerCase()),
    ).length

  it('tells nobody twice while the application runs, though the mark cannot be written (CodeRabbit on #1101)', async () => {
    const id = 'bbbbbbbb-3333-4333-8444-555555555555'
    const blocked = join(updates.requestsPath, `told-${id}`)
    finished(id)
    const before = toLea()

    // A folder where the mark goes takes no mark, as a disk that ran full.
    mkdirSync(join(blocked, 'inside'), { recursive: true })

    const looks: string[] = []

    try {
      for (let look = 0; look < 3; look += 1) {
        looks.push(
          await reportFinishedUpdate(reporting()).then(
            () => 'ended',
            () => 'failed',
          ),
        )
      }
    } finally {
      rmSync(blocked, { recursive: true, force: true })
    }

    expect(toLea() - before).toBe(1)
    // Nothing that did not go out is said: everybody has the mail.
    expect(looks).toEqual(['ended', 'ended', 'ended'])
  })

  it('marks each address as it is told, so that a look that stops leaves who got the mail (CodeRabbit on #1101)', async () => {
    const id = 'cccccccc-3333-4333-8444-555555555555'
    const lead = userIds.get(lea.email) ?? ''
    const second = await appointOperator(database, probeAccess.sentences.instance, lead, otto.email)
    const words = messages.instanceUpdated

    if (!words) {
      throw new Error('The probe application has the words of the mail.')
    }

    let told = 0
    const stopping = {
      ...messages,
      instanceUpdated: (facts: Parameters<typeof words>[0]) => {
        told += 1

        // The second address stops the look, after the first got its mail.
        if (told === 2) {
          throw new Error('Der Text ließ sich nicht schreiben.')
        }

        return words(facts)
      },
    }

    try {
      finished(id)

      await expect(reportFinishedUpdate({ ...reporting(), messages: stopping })).rejects.toThrow()

      expect((await updateTold(updates, id)).to).toHaveLength(1)
    } finally {
      await removeOperator(database, probeAccess.sentences.instance, lead, second.userId)
    }
  })
})

describe('the logs of an update', () => {
  const ended = (id: string, state: 'succeeded' | 'failed' | 'running', finishedAt = new Date()) =>
    written('run.json', {
      id,
      version: '0.3.1',
      from: '0.3.0',
      by: 'Lea Leitung',
      state,
      step: state === 'succeeded' ? 5 : 2,
      started_at: new Date(finishedAt.getTime() - 60_000).toISOString(),
      finished_at: state === 'running' ? null : finishedAt.toISOString(),
      log: [],
    })

  /** What the log of the instance holds of a run, field by field. */
  const inTheInstanceLog = async (id: string) => {
    const { rows } = await admin.query<{ field: string; new_value: string | null }>(
      `select field, new_value from instance_changes
        where table_name = 'instance_updates' and record_id = $1 order by field`,
      [id],
    )

    return Object.fromEntries(rows.map((row) => [row.field, row.new_value]))
  }

  /** The runs each tenant's log holds, by tenant, with where they stopped. */
  const inTheTenantLogs = async (id: string) => {
    const { rows } = await admin.query<{
      tenant_id: string
      record_id: string
      new_value: string | null
    }>(
      `select e.tenant_id, e.record_id::text as record_id, s.new_value
         from audit_entries e
         left join audit_entries s on s.record_id = e.record_id and s.field = 'stopped_in'
        where e.table_name = 'update_notices' and e.field = 'run_id' and e.new_value = $1
        order by e.tenant_id`,
      [id],
    )

    return rows
  }

  const tenants = async () =>
    (await admin.query<{ id: string }>('select id from tenants order by id')).rows.map(
      (row) => row.id,
    )

  beforeAll(async () => {
    await admin.query(`select create_tenant('Mandant Süd')`)
  })

  it('writes how a run ended into the log of the instance and of every tenant, once, without a mail server as well (opengewerk#1093)', async () => {
    const id = '33333333-2222-4333-8444-555555555555'
    ended(id, 'failed')

    expect(await recordFinishedUpdate(database, updates)).toBe(true)
    expect(await recordFinishedUpdate(database, updates)).toBe(false)

    expect(await inTheInstanceLog(id)).toEqual({
      finished_at: expect.any(String),
      from_version: '0.3.0',
      id,
      stopped_in: 'Abbilder holen und prüfen',
      succeeded: 'false',
      to_version: '0.3.1',
    })

    const everyTenant = await tenants()
    const logged = await inTheTenantLogs(id)

    expect(everyTenant).toHaveLength(2)
    expect(logged.map((row) => row.tenant_id)).toEqual(everyTenant)
    expect(logged.map((row) => row.new_value)).toEqual([
      'Abbilder holen und prüfen',
      'Abbilder holen und prüfen',
    ])
  })

  it('finishes what a look that stopped halfway left, and writes no tenant twice (opengewerk#1093)', async () => {
    const id = '44444444-2222-4333-8444-555555555555'
    const [first] = await tenants()
    ended(id, 'succeeded')

    // A look that reached the first tenant and stopped before the others.
    await database.forTenant({ tenantId: first as never, reason: 'instance.update' }, (tx) =>
      tx.insert(updateNotices).values({
        tenantId: first as never,
        runId: id,
        toVersion: '0.3.1',
        fromVersion: '0.3.0',
        succeeded: true,
        stoppedIn: null,
        finishedAt: new Date(),
      }),
    )

    expect(await recordFinishedUpdate(database, updates)).toBe(true)

    const logged = await inTheTenantLogs(id)

    expect(logged.map((row) => row.tenant_id)).toEqual(await tenants())
    expect(new Set(logged.map((row) => row.record_id)).size).toBe(2)
    expect((await inTheInstanceLog(id))['succeeded']).toBe('true')
  })

  it('writes nothing of a run under way, and a run that ended long ago all the same (opengewerk#1093)', async () => {
    const running = '55555555-3333-4333-8444-555555555555'
    const old = '66666666-3333-4333-8444-555555555555'

    ended(running, 'running')
    expect(await recordFinishedUpdate(database, updates)).toBe(false)
    expect(await inTheInstanceLog(running)).toEqual({})
    expect(await inTheTenantLogs(running)).toEqual([])

    // An update that left the instance down over a weekend.
    ended(old, 'failed', new Date(Date.now() - 60 * 60 * 60_000))
    expect(await recordFinishedUpdate(database, updates)).toBe(true)
    expect((await inTheInstanceLog(old))['stopped_in']).toBe('Abbilder holen und prüfen')
    expect(await inTheTenantLogs(old)).toHaveLength(2)
  })

  it('leaves the instance out of the logs until every tenant has the run (opengewerk#1093)', async () => {
    const id = '77777777-3333-4333-8444-555555555555'
    ended(id, 'failed')

    // A look that fails at a tenant.
    await admin.query('revoke insert on update_notices from opengewerk_app')

    try {
      await expect(recordFinishedUpdate(database, updates)).rejects.toThrow()
    } finally {
      await admin.query('grant insert on update_notices to opengewerk_app')
    }

    expect(await inTheInstanceLog(id)).toEqual({})

    expect(await recordFinishedUpdate(database, updates)).toBe(true)
    expect(await inTheTenantLogs(id)).toHaveLength(2)
    expect((await inTheInstanceLog(id))['to_version']).toBe('0.3.1')
  })

  it('says where a run stopped as the mail says it, one that never began and one that vanished (opengewerk#1093)', async () => {
    const stoppedIn = async (id: string, reason: 'docker' | 'vanished', step: number) => {
      written('run.json', {
        id,
        version: '0.3.1',
        from: '0.3.0',
        by: 'Lea Leitung',
        state: 'failed',
        reason,
        step,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date().toISOString(),
        log: [],
      })
      expect(await recordFinishedUpdate(database, updates)).toBe(true)

      return (await inTheInstanceLog(id))['stopped_in']
    }

    expect(await stoppedIn('88888888-3333-4333-8444-555555555555', 'docker', 0)).toBe(
      'Vor dem ersten Schritt, der Lauf ließ sich nicht starten',
    )
    expect(await stoppedIn('99999999-3333-4333-8444-555555555555', 'vanished', 3)).toBe(
      'Datenbank migrieren, der Lauf ist dabei verschwunden',
    )
  })

  it('writes the last run into the logs before a new request takes its place (opengewerk#1093)', async () => {
    const id = 'aaaaaaaa-3333-4333-8444-555555555555'
    serviceFound()
    // Ended long enough ago that no mail about it holds the request up.
    ended(id, 'failed', new Date(Date.now() - 3 * 60_000))
    await visitors.reconfirm(lea.email, as(lea))

    // A log that cannot be written: no request, and the confirmation stays.
    await admin.query('revoke insert on update_notices from opengewerk_app')

    try {
      // The filter answers the refused insert of the database with a 403.
      const refused = await post('/instance/update', lea, { version: '0.3.1' })

      expect(refused.status).toBe(403)
      expect(message(refused)).not.toBe(unconfirmed)
    } finally {
      await admin.query('grant insert on update_notices to opengewerk_app')
    }

    expect(requestFile()).toBeNull()

    await post('/instance/update', lea, { version: '0.3.1' }).expect(202)

    expect(requestFile()).toMatchObject({ version: '0.3.1' })
    expect((await inTheInstanceLog(id))['to_version']).toBe('0.3.1')
    expect(await inTheTenantLogs(id)).toHaveLength(2)
  })
})

describe('what the screen reads, straight from the folders', () => {
  it('drops a run whose ID or version is not of its form', async () => {
    serviceFound()
    written('run.json', {
      id: '../../etc',
      version: '0.3.1',
      state: 'running',
      step: 1,
      started_at: new Date().toISOString(),
    })

    expect((await readInstanceUpdate(updates, '0.3.0')).run).toBeNull()
  })
})
