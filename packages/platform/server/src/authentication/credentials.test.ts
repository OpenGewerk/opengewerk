import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import type { Response } from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { newId } from '../database/identifier.js'
import { authenticationPath } from './authentication.js'
import { refusingRevokedSessions, revokeCredentials } from './credentials.js'
import { endOtherSessions } from './other-sessions.js'
import {
  cookiesOf,
  type ProbeFoundation,
  probeFoundation,
  type ProbeInstance,
  probeInstance,
  probeOrigin as origin,
} from './probe-application.js'
import { addStaffMember, replacePassword } from './staff.js'
import { currentCode } from './test-authenticator.js'

/**
 * The count of an account's credentials (`credentials.ts`), against a
 * session written after they were taken back.
 *
 * Before, a sign in that had checked the old password a moment before it
 * changed wrote its session after the old ones were gone, and kept it: every
 * revocation ended the sessions that were there, none the one about to be.
 */

const north = { id: newId<'tenant'>(), name: 'Mandant Nord' }
const first = 'das-erste-lange-passwort'
const second = 'das-zweite-lange-passwort'

let foundation: ProbeFoundation
let admin: Pool
let instance: ProbeInstance

/** What the mail with the link got. */
const links: { email: string; token: string }[] = []

function http() {
  return instance.http()
}

function post(path: string, cookies?: string) {
  const sending = http().post(`${authenticationPath}${path}`).set('origin', origin)

  return cookies ? sending.set('cookie', cookies) : sending
}

async function person(email: string): Promise<string> {
  const { userId } = await addStaffMember(instance.authentication, instance.database, {
    email,
    name: 'Zora Zähler',
    password: first,
    tenantId: north.id,
    roles: ['member'],
  })

  return userId
}

async function generationOf(userId: string): Promise<number> {
  const { rows } = await admin.query<{ generation: number }>(
    'select credential_generation as generation from auth_users where id = $1',
    [userId],
  )

  return Number(rows[0]?.generation)
}

async function sessionsOf(userId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*) as n from auth_sessions where user_id = $1',
    [userId],
  )

  return Number(rows[0]?.n)
}

/** The row of the session these cookies carry. */
async function sessionOf(cookies: string): Promise<string> {
  const token = /session_token=([^.;]+)/.exec(cookies)?.[1] ?? ''
  const { rows } = await admin.query<{ id: string }>(
    'select id from auth_sessions where token = $1',
    [token],
  )

  return rows[0]?.id ?? ''
}

/** The rows of the account that wait for something, a second code among them. */
async function waitingOf(userId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*) as n from auth_verifications where value = $1',
    [userId],
  )

  return Number(rows[0]?.n)
}

/** The rows of the account that wait for a second code. */
async function secondStepsOf(userId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `select count(*) as n from auth_verifications where value = $1 and identifier like '2fa-%'`,
    [userId],
  )

  return Number(rows[0]?.n)
}

/** Sets the app up for the account, and hands back what it was fed. */
async function withSecondFactor(email: string): Promise<string> {
  const cookies = cookiesOf(
    await post('/sign-in/email').send({ email, password: first }).expect(200),
  )
  const enabled = await post('/two-factor/enable', cookies)
    .send({ password: first, method: 'totp' })
    .expect(200)
  const totpUri = (enabled.body as { totpURI: string }).totpURI

  await post('/two-factor/verify-totp', cookies)
    .send({ code: await currentCode(totpUri) })
    .expect(200)

  return totpUri
}

/** Until a connection waits for the lock that backend holds, or `over` says to stop. */
async function blockedBy(backend: number, over: () => boolean): Promise<void> {
  for (let tries = 0; tries < 750 && !over(); tries += 1) {
    const { rows } = await admin.query<{ waiting: string }>(
      'select count(*) as waiting from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [backend],
    )

    if (Number(rows[0]?.waiting) > 0) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeAll(async () => {
  foundation = await probeFoundation()
  admin = await foundation.kit.connect()
  await foundation.empty()
  await foundation.tenants(admin, [north])

  instance = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
    secret: 'z'.repeat(64),
    passwordResetMail: (requester, token) => {
      links.push({ email: requester.email, token })

      return Promise.resolve()
    },
  })
})

afterAll(async () => {
  await instance.close()
  await foundation.kit.resetSchema(admin)
  await admin.end()
  foundation.remove()
})

describe('the count of the credentials of an account', () => {
  it('is what a session has to carry for the database to take it', async () => {
    const userId = await person('stand@nord.example.de')
    const standing = await generationOf(userId)
    const write = (id: string, generation: number | null) =>
      admin.query(
        `insert into auth_sessions (credential_generation, id, token, user_id, expires_at, created_at, updated_at)
         values ($1, $2, $2, $3, now() + interval '1 hour', now(), now())`,
        [generation, id, userId],
      )

    await expect(write('stale-count', standing - 1)).rejects.toMatchObject({ code: 'OG015' })
    await write('current-count', standing)
    // Without one, as a version from before the count writes it while an
    // update runs: taken, and not let in by the server (below).
    await write('no-count', null)
    await expect(
      admin.query(
        `update auth_sessions set credential_generation = $1 where id = 'current-count'`,
        [standing - 1],
      ),
    ).rejects.toMatchObject({ code: 'OG015' })
    expect(await sessionsOf(userId)).toBe(2)
  })

  it('does not let in a session without a count, as a version from before writes it while an update runs', async () => {
    const email = 'vorher@nord.example.de'
    const userId = await person(email)
    const older = await instance.signIn(email, first)

    await admin.query('update auth_sessions set credential_generation = null where id = $1', [
      await sessionOf(older),
    ])

    await http().get('/auth/tenants').set('cookie', older).expect(401)
    expect(await sessionsOf(userId)).toBe(0)
  })

  it('refuses a sign in that checked the password before the credentials were taken back', async () => {
    const email = 'wettlauf@nord.example.de'
    const userId = await person(email)
    let answer: Response | undefined
    let signingIn: Promise<void> = Promise.resolve()

    await instance.database.forInstance(async (tx) => {
      await revokeCredentials(tx, userId)

      const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)

      // The sign in reads the count the account still has outside this
      // transaction, checks the password, and waits for the account as it
      // writes its session, until the revocation is in.
      signingIn = post('/sign-in/email')
        .send({ email, password: first })
        .then((received) => {
          answer = received
        })
      await blockedBy(Number(rows[0]?.pid), () => answer !== undefined)
    }, userId)
    await signingIn

    expect(answer?.status).toBe(401)
    expect((answer?.body as { code?: string } | undefined)?.code).toBe('SESSION_REVOKED')
    expect(await sessionsOf(userId)).toBe(0)
    // The password itself stands: a sign in that begins now is let in.
    expect(await instance.signIn(email, first)).not.toBe('')
  })

  it('ends a session at its next request when the count went past it', async () => {
    const email = 'nachher@nord.example.de'
    const userId = await person(email)
    const one = await instance.signIn(email, first)
    const other = await instance.signIn(email, first)
    const browser = await instance.signIn(email, first)

    // As if all three had been written between a revocation of better-auth's
    // own and the count that follows it.
    await admin.query(
      'update auth_users set credential_generation = credential_generation + 1 where id = $1',
      [userId],
    )

    await http().get('/auth/tenants').set('cookie', one).expect(401)

    // The browser asking for its session is told there is none.
    const asked = await http().get(`${authenticationPath}/get-session`).set('cookie', browser)

    expect(asked.status).toBe(200)
    expect(asked.body).toBeNull()

    const refused = await post('/change-password', other).send({
      currentPassword: first,
      newPassword: second,
    })

    expect(refused.status).toBe(401)
    expect((refused.body as { code?: string }).code).toBe('SESSION_REVOKED')
    expect(await sessionsOf(userId)).toBe(0)
    expect(await instance.signIn(email, first)).not.toBe('')
  })

  it('goes up when the other devices are signed out, and the session that stays takes it', async () => {
    const email = 'andere@nord.example.de'
    const userId = await person(email)
    const here = await instance.signIn(email, first)
    const elsewhere = await instance.signIn(email, first)

    await endOtherSessions(instance.database, userId, await sessionOf(here), 'passkey.remove')

    expect(await generationOf(userId)).toBe(1)
    await http().get('/auth/tenants').set('cookie', here).expect(200)
    await http().get('/auth/tenants').set('cookie', elsewhere).expect(401)
  })

  it('goes up when a password is replaced on the command line', async () => {
    const email = 'befehl@nord.example.de'
    const userId = await person(email)
    const open = await instance.signIn(email, first)

    await replacePassword(instance.authentication, instance.database, { email, password: second })

    expect(await generationOf(userId)).toBe(1)
    await http().get('/auth/tenants').set('cookie', open).expect(401)
  })

  it('goes up when a password is changed, and signs the other devices out whatever the request asks', async () => {
    const email = 'wechsel@nord.example.de'
    const userId = await person(email)
    const here = await instance.signIn(email, first)
    const elsewhere = await instance.signIn(email, first)

    const changed = await post('/change-password', here)
      .send({ currentPassword: first, newPassword: second, revokeOtherSessions: false })
      .expect(200)

    expect(await generationOf(userId)).toBe(1)
    await http().get('/auth/tenants').set('cookie', elsewhere).expect(401)
    // The session written in the place of the old one carries the new count.
    await http().get('/auth/tenants').set('cookie', cookiesOf(changed)).expect(200)
  })

  it('goes up when a password is set through the link in a mail', async () => {
    const email = 'link@nord.example.de'
    const userId = await person(email)

    await post('/request-password-reset').send({ email }).expect(200)
    await vi.waitFor(() => {
      expect(links.at(-1)?.email).toBe(email)
    })
    await post('/reset-password')
      .send({ token: links.at(-1)?.token ?? '', newPassword: second })
      .expect(200)

    expect(await generationOf(userId)).toBe(1)
  })

  it('goes up as well when the link hands its token over in the address', async () => {
    const email = 'adresse@nord.example.de'
    const userId = await person(email)

    await post('/request-password-reset').send({ email }).expect(200)
    await vi.waitFor(() => {
      expect(links.at(-1)?.email).toBe(email)
    })
    await post(`/reset-password?token=${encodeURIComponent(links.at(-1)?.token ?? '')}`)
      .send({ newPassword: second })
      .expect(200)

    expect(await generationOf(userId)).toBe(1)
  })

  it('goes up when the app is set up, and not when somebody signs in with it', async () => {
    const email = 'alltag@nord.example.de'
    const userId = await person(email)
    const totpUri = await withSecondFactor(email)

    expect(await generationOf(userId)).toBe(1)

    // A link asked for, and a sign in waiting for its code on another device.
    await post('/request-password-reset').send({ email }).expect(200)
    await vi.waitFor(() => {
      expect(links.at(-1)?.email).toBe(email)
    })

    const token = links.at(-1)?.token ?? ''
    const elsewhere = await post('/sign-in/email').send({ email, password: first }).expect(200)

    expect((elsewhere.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)

    // Signing in here, with the app.
    const here = await post('/sign-in/email').send({ email, password: first }).expect(200)

    await post('/two-factor/verify-totp', cookiesOf(here))
      .send({ code: await currentCode(totpUri) })
      .expect(200)

    expect(await generationOf(userId)).toBe(1)
    expect(await secondStepsOf(userId)).toBe(1)
    await post('/reset-password').send({ token, newPassword: second }).expect(200)
  })

  it('ends a sign in that waits for its second code', async () => {
    const email = 'zweiter@nord.example.de'
    const userId = await person(email)
    const totpUri = await withSecondFactor(email)
    const started = await post('/sign-in/email').send({ email, password: first }).expect(200)

    expect((started.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)

    await replacePassword(instance.authentication, instance.database, { email, password: second })

    const finished = await post('/two-factor/verify-totp', cookiesOf(started)).send({
      code: await currentCode(totpUri),
    })

    expect(finished.status).toBeGreaterThanOrEqual(400)
    expect(await sessionsOf(userId)).toBe(0)
  })

  it('ends a sign in whose wait for the second code was written after the credentials were taken back', async () => {
    const email = 'dazwischen@nord.example.de'
    const userId = await person(email)

    await withSecondFactor(email)

    // Holds the row of the wait as it is written, and only that row, until
    // the test lets go: better-auth writes it after the session of the
    // password, which it deletes again, and a revocation in that moment found
    // nothing to end.
    const holder = await admin.connect()

    await admin.query(`create function hold_second_step() returns trigger language plpgsql as $$
      begin
        if new.identifier like '2fa-%' and new.identifier not like '2fa-attempts-%' then
          perform pg_advisory_xact_lock(4711);
        end if;
        return new;
      end $$`)
    await admin.query(
      'create trigger hold_second_step before insert on auth_verifications for each row execute function hold_second_step()',
    )

    try {
      await holder.query('select pg_advisory_lock(4711)')

      const held = await holder.query<{ pid: number }>('select pg_backend_pid() as pid')
      let answer: Response | undefined
      const signingIn = post('/sign-in/email')
        .send({ email, password: first })
        .then((received) => {
          answer = received
        })

      // The password is checked, its session written and deleted again, and
      // the row of the wait is about to be written.
      await blockedBy(Number(held.rows[0]?.pid), () => answer !== undefined)
      await instance.database.forInstance(async (tx) => {
        await revokeCredentials(tx, userId)

        const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)

        // The row goes in now, past the revocation, and what checks it waits
        // for the revocation to be in.
        await holder.query('select pg_advisory_unlock(4711)')
        await blockedBy(Number(rows[0]?.pid), () => answer !== undefined)
      }, userId)
      await signingIn

      expect(answer?.status).toBe(401)
      expect((answer?.body as { code?: string } | undefined)?.code).toBe('SESSION_REVOKED')
      expect(await waitingOf(userId)).toBe(0)
      expect(await sessionsOf(userId)).toBe(0)
    } finally {
      await holder.query('select pg_advisory_unlock_all()')
      holder.release()
      await admin.query('drop trigger if exists hold_second_step on auth_verifications')
      await admin.query('drop function if exists hold_second_step()')
    }
  })
})

describe('the adapter around the database', () => {
  it('answers a session the database refused for its count as a sign in to begin again, also inside a transaction', async () => {
    const refused = Object.assign(new Error('refused'), { code: 'OG015' })
    const failing = () => Promise.reject(refused)
    const inner = { create: failing }
    const factory = (() => ({
      create: failing,
      transaction: (callback: (inside: typeof inner) => Promise<unknown>) => callback(inner),
    })) as unknown as Parameters<typeof refusingRevokedSessions>[0]
    const adapter = refusingRevokedSessions(factory)(
      {} as Parameters<ReturnType<typeof refusingRevokedSessions>>[0],
    )
    const session = { model: 'session', data: {} }

    await expect(adapter.create(session)).rejects.toMatchObject({
      body: { code: 'SESSION_REVOKED' },
    })
    await expect(adapter.transaction((inside) => inside.create(session))).rejects.toMatchObject({
      body: { code: 'SESSION_REVOKED' },
    })
    // Any other table, and any other error, goes on as it was thrown.
    await expect(adapter.create({ model: 'user', data: {} })).rejects.toBe(refused)
  })
})
