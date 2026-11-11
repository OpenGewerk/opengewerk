import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { addDays, berlinClock } from '@opengewerk/domain'
import { Database, dispositionFor, FileStore, newId } from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import { qualificationsRunningOut } from '../deadlines/sources.js'
import { ApiModule } from './api.module.js'
import { binary } from './test-binary.js'
import { as, testIdentities as identities } from './test-identity.js'

/**
 * The files of the people who work for the business (#287, ADR 0016): only
 * the owner reads and keeps them, everybody reads their own, a file without
 * an account, one file to an account, a working time from its day with the
 * earlier one kept for the time before, qualifications of a kind of the
 * catalogue or the business's own, the deadline of one that runs out, and
 * the files of one business out of reach of another.
 */

const north = { id: newId<'tenant'>(), name: 'Elektro Kohm GmbH' }
const south = { id: newId<'tenant'>(), name: 'Elektro Süd GmbH' }

let admin: Pool
let database: Database
let app: INestApplication
let storageRoot: string

const owner = as(north.id, 'owner')
const office = as(north.id, 'office')
const technician = as(north.id, 'technician')
const elsewhere = as(south.id, 'owner')

/** Somebody of the business by their own account, with a role. */
const signedIn = (userId: string, role: 'office' | 'technician') =>
  JSON.stringify({ userId, tenantId: north.id, roles: [role] })

const anna = signedIn('anna', 'technician')
const britta = signedIn('britta', 'office')

const today = berlinClock(new Date()).day

const week = (minutes: readonly number[]) => ({
  mondayMinutes: minutes[0] ?? 0,
  tuesdayMinutes: minutes[1] ?? 0,
  wednesdayMinutes: minutes[2] ?? 0,
  thursdayMinutes: minutes[3] ?? 0,
  fridayMinutes: minutes[4] ?? 0,
  saturdayMinutes: minutes[5] ?? 0,
  sundayMinutes: minutes[6] ?? 0,
})

let annasFile = ''
let helper = ''

function http() {
  return request(app.getHttpServer())
}

async function send(
  method: 'post' | 'patch' | 'delete',
  path: string,
  body: Record<string, unknown> = {},
  who = owner,
  status = method === 'post' ? 201 : 200,
) {
  const answer = await http()[method](path).set('x-test-identity', who).send(body)

  expect([answer.status, path, answer.body]).toEqual([status, path, expect.anything()])

  return answer.body as Record<string, unknown> & { id: string; message?: string }
}

async function get(path: string, who = owner, status = 200) {
  const answer = await http().get(path).set('x-test-identity', who).expect(status)

  return answer.body as Record<string, unknown>
}

interface File {
  readonly name: string
  readonly account: { readonly email: string } | null
  readonly workingTimes: readonly {
    readonly id: string
    readonly validFrom: string
    readonly weekMinutes: number
    readonly holdsToday: boolean
  }[]
  readonly qualifications: readonly {
    readonly kindLabel: string
    readonly validUntil: string | null
    readonly standing: string
  }[]
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2), ($3, $4)', [
    north.id,
    north.name,
    south.id,
    south.name,
  ])
  await admin.query(
    `insert into auth_users (id, name, email) values
       ('test', 'Moritz Kohm', 'info@example.de'),
       ('anna', 'Anna Weber', 'a.weber@example.de'),
       ('britta', 'Britta Kohm', 'britta@example.de'),
       ('sven', 'Sven Süd', 'sven@example.de')`,
  )
  await admin.query(
    `insert into memberships (tenant_id, user_id, roles) values
       ($1, 'test', '{owner}'), ($1, 'anna', '{technician}'), ($1, 'britta', '{office}'),
       ($2, 'test', '{owner}'), ($2, 'sven', '{technician}')`,
    [north.id, south.id],
  )

  storageRoot = mkdtempSync(join(tmpdir(), 'opengewerk-people-'))
  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [ApiModule.create(database, identities, { files: new FileStore(storageRoot) })],
  }).compile()

  app = built.createNestApplication()
  await app.init()

  annasFile = (
    await send('post', '/people', { name: 'Anna Weber', userId: 'anna', joinedOn: '2023-03-01' })
  ).id
  helper = (
    await send('post', '/people', {
      name: 'Tim Schäfer',
      joinedOn: today,
      workingTime: { validFrom: today, ...week([300, 300, 300, 300, 300]) },
    })
  ).id
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
  rmSync(storageRoot, { recursive: true, force: true })
})

describe('who reads and keeps the files', () => {
  it('is the owner alone: the office and a technician read no file and keep none', async () => {
    expect(await get('/people')).toHaveLength(2)

    for (const who of [office, technician]) {
      await get('/people', who, 403)
      await get(`/people/${annasFile}`, who, 403)
      await get('/qualification-kinds', who, 403)
      await send('post', '/people', { name: 'Jemand' }, who, 403)
      await send('patch', `/people/${annasFile}`, { leftOn: today }, who, 403)
      await send(
        'post',
        `/people/${annasFile}/qualifications`,
        { kindKey: 'core.driving_licence' },
        who,
        403,
      )
    }
  })

  it('lets everybody read their own file and nobody else, without a right of the files', async () => {
    const own = (await get('/people/mine', anna)) as unknown as File

    expect(own.name).toBe('Anna Weber')
    expect(own.account?.email).toBe('a.weber@example.de')

    // The office has no file of its own here, and reads nobody else's.
    const none = await http().get('/people/mine').set('x-test-identity', britta).expect(200)

    expect(none.text).toBe('')
  })
})

describe('a file', () => {
  it('needs no account, and holds the first working time of the form', async () => {
    const file = (await get(`/people/${helper}`)) as unknown as File

    expect(file.account).toBeNull()
    expect(
      file.workingTimes.map((time) => [time.validFrom, time.weekMinutes, time.holdsToday]),
    ).toEqual([[today, 1500, true]])
  })

  it('takes an account of this business that belongs to no other file', async () => {
    const free = (await get('/people/accounts')) as unknown as { userId: string }[]

    expect(free.map((account) => account.userId).sort()).toEqual(['britta', 'test'])

    const answer = await send('post', '/people', { name: 'Anna W.', userId: 'anna' }, owner, 409)

    expect(answer.message).toBe('Dieser Zugang gehört schon zu einer Akte.')
    // Somebody who works for another business is no account here.
    await send('post', '/people', { name: 'Sven Süd', userId: 'sven' }, owner, 400)
  })

  it('does not let anybody leave before they joined', async () => {
    const answer = await send('patch', `/people/${annasFile}`, { leftOn: '2023-02-28' }, owner, 400)

    expect(answer.message).toBe('Der Austritt liegt nicht vor dem Eintritt.')
  })
})

describe('the working time agreed with a person', () => {
  it('holds from its day, and the earlier one stays for the time before', async () => {
    // A working time from years ago, as a file brought over would have it.
    await admin.query(
      `insert into working_times (tenant_id, person_id, valid_from, monday_minutes, tuesday_minutes,
         wednesday_minutes, thursday_minutes, friday_minutes)
       values ($1, $2, '2023-03-01', 480, 480, 480, 480, 480)`,
      [north.id, annasFile],
    )

    const later = addDays(today, 61)

    await send('post', `/people/${annasFile}/working-times`, {
      validFrom: later,
      ...week([450, 450, 450, 450]),
    })

    const file = (await get(`/people/${annasFile}`)) as unknown as File

    expect(
      file.workingTimes.map((time) => [time.validFrom, time.weekMinutes, time.holdsToday]),
    ).toEqual([
      [later, 1800, false],
      ['2023-03-01', 2400, true],
    ])
  })

  it('starts today at the earliest, and once its day has begun it stays as it is', async () => {
    const before = await send(
      'post',
      `/people/${annasFile}/working-times`,
      { validFrom: addDays(today, -1), ...week([480]) },
      owner,
      400,
    )

    expect(before.message).toBe('Eine Arbeitszeit gilt ab heute oder später.')

    const file = (await get(`/people/${annasFile}`)) as unknown as File
    const [coming, holding] = file.workingTimes

    const begun = await send(
      'patch',
      `/people/${annasFile}/working-times/${holding?.id ?? ''}`,
      { mondayMinutes: 0 },
      owner,
      409,
    )

    expect(begun.message).toMatch(/^Diese Arbeitszeit gilt schon/)
    await send('delete', `/people/${annasFile}/working-times/${holding?.id ?? ''}`, {}, owner, 409)

    // One still to come is changed, and taken out again.
    await send('patch', `/people/${annasFile}/working-times/${coming?.id ?? ''}`, {
      fridayMinutes: 120,
    })
    await send('delete', `/people/${annasFile}/working-times/${coming?.id ?? ''}`)

    const after = (await get(`/people/${annasFile}`)) as unknown as File

    expect(after.workingTimes.map((time) => time.validFrom)).toEqual(['2023-03-01'])
  })

  it('is one from a day for a person', async () => {
    const answer = await send(
      'post',
      `/people/${helper}/working-times`,
      { validFrom: today, ...week([240]) },
      owner,
      409,
    )

    expect(answer.message).toBe('Ab diesem Tag gibt es schon eine Arbeitszeit.')
  })
})

describe('the qualifications of a person', () => {
  it('are of a kind of the catalogue or of the business, exactly one, with the label and how they stand', async () => {
    const firstAid = (
      await send('post', '/qualification-kinds', {
        label: 'Ersthelfer',
        level: 'instructed_person',
      })
    ).id

    await send('post', `/people/${annasFile}/qualifications`, {
      kindKey: 'core.work_at_height',
      validUntil: addDays(today, 29),
      note: 'Unterweisung PSA gegen Absturz',
    })
    await send('post', `/people/${annasFile}/qualifications`, {
      ownKindId: firstAid,
      validUntil: addDays(today, -1),
    })
    await send('post', `/people/${annasFile}/qualifications`, { kindKey: 'elektro.skilled_person' })

    const unknown = await send(
      'post',
      `/people/${annasFile}/qualifications`,
      { kindKey: 'core.diving' },
      owner,
      400,
    )

    expect(unknown.message).toBe('Diese Art gibt es nicht oder nicht mehr.')
    await send(
      'post',
      `/people/${annasFile}/qualifications`,
      { kindKey: 'core.driving_licence', ownKindId: firstAid },
      owner,
      400,
    )

    const file = (await get(`/people/${annasFile}`)) as unknown as File

    expect(file.qualifications.map((each) => [each.kindLabel, each.standing]).sort()).toEqual([
      ['Elektrofachkraft', 'valid'],
      ['Ersthelfer', 'expired'],
      ['Höhenarbeit', 'expiring'],
    ])

    // An own kind somebody holds is not taken out.
    const held = await send('delete', `/qualification-kinds/${firstAid}`, {}, owner, 409)

    expect(held.message).toBe('Diese Art hält noch jemand. Erst die Qualifikationen ändern.')
  })

  it('make a deadline when they run out, named by kind and person, until the person has left', async () => {
    const running = async () =>
      database.forTenant({ tenantId: north.id }, (tx) => qualificationsRunningOut(tx))

    const named = (await running()).map((source) => [
      source.sourceLabel,
      source.namedDueOn,
      source.naturalUserId,
    ])

    expect(named.sort()).toEqual([
      ['Ersthelfer von Anna Weber', addDays(today, -1), 'anna'],
      ['Höhenarbeit von Anna Weber', addDays(today, 29), 'anna'],
    ])

    await send('patch', `/people/${annasFile}`, { leftOn: addDays(today, -1) })
    expect(await running()).toEqual([])
    await send('patch', `/people/${annasFile}`, { leftOn: null })
  })
})

/**
 * The certificate of a qualification (opengewerk#802, ADR 0012): a file of
 * the store, which the qualification names with the name it was chosen
 * under, read back under the right of the files of the people and not from
 * the files every role reads.
 */
describe('the certificate of a qualification', () => {
  const certificate = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
  const name = 'unterweisung-psaga-2026.pdf'

  function hashOf(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex')
  }

  async function upload(bytes: Buffer, who = owner) {
    await http()
      .put(`/files/${hashOf(bytes)}`)
      .set('x-test-identity', who)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Media-Type', 'application/pdf')
      .send(bytes)
      .expect(200)

    return hashOf(bytes)
  }

  function read(qualificationId: string, who = owner) {
    return http()
      .get(`/people/${annasFile}/qualifications/${qualificationId}/certificate`)
      .set('x-test-identity', who)
      .buffer(true)
      .parse(binary)
  }

  let held = ''

  beforeAll(async () => {
    held = (
      await send('post', `/people/${annasFile}/qualifications`, {
        kindKey: 'core.work_at_height',
        validUntil: addDays(today, 400),
        certificateSha256: await upload(certificate),
        certificateName: name,
      })
    ).id
  })

  it('is kept by the owner and read again by the name it was chosen under', async () => {
    const answer = await read(held).expect(200)

    expect(answer.headers['content-type']).toContain('application/pdf')
    expect(answer.headers['content-disposition']).toBe(dispositionFor('application/pdf', name))
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(Buffer.from(answer.body as Buffer).equals(certificate)).toBe(true)

    const file = (await get(`/people/${annasFile}`)) as unknown as {
      qualifications: { id: string; certificateName: string | null }[]
    }

    expect(file.qualifications.find((each) => each.id === held)?.certificateName).toBe(name)
  })

  it('is put to a qualification when it is changed as well', async () => {
    const other = Buffer.from('%PDF-1.7\n% zweiter Nachweis\n%%EOF\n')
    const added = await send('post', `/people/${annasFile}/qualifications`, {
      kindKey: 'core.driving_licence',
    })

    await read(added.id).expect(404)
    await send('patch', `/people/${annasFile}/qualifications/${added.id}`, {
      certificateSha256: await upload(other),
      certificateName: 'fuehrerschein.pdf',
    })

    const answer = await read(added.id).expect(200)

    expect(Buffer.from(answer.body as Buffer).equals(other)).toBe(true)
  })

  it('takes the file it replaces out of the store, unless another qualification still names it', async () => {
    async function stored(hash: string): Promise<number> {
      const { rows } = await admin.query<{ n: number }>(
        'select count(*)::int as n from files where tenant_id = $1 and sha256 = $2',
        [north.id, hash],
      )

      return rows[0]?.n ?? 0
    }
    async function added(bytes: Buffer, fileName: string): Promise<string> {
      return (
        await send('post', `/people/${annasFile}/qualifications`, {
          kindKey: 'core.driving_licence',
          certificateSha256: await upload(bytes),
          certificateName: fileName,
        })
      ).id
    }

    const first = Buffer.from('%PDF-1.7\n% erster Nachweis\n%%EOF\n')
    const replacing = Buffer.from('%PDF-1.7\n% neuer Nachweis\n%%EOF\n')
    const shared = Buffer.from('%PDF-1.7\n% Nachweis für zwei\n%%EOF\n')
    const replaced = await added(first, 'erster.pdf')
    const takenOff = await added(shared, 'fuer-zwei.pdf')
    const keeping = await added(shared, 'fuer-zwei.pdf')

    await send('patch', `/people/${annasFile}/qualifications/${replaced}`, {
      certificateSha256: await upload(replacing),
      certificateName: 'neuer.pdf',
    })
    await send('patch', `/people/${annasFile}/qualifications/${takenOff}`, {
      certificateSha256: null,
      certificateName: null,
    })

    expect(await stored(hashOf(first))).toBe(0)
    expect(await stored(hashOf(replacing))).toBe(1)
    expect(await stored(hashOf(shared))).toBe(1)
    await read(takenOff).expect(404)
    expect(Buffer.from((await read(keeping).expect(200)).body as Buffer).equals(shared)).toBe(true)
  })

  it.each([
    ['the office', office],
    ['a technician', technician],
    ['the technician whose file it is', anna],
    ['somebody of the office by their account', britta],
  ])('is not read by %s', async (_who, who) => {
    await read(held, who).expect(403)
  })

  it('is shown as there to the person whose file it is, in their own file', async () => {
    const mine = (await get('/people/mine', anna)) as unknown as {
      qualifications: { id: string; certificateName: string | null }[]
    }

    expect(mine.qualifications.find((each) => each.id === held)?.certificateName).toBe(name)
  })

  it('names a file of this business alone', async () => {
    const theirs = Buffer.from('%PDF-1.7\n% Nachweis aus Süd\n%%EOF\n')

    await upload(theirs, elsewhere)

    const refused = await send(
      'post',
      `/people/${annasFile}/qualifications`,
      { kindKey: 'core.driving_licence', certificateSha256: hashOf(theirs), certificateName: name },
      owner,
      400,
    )

    expect(refused.message).toBe(
      'Diese Datei liegt nicht im Speicher dieses Betriebs. Laden Sie den Nachweis noch einmal hoch.',
    )
    const changed = await send(
      'patch',
      `/people/${annasFile}/qualifications/${held}`,
      { certificateSha256: hashOf(theirs), certificateName: name },
      owner,
      400,
    )

    expect(changed.message).toBe(refused.message)
  })

  it('is a file with its name, or none', async () => {
    const refused = await send(
      'post',
      `/people/${annasFile}/qualifications`,
      { kindKey: 'core.driving_licence', certificateSha256: hashOf(certificate) },
      owner,
      400,
    )

    expect(refused.message).toBe('Ein Nachweis ist eine Datei mit ihrem Namen.')
  })
})

describe('the files of one business', () => {
  it('are out of reach of another', async () => {
    expect(await get('/people', elsewhere)).toEqual([])
    await get(`/people/${annasFile}`, elsewhere, 404)
    await send('patch', `/people/${annasFile}`, { name: 'Anders' }, elsewhere, 404)
    await send(
      'post',
      `/people/${annasFile}/qualifications`,
      { kindKey: 'core.driving_licence' },
      elsewhere,
      404,
    )

    const sven = JSON.stringify({ userId: 'sven', tenantId: south.id, roles: ['technician'] })
    const none = await http().get('/people/mine').set('x-test-identity', sven).expect(200)

    expect(none.text).toBe('')
  })
})
