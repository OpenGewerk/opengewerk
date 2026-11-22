import { otherAccountSignedIn, workingAsHeader, workingInHeader } from '@opengewerk/platform-domain'
import { and, eq, sql } from 'drizzle-orm'
import { Client, type Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Database } from '../database/database.js'
import { newId } from '../database/identifier.js'
import { auditEntries, authRateLimits, authUsers, invitations, tenantSessions } from '../schema.js'
import { removeAccountData, revokeDeviceOf, setBlocked } from './administration.js'
import { authenticationPath } from './authentication.js'
import { mintToken } from './invitation.js'
import {
  probeAccess,
  type ProbeFoundation,
  probeFoundation,
  probeIdentities,
  type ProbeInstance,
  probeInstance,
  probeOrigin as origin,
  reached,
} from './probe-application.js'
import { writePassword } from './credentials.js'
import { endOtherSessions } from './other-sessions.js'
import { renewSession } from './session-lifetime.js'
import {
  carryStretch,
  endOrphanedStretches,
  endPastLastDayOf,
  endPastLastDays,
  endStretchesOf,
  sweepExpiredSessions,
} from './session-sweep.js'
import { addStaffMember, replacePassword } from './staff.js'

/**
 * The authentication, end to end and through HTTP, because that is the only
 * way it is ever used. Nothing in here reaches past the request: a test that
 * called `identify` directly would prove the function works and say nothing
 * about whether the cookie ever arrives.
 *
 * With an application that is nobody's (`probe-application.ts`), on a database
 * that carries the foundation and nothing else.
 */

const north = { id: newId<'tenant'>(), name: 'Mandant Nord' }
const south = { id: newId<'tenant'>(), name: 'Mandant Süd' }

const password = 'ein-ordentlich-langes-passwort'

let foundation: ProbeFoundation
let admin: Pool
let instance: ProbeInstance
const others: ProbeInstance[] = []

/** Somebody in one tenant, the ordinary case. */
const member = { email: 'mitglied@example.de', name: 'Mia Mitglied' }
/** Somebody in two, which is the case the whole tenant choice exists for. */
const both = { email: 'beide@example.de', name: 'Bodo Beide' }
/** Somebody who leads a tenant, so that the second factor requirement can be looked at. */
const lead = { email: 'leitung@example.de', name: 'Lea Ohne-Zweitfaktor' }

const userIds = new Map<string, string>()

function http() {
  return instance.http()
}

/** Signs in and hands back the raw cookies, attributes and all. */
async function signInRaw(email: string): Promise<string[]> {
  const answer = await http()
    .post(`${authenticationPath}/sign-in/email`)
    .set('origin', origin)
    .send({ email, password })
    .expect(200)

  const cookies = answer.headers['set-cookie']

  return Array.isArray(cookies) ? cookies : [cookies as string]
}

function withCookies(cookies: readonly string[]): string {
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ')
}

/** Signs in and hands back the cookies, the way a browser would send them. */
async function signIn(email: string): Promise<string> {
  return withCookies(await signInRaw(email))
}

/** The people the tenant of this session has, by the key of their account. */
async function membersSeen(cookies: string): Promise<string[]> {
  const seen = await http().get('/probe/members').set('cookie', cookies).expect(200)

  return (seen.body as { userId: string }[]).map((row) => row.userId)
}

beforeAll(async () => {
  foundation = await probeFoundation()
  admin = await foundation.kit.connect()
  await foundation.empty()
  await foundation.tenants(admin, [north, south])

  instance = await probeInstance(foundation.kit.applicationDatabaseUrl())

  for (const [person, tenantId, role] of [
    [member, north.id, 'member'],
    [both, north.id, 'member'],
    [both, south.id, 'member'],
    [lead, north.id, 'lead'],
  ] as const) {
    const { userId } = await addStaffMember(instance.authentication, instance.database, {
      ...person,
      password,
      tenantId,
      roles: [role],
    })

    userIds.set(person.email, userId)
  }
})

afterAll(async () => {
  await instance.close()

  for (const other of others) {
    await other.close()
  }

  await foundation.kit.resetSchema(admin)
  await admin.end()
  foundation.remove()
})

describe('signing in', () => {
  it('gets somebody as far as the choice of tenant and no further', async () => {
    const cookies = await signIn(member.email)

    // Signed in, so the routes around the choice answer.
    const choices = await http().get('/auth/tenants').set('cookie', cookies).expect(200)
    expect(choices.body).toEqual([
      {
        id: north.id,
        name: north.name,
        roles: ['member'],
        // What the role is called and what it adds up to, from the rows of
        // the tenant (`roles.test.ts`).
        roleLabels: ['Mitglied'],
        rights: ['members.read', 'notes.write'],
        secondFactor: false,
      },
    ])

    // And the data still does not, because no tenant has been chosen. A 401
    // with its own sentence, in the words of the application: the way out is
    // not to sign in again.
    const refused = await http().get('/probe/members').set('cookie', cookies).expect(401)
    expect(refused.body.message).toBe(
      'Es ist noch kein Mandant gewählt. Bitte zuerst einen Mandanten auswählen.',
    )
  })

  it('opens the data once a tenant is chosen', async () => {
    const cookies = await signIn(member.email)

    await instance.chooseTenant(cookies, north.id)

    expect(await membersSeen(cookies)).toContain(userIds.get(member.email))
  })

  it('is refused with the wrong password, and says nothing more than that', async () => {
    const refused = await http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .send({ email: member.email, password: 'falsch-aber-lang-genug' })

    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(refused.body)).not.toContain(member.name)
  })

  /**
   * The body of a sign in reaches better-auth through the limit in front of
   * it (`mountAuthentication`, as an instance mounts it): read there and
   * handed on as text. Without its body better-auth would refuse the request
   * for a missing address, with 400; with it, a wrong password is refused as
   * wrong credentials and the right one opens a session.
   */
  it('reaches better-auth through the limit of its body: a wrong password is wrong credentials, the right one a session', async () => {
    const wrong = await http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .send({ email: member.email, password: 'falsch-aber-lang-genug' })

    expect(wrong.status).toBe(401)
    expect(wrong.body).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' })

    const cookies = await signInRaw(member.email)

    expect(cookies.some((cookie) => cookie.includes('session_token='))).toBe(true)
  })

  it('is refused for somebody who does not exist, the same way', async () => {
    const refused = await http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .send({ email: 'niemand@example.de', password })

    expect(refused.status).toBeGreaterThanOrEqual(400)
  })

  /**
   * Nobody signs themselves up. An instance where a stranger can make an
   * account has given away a foothold before anybody has done anything wrong,
   * and `addStaffMember` is the only way in.
   */
  it('cannot be reached by signing oneself up', async () => {
    const refused = await http()
      .post(`${authenticationPath}/sign-up/email`)
      .set('origin', origin)
      .send({ email: 'fremd@example.de', password, name: 'Fremder' })

    expect(refused.status).toBeGreaterThanOrEqual(400)

    const created = await instance.database.forInstance((tx) =>
      tx.select().from(authUsers).where(eq(authUsers.email, 'fremd@example.de')),
    )
    expect(created).toEqual([])
  })

  /**
   * A page on another subdomain of the same domain could set a cookie under
   * the `__Secure-` name of before, with the token of a session of its own,
   * and better-auth reads the first cookie of a name it is sent. A browser
   * keeps a `__Host-` cookie for its own host alone, and one under the old
   * name is nobody's session any more.
   */
  it('keeps the session in a cookie of this host alone, beside which one from a neighbour counts for nothing', async () => {
    const raw = await signInRaw(member.email)
    const session = raw.find((cookie) => cookie.includes('session_token=')) ?? ''
    const attributes = session.split(';').map((part) => part.trim().toLowerCase())

    expect(session.split('=')[0]).toBe('__Host-better-auth.session_token')
    expect(attributes).toEqual(expect.arrayContaining(['secure', 'path=/', 'httponly']))
    expect(attributes.filter((part) => part.startsWith('domain='))).toEqual([])
    expect(raw.filter((cookie) => !cookie.startsWith('__Host-'))).toEqual([])

    // The token of somebody else's session, under the old name and first.
    const elsewhere = (await signInRaw(both.email)).find((cookie) =>
      cookie.includes('session_token='),
    )
    const token = elsewhere?.split(';')[0]?.split('=').slice(1).join('=') ?? ''
    const seen = await http()
      .get(`${authenticationPath}/get-session`)
      .set('origin', origin)
      .set('cookie', `__Secure-better-auth.session_token=${token}; ${withCookies(raw)}`)
      .expect(200)

    expect((seen.body as { user: { email: string } }).user.email).toBe(member.email)
    // The id of the session: the browser tells by it whether a session it
    // finds is the one it signed out of without a network (platform-web,
    // `currentAccount`).
    const { session: found } = seen.body as { session: { id: unknown } }

    expect(typeof found.id === 'string' && found.id !== '').toBe(true)
  })
})

describe('putting somebody into a tenant', () => {
  /**
   * Whether the account came into being here or was already on the instance.
   *
   * The command line needs the answer, and not for a nicer sentence: an
   * account that was already there keeps the password it had, so a command
   * that printed the one it brought along would be naming a password that does
   * not work. Somebody in two tenants is the ordinary case for the second
   * half, not an edge one.
   */
  it('says whether the account was new, because a second tenant reuses it', async () => {
    const fresh = await addStaffMember(instance.authentication, instance.database, {
      email: 'neu@example.de',
      name: 'Nina Neu',
      password,
      tenantId: north.id,
      roles: ['member'],
    })

    expect(fresh.created).toBe(true)

    const again = await addStaffMember(instance.authentication, instance.database, {
      email: 'neu@example.de',
      name: 'Nina Neu',
      password: 'ein-ganz-anderes-passwort',
      tenantId: south.id,
      roles: ['member'],
    })

    expect(again.created).toBe(false)
    expect(again.userId).toBe(fresh.userId)

    // And the password really is the first one, which is what the flag is
    // there to let a caller say out loud.
    expect(await instance.signIn('neu@example.de', 'ein-ganz-anderes-passwort')).toBe('')
    expect(await instance.signIn('neu@example.de', password)).not.toBe('')
  })
})

describe('the choice of tenant', () => {
  it('offers somebody in two tenants both of them', async () => {
    const cookies = await signIn(both.email)

    const choices = await http().get('/auth/tenants').set('cookie', cookies).expect(200)

    expect((choices.body as { id: string }[]).map((row) => row.id).sort()).toEqual(
      [north.id, south.id].sort(),
    )
  })

  /**
   * The oldest promise in the server, from the other side. `authorization.test`
   * says a tenant in a request body is ignored; this says the one place a
   * tenant can be named is checked against a membership before it is believed.
   */
  it('refuses a tenant somebody is not part of', async () => {
    const cookies = await signIn(member.email)

    const refused = await http()
      .post('/auth/tenant')
      .set('cookie', cookies)
      .set('origin', origin)
      .send({ tenantId: south.id })
      .expect(403)

    expect(refused.body.message).toBe('Kein Zugang zu diesem Mandanten.')

    // And it really did not take, rather than answering 403 and going through.
    await http().get('/probe/members').set('cookie', cookies).expect(401)
  })

  it('refuses a tenant that does not exist, with the same answer', async () => {
    const cookies = await signIn(member.email)

    const refused = await http()
      .post('/auth/tenant')
      .set('cookie', cookies)
      .set('origin', origin)
      .send({ tenantId: newId<'tenant'>() })
      .expect(403)

    // The same sentence as above. Telling the two apart would turn this route
    // into a way of finding out which tenants are on an instance.
    expect(refused.body.message).toBe('Kein Zugang zu diesem Mandanten.')
  })

  it('keeps the two tenants of one person apart', async () => {
    const inNorth = await signIn(both.email)
    await instance.chooseTenant(inNorth, north.id)

    const inSouth = await signIn(both.email)
    await instance.chooseTenant(inSouth, south.id)

    // The same person, and each session sees the people of its own tenant:
    // the one who works only in the north is not in the south.
    expect(await membersSeen(inNorth)).toContain(userIds.get(member.email))
    expect(await membersSeen(inSouth)).not.toContain(userIds.get(member.email))
    expect(await membersSeen(inSouth)).toContain(userIds.get(both.email))
  })

  /**
   * The switch between two tenants without signing in again (#242). The
   * session goes over, and the stretch of work in the first tenant ends
   * there, in its own log, instead of staying open because the sign out
   * later closes only what is open in the tenant chosen last.
   */
  it('moves one session from one tenant to the other, and ends the work in the first', async () => {
    const cookies = await signIn(both.email)

    await instance.chooseTenant(cookies, north.id)
    expect(await membersSeen(cookies)).toContain(userIds.get(member.email))

    await instance.chooseTenant(cookies, south.id)
    expect(await membersSeen(cookies)).not.toContain(userIds.get(member.email))

    const { rows } = await admin.query<{ tenant_id: string; ended: boolean }>(
      `select s.tenant_id, s.ended_at is not null as ended
         from tenant_sessions s
         join auth_users u on u.id = s.user_id
        where u.email = $1 and s.session_id = (
          select id from auth_sessions where user_id = u.id order by created_at desc limit 1)`,
      [both.email],
    )

    expect(rows.find((row) => row.tenant_id === north.id)?.ended).toBe(true)
    expect(rows.find((row) => row.tenant_id === south.id)?.ended).toBe(false)

    const ended = await instance.database.forTenant({ tenantId: north.id }, (tx) =>
      tx
        .select({ reason: auditEntries.reason })
        .from(auditEntries)
        .where(
          and(eq(auditEntries.tableName, 'tenant_sessions'), eq(auditEntries.field, 'ended_at')),
        ),
    )

    expect(ended.some((entry) => entry.reason === 'session.switch')).toBe(true)
  })

  /**
   * The other tab (#242): a page that still works in the first tenant sends
   * its tenant along, and the server refuses it instead of taking what it
   * sends into the second. Without the header, as before, nothing changes.
   */
  it('refuses a page that still works in the tenant the session left', async () => {
    const cookies = await signIn(both.email)

    await instance.chooseTenant(cookies, north.id)
    await instance.chooseTenant(cookies, south.id)

    const left = await http()
      .get('/probe/members')
      .set('cookie', cookies)
      .set(workingInHeader, north.id)
      .expect(401)

    expect((left.body as { message: string }).message).toBe(
      'Diese Seite arbeitet noch bei einem anderen Mandanten.',
    )

    const before = reached.written

    await http()
      .post('/probe/notes')
      .set('cookie', cookies)
      .set('origin', origin)
      .set(workingInHeader, north.id)
      .send({ text: 'Aus dem alten Tab' })
      .expect(401)

    // Refused before the handler, so nothing of the old tab was written.
    expect(reached.written).toBe(before)

    await http()
      .get('/probe/members')
      .set('cookie', cookies)
      .set(workingInHeader, south.id)
      .expect(200)
    await http()
      .post('/probe/notes')
      .set('cookie', cookies)
      .set('origin', origin)
      .set(workingInHeader, south.id)
      .send({ text: 'Aus dem neuen Tab' })
      .expect(201, { tenantId: south.id })
    await http().get('/probe/members').set('cookie', cookies).expect(200)
  })
})

/**
 * A tab still open for the person signed in before (opengewerk#882): the
 * browser holds the cookie of the one signed in now, and the tab names the
 * account it works for. The application refuses it, and so does the sign in
 * in front of it, except for the one question that tells the tab who it is
 * now.
 */
describe('a tab that works for the account signed in before', () => {
  it('is refused by the routes of the application and of the sign in, and told who is signed in now', async () => {
    const before = userIds.get(member.email) ?? ''
    const now = userIds.get(both.email) ?? ''
    const cookies = await signIn(both.email)

    await instance.chooseTenant(cookies, north.id)

    const read = await http()
      .get('/probe/members')
      .set('cookie', cookies)
      .set(workingAsHeader, before)
      .expect(409)

    expect((read.body as { code: string }).code).toBe(otherAccountSignedIn)

    const written = reached.written

    await http()
      .post('/probe/notes')
      .set('cookie', cookies)
      .set('origin', origin)
      .set(workingAsHeader, before)
      .send({ text: 'Aus dem Tab von vorher' })
      .expect(409)

    expect(reached.written).toBe(written)

    // From the screen of the account in that tab, before better-auth sees it.
    const changed = await http()
      .post(`${authenticationPath}/change-password`)
      .set('cookie', cookies)
      .set('origin', origin)
      .set(workingAsHeader, before)
      .send({ currentPassword: password, newPassword: 'ein-ganz-anderes-langes-passwort' })
      .expect(409)

    expect((changed.body as { code: string }).code).toBe(otherAccountSignedIn)

    const session = await http()
      .get(`${authenticationPath}/get-session`)
      .set('cookie', cookies)
      .set(workingAsHeader, before)
      .expect(200)

    expect((session.body as { user: { id: string } }).user.id).toBe(now)

    // Named for the one signed in, both go on as they did.
    await http().get('/probe/members').set('cookie', cookies).set(workingAsHeader, now).expect(200)

    const own = await http()
      .post(`${authenticationPath}/change-password`)
      .set('cookie', cookies)
      .set('origin', origin)
      .set(workingAsHeader, now)
      .send({
        currentPassword: 'nicht-das-passwort',
        newPassword: 'ein-ganz-anderes-langes-passwort',
      })

    // better-auth's own answer to a wrong password, and not the refusal above.
    expect({ status: own.status, body: own.body as unknown }).toMatchObject({
      status: 400,
      body: { code: 'INVALID_PASSWORD' },
    })
  })
})

describe('the second factor', () => {
  /**
   * ADR 0006 hangs this on the role and not on a setting, so it is checked on
   * every request rather than once at sign in: somebody given such a role an
   * hour ago is stopped at their next request without anybody having to
   * remember to look at them again. Which roles those are, the application
   * says.
   */
  it('is required of a role the application names, which gets no further than the choice without one', async () => {
    const cookies = await signIn(lead.email)

    // The choice still works, otherwise there would be no way to get to the
    // screen that sets a second factor up.
    await http().get('/auth/tenants').set('cookie', cookies).expect(200)
    await instance.chooseTenant(cookies, north.id)

    const refused = await http().get('/probe/members').set('cookie', cookies).expect(403)
    expect(refused.body.message).toContain('zweiter Faktor')
    // Both ways out (#167): the app, or signing in with a passkey.
    expect(refused.body.message).toContain('Authenticator-App')
    expect(refused.body.message).toContain('Passkey')
  })

  /**
   * Passkeys were off from 23.09.2026 (GHSA-jghx-6wmh-mpcj): a session could
   * register one without confirming anything, and signing in with it skipped
   * the second factor. They came back with #167, and the first half of that
   * advisory is what this holds: a session alone registers nothing, however
   * young it is. The rest is in `passkeys.test.ts`, which also signs in with
   * one and shows that only one confirmed on the device counts.
   */
  it('cannot be gone round by registering a passkey with a session alone', async () => {
    const cookies = await signIn(lead.email)

    const refused = await http()
      .get(`${authenticationPath}/passkey/generate-register-options`)
      .set('cookie', cookies)
      .expect(403)

    expect(refused.body.message).toContain('mit dem Passwort bestätigen')

    await http()
      .post(`${authenticationPath}/passkey/verify-registration`)
      .set('cookie', cookies)
      .set('origin', origin)
      .send({ response: {}, name: 'Ohne Bestätigung' })
      .expect(403)
  })

  it('is not required of a role the application does not name, which works as usual', async () => {
    const cookies = await signIn(member.email)

    await instance.chooseTenant(cookies, north.id)
    await http().get('/probe/members').set('cookie', cookies).expect(200)
  })
})

describe('devices', () => {
  it('are listed for their own account only, with the current one marked', async () => {
    const first = await signIn(member.email)
    const second = await signIn(member.email)

    const seen = await http().get('/auth/devices').set('cookie', second).expect(200)
    const rows = seen.body as { sessionId: string; current: boolean }[]

    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.filter((row) => row.current)).toHaveLength(1)

    // Somebody else's list is not in it.
    const otherCookies = await signIn(both.email)
    const other = await http().get('/auth/devices').set('cookie', otherCookies).expect(200)
    const mine = new Set(rows.map((row) => row.sessionId))
    for (const row of other.body as { sessionId: string }[]) {
      expect(mine.has(row.sessionId)).toBe(false)
    }

    expect(first.length).toBeGreaterThan(0)
  })

  it('name the address a device signed in from to its own account (#563)', async () => {
    const answer = await http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .set('x-forwarded-for', '203.0.113.7')
      .send({ email: member.email, password })
      .expect(200)
    const cookies = withCookies([answer.headers['set-cookie'] ?? []].flat() as string[])
    const seen = await http().get('/auth/devices').set('cookie', cookies).expect(200)
    const rows = seen.body as { current: boolean; ipAddress: string | null }[]

    expect(rows.find((row) => row.current)?.ipAddress).toBe('203.0.113.7')
  })

  it('name no address that a client added to the one of the web server', async () => {
    // A client that sends an address of its own makes two of them, and the
    // session keeps the one the web server added, the last
    // (opengewerk-haustechnik#360).
    const answer = await http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .set('x-forwarded-for', '198.51.100.9, 203.0.113.7')
      .send({ email: member.email, password })
      .expect(200)
    const cookies = withCookies([answer.headers['set-cookie'] ?? []].flat() as string[])
    const seen = await http().get('/auth/devices').set('cookie', cookies).expect(200)
    const rows = seen.body as { current: boolean; ipAddress: string | null }[]

    expect(rows.find((row) => row.current)?.ipAddress).toBe('203.0.113.7')
  })

  it('can be cut off from another one, and the cut off session stops working', async () => {
    const toRevoke = await signIn(member.email)
    const keeping = await signIn(member.email)

    await instance.chooseTenant(toRevoke, north.id)
    await http().get('/probe/members').set('cookie', toRevoke).expect(200)

    // Asked of the session that is about to be cut off, not of the one doing
    // the cutting. Earlier tests in this file left this account several open
    // sessions, so "the first one that is not the current one" would pick a
    // stranger and the test would prove nothing.
    const own = await http().get('/auth/devices').set('cookie', toRevoke).expect(200)
    const victim = (own.body as { sessionId: string; current: boolean }[]).find(
      (row) => row.current,
    )

    await http()
      .delete(`/auth/devices/${victim?.sessionId}`)
      .set('cookie', keeping)
      .set('origin', origin)
      .expect(200)

    // The revoked one is out, the one that did the revoking is not.
    await http().get('/probe/members').set('cookie', toRevoke).expect(401)
    await http().get('/auth/devices').set('cookie', keeping).expect(200)
  })

  it('cannot be cut off by somebody else', async () => {
    const mine = await signIn(member.email)
    const stranger = await signIn(both.email)

    const list = await http().get('/auth/devices').set('cookie', mine).expect(200)
    const target = (list.body as { sessionId: string; current: boolean }[]).find(
      (row) => row.current,
    )

    await http()
      .delete(`/auth/devices/${target?.sessionId}`)
      .set('cookie', stranger)
      .set('origin', origin)
      .expect(403)

    // Still working, so the 403 was not a 403 with the deletion happening anyway.
    await http().get('/auth/devices').set('cookie', mine).expect(200)
  })
})

describe('how long a session lasts', () => {
  const hour = 60 * 60 * 1000
  const day = 24 * hour

  /** The session cookie among what a response set, attributes and all. */
  function sessionCookie(cookies: readonly string[]): string {
    const found = cookies.find((cookie) => cookie.includes('session_token='))

    if (!found) {
      throw new Error('no session cookie in the answer')
    }

    return found
  }

  /** The row behind a cookie: its value is the token, a dot and a signature. */
  function tokenOf(cookies: readonly string[]): string {
    const value = sessionCookie(cookies).split(';')[0]?.split('=')[1] ?? ''

    return decodeURIComponent(value).split('.')[0] ?? ''
  }

  async function rowOf(cookies: readonly string[]) {
    const { rows } = await admin.query<{ expires_at: Date; long_lived: boolean }>(
      'select expires_at, long_lived from auth_sessions where token = $1',
      [tokenOf(cookies)],
    )
    const [row] = rows

    if (!row) {
      throw new Error('no session row for the cookie')
    }

    return { ...row, left: row.expires_at.getTime() - Date.now() }
  }

  async function expiresIn(cookies: readonly string[], left: number): Promise<void> {
    await admin.query('update auth_sessions set expires_at = $2 where token = $1', [
      tokenOf(cookies),
      new Date(Date.now() + left),
    ])
  }

  async function inTenant(email: string, deviceId?: string): Promise<string[]> {
    const cookies = await signInRaw(email)

    await instance.chooseTenant(withCookies(cookies), north.id, deviceId)

    return cookies
  }

  /**
   * The cookie is the long lifetime whatever the session is, and the row is
   * what decides (#124). With the short lifetime in the cookie, as before,
   * every registered device was signed out after twelve hours although its
   * row said thirty days.
   */
  it('keeps the cookie a month, and a new session short until a device is registered', async () => {
    const cookies = await signInRaw(member.email)

    expect(sessionCookie(cookies)).toContain('Max-Age=2592000')

    const fresh = await rowOf(cookies)

    expect(fresh.left).toBeGreaterThan(12 * hour - 5 * 60_000)
    expect(fresh.left).toBeLessThanOrEqual(12 * hour)
  })

  it('gives a registered device thirty days, and every other session twelve hours', async () => {
    const device = await rowOf(await inTenant(member.email, newId<'device'>()))
    const desk = await rowOf(await inTenant(member.email))

    expect(device.long_lived).toBe(true)
    expect(device.left).toBeGreaterThan(30 * day - hour)
    expect(desk.long_lived).toBe(false)
    expect(desk.left).toBeLessThanOrEqual(12 * hour)
  })

  it('names the device of the session in the identity, not what a request says', async () => {
    // What is handed to a device is measured by this (#286); a session at a
    // desk registered none.
    const deviceId = newId<'device'>()
    const source = probeIdentities(instance.authentication, instance.database)
    const device = await inTenant(member.email, deviceId)
    const desk = await inTenant(member.email)

    expect((await source.identify({ headers: { cookie: withCookies(device) } }))?.deviceId).toBe(
      deviceId,
    )
    expect(
      (await source.identify({ headers: { cookie: withCookies(desk) } }))?.deviceId,
    ).toBeUndefined()
  })

  it('renews a session in use to a full lifetime from now, by its kind', async () => {
    const desk = await inTenant(member.email)
    const device = await inTenant(member.email, newId<'device'>())

    // Last renewed two hours and two days ago.
    await expiresIn(desk, 10 * hour)
    await expiresIn(device, 28 * day)

    await http().get('/probe/members').set('cookie', withCookies(desk)).expect(200)
    await http().get('/probe/members').set('cookie', withCookies(device)).expect(200)

    expect((await rowOf(desk)).left).toBeGreaterThan(12 * hour - 5 * 60_000)
    expect((await rowOf(device)).left).toBeGreaterThan(30 * day - hour)
    expect((await rowOf(device)).long_lived).toBe(true)
  })

  it('leaves a session alone that was renewed a moment ago', async () => {
    const desk = await inTenant(member.email)

    await expiresIn(desk, 11 * hour + 50 * 60_000)
    await http().get('/probe/members').set('cookie', withCookies(desk)).expect(200)

    expect((await rowOf(desk)).left).toBeLessThan(11 * hour + 51 * 60_000)
  })

  /**
   * The interface asks after the session at every start and whenever it
   * comes back into view. That answer carries the cookie again, a month from
   * now, so a device in use never reaches the end of it.
   */
  it('hands the cookie out again for a month when the interface asks after the session', async () => {
    const device = await inTenant(member.email, newId<'device'>())
    const answer = await http()
      .get(`${authenticationPath}/get-session`)
      .set('cookie', withCookies(device))
      .expect(200)
    const renewed = answer.headers['set-cookie']

    expect(sessionCookie(Array.isArray(renewed) ? renewed : [String(renewed)])).toContain(
      'Max-Age=2592000',
    )
  })

  it('refuses a session whose row has run out, however long the cookie would last', async () => {
    const desk = await inTenant(member.email)

    await expiresIn(desk, -60_000)
    await http().get('/probe/members').set('cookie', withCookies(desk)).expect(401)
  })
})

describe('signing out', () => {
  it('ends the session, and the cookie stops working', async () => {
    const cookies = await signIn(member.email)

    await instance.chooseTenant(cookies, north.id)
    await http().post('/auth/sign-out').set('cookie', cookies).set('origin', origin).expect(201)

    await http().get('/probe/members').set('cookie', cookies).expect(401)
  })

  /** Makes the delete of one session fail, for as long as `run` runs. */
  async function refusingToDelete(sessionId: string, run: () => Promise<unknown>): Promise<void> {
    await admin.query(
      `create function refuse_session_delete() returns trigger language plpgsql
         as $$ begin raise exception 'delete refused'; end $$`,
    )
    // The id quoted by PostgreSQL itself, since a trigger takes no parameters.
    const { rows } = await admin.query<{ statement: string }>(
      `select format('create trigger refuse_session_delete before delete on auth_sessions
                        for each row when (old.id = %L) execute function refuse_session_delete()', $1::text)
              as statement`,
      [sessionId],
    )

    await admin.query(rows[0]?.statement ?? '')

    try {
      await run()
    } finally {
      await admin.query('drop trigger refuse_session_delete on auth_sessions')
      await admin.query('drop function refuse_session_delete()')
    }
  }

  it('keeps the work open when the session could not be taken out (#1031)', async () => {
    const working = await atWork(member.email)

    await refusingToDelete(working.id, () =>
      http()
        .post('/auth/sign-out')
        .set('cookie', working.cookies)
        .set('origin', origin)
        .expect(500),
    )

    // The session still works, and so the tenant's log still shows its work.
    expect(await sessionsOf(member.email)).toContain(working.id)
    expect(await endOfWork(working.id)).toBeNull()
  })

  it('keeps the work of a device open when it could not be cut off (#1031)', async () => {
    const device = await atWork(member.email)
    const keeping = await signIn(member.email)

    await refusingToDelete(device.id, () =>
      http()
        .delete(`/auth/devices/${device.id}`)
        .set('cookie', keeping)
        .set('origin', origin)
        .expect(500),
    )

    expect(await sessionsOf(member.email)).toContain(device.id)
    expect(await endOfWork(device.id)).toBeNull()
  })
})

describe('the audit log', () => {
  /**
   * What ADR 0006 asks for, and the reason `tenant_sessions` exists at all: an
   * entry needs a tenant, so a sign in can only be logged once a tenant is
   * chosen. Both ends of the stretch of work are in there, because the row is
   * written on the choice and changed on signing out, and the audit trigger
   * watches it like any other table.
   */
  it('holds both ends of a stretch of work in the tenant it happened in', async () => {
    const cookies = await signIn(member.email)

    await instance.chooseTenant(cookies, north.id)
    await http().post('/auth/sign-out').set('cookie', cookies).set('origin', origin).expect(201)

    const entries = await instance.database.forTenant({ tenantId: north.id }, (tx) =>
      tx
        .select({ reason: auditEntries.reason, field: auditEntries.field })
        .from(auditEntries)
        .where(eq(auditEntries.tableName, 'tenant_sessions')),
    )

    const reasons = new Set(entries.map((entry) => entry.reason))
    expect(reasons.has('session.start')).toBe(true)
    expect(reasons.has('session.end')).toBe(true)
    // The end is an update to `ended_at`, not a row that disappeared: the
    // tenant's record that somebody worked in it has to survive the sign out.
    expect(entries.some((entry) => entry.field === 'ended_at')).toBe(true)
  })

  it('records a change of rights, because a membership is an ordinary table', async () => {
    const entries = await instance.database.forTenant({ tenantId: north.id }, (tx) =>
      tx
        .select({ reason: auditEntries.reason })
        .from(auditEntries)
        .where(eq(auditEntries.tableName, 'memberships')),
    )

    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((entry) => entry.reason === 'membership.create')).toBe(true)
  })
})

describe('the two halves of the schema', () => {
  /**
   * The property `forInstance` rests on, measured rather than asserted in a
   * comment. Inside a tenant the accounts are out of reach; outside one the
   * data of a tenant is. Neither is a rule somebody has to keep: both are the
   * policies, and a query that crossed the line comes back empty instead of
   * leaking.
   */
  it('cannot see each other, whichever side the question is asked from', async () => {
    const database = instance.database

    // Something that belongs to one tenant: an invitation into it.
    await database.forTenant({ tenantId: north.id }, (tx) =>
      tx.insert(invitations).values({
        tenantId: north.id,
        email: 'gegenprobe@example.de',
        name: 'Für die Gegenprobe',
        roles: ['member'],
        tokenHash: mintToken().hash,
        invitedBy: userIds.get(lead.email) ?? '',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    )

    // There are users, and there is an invitation. Proved from the side each
    // of them is visible from, so that an empty result below cannot be an
    // empty table.
    const users = await database.forInstance((tx) => tx.select().from(authUsers))
    expect(users.length).toBeGreaterThan(0)

    const invitationsFromInside = await database.forTenant({ tenantId: north.id }, (tx) =>
      tx.select().from(invitations),
    )
    expect(invitationsFromInside.length).toBeGreaterThan(0)

    // From inside the tenant: no accounts.
    const usersFromInside = await database.forTenant({ tenantId: north.id }, (tx) =>
      tx.select().from(authUsers),
    )
    expect(usersFromInside).toEqual([])

    // From outside any tenant: nothing that belongs to one.
    const invitationsFromOutside = await database.forInstance((tx) => tx.select().from(invitations))
    expect(invitationsFromOutside).toEqual([])

    // And from the tenant next door: nothing either.
    const invitationsFromNextDoor = await database.forTenant({ tenantId: south.id }, (tx) =>
      tx.select().from(invitations),
    )
    expect(invitationsFromNextDoor).toEqual([])
  })
})

describe('an instance reached at more than one address (#551)', () => {
  const inside = 'https://intern.probewerk.example.de'
  const warnings: string[] = []
  let twice: ProbeInstance

  beforeAll(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((...said: unknown[]) => {
      warnings.push(said.map(String).join(' '))
    })

    try {
      twice = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
        trustedOrigins: [origin, inside],
      })
      others.push(twice)
      // better-auth makes its context with the first request, and the warning
      // came with it.
      await twice.http().get(`${authenticationPath}/get-session`).set('origin', origin)
    } finally {
      warn.mockRestore()
    }
  })

  it('starts without the warning that no base address is set', () => {
    expect(warnings.filter((line) => line.includes('Base URL'))).toEqual([])
  })

  it('signs in, holds the session and offers a passkey over each address, under the cookie of before', async () => {
    for (const address of [origin, inside]) {
      const answer = await twice
        .http()
        .post(`${authenticationPath}/sign-in/email`)
        .set('origin', address)
        .send({ email: member.email, password })
        .expect(200)
      const cookies = [answer.headers['set-cookie'] ?? []].flat() as string[]
      const session = cookies.find((cookie) => cookie.includes('session_token='))

      // The name an update must not change: a new one would end every session
      // an instance holds, as the move from `__Secure-` to `__Host-` did once.
      expect(session?.split('=')[0]).toBe('__Host-better-auth.session_token')

      const seen = await twice
        .http()
        .get(`${authenticationPath}/get-session`)
        .set('origin', address)
        .set('cookie', withCookies(cookies))
        .expect(200)

      expect((seen.body as { user: { email: string } }).user.email).toBe(member.email)

      const offered = await twice
        .http()
        .get(`${authenticationPath}/passkey/generate-authenticate-options`)
        .set('origin', address)
        .expect(200)

      expect((offered.body as { rpId: string }).rpId).toBe('probewerk.example.de')

      // A request that carries the cookie is where the origin is asked: from
      // either address it goes through.
      await twice
        .http()
        .post(`${authenticationPath}/sign-out`)
        .set('origin', address)
        .set('cookie', withCookies(cookies))
        .expect(200)
    }
  })

  it('still refuses a request with the cookie from an address it does not trust', async () => {
    // better-auth asks the origin of a request that carries a cookie, which is
    // the forgery the list is there for; one without a cookie has nothing to
    // forge.
    const answer = await twice
      .http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', inside)
      .send({ email: member.email, password })
      .expect(200)
    const cookie = withCookies([answer.headers['set-cookie'] ?? []].flat() as string[])

    await twice
      .http()
      .post(`${authenticationPath}/sign-out`)
      .set('origin', 'https://fremd.example.org')
      .set('cookie', cookie)
      .expect(403)

    const still = await twice
      .http()
      .get(`${authenticationPath}/get-session`)
      .set('origin', inside)
      .set('cookie', cookie)
      .expect(200)

    expect((still.body as { user: { email: string } }).user.email).toBe(member.email)
  })
})

describe('the rate limits', () => {
  /**
   * The part of the security baseline in ADR 0006 that is easiest to write
   * down and never check. Guessing a password is the attack this stops, so the
   * test guesses: six wrong passwords in a row, and the sixth is refused
   * before it is even compared.
   *
   * Its own instance, because the counter is keyed by address and path and
   * everything else in this file comes from the same address.
   */
  it('stop somebody working through passwords', async () => {
    const limited = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
      secret: 'y'.repeat(64),
      rateLimited: true,
    })

    others.push(limited)

    const statuses: number[] = []

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const answer = await limited
        .http()
        .post(`${authenticationPath}/sign-in/email`)
        .set('origin', origin)
        // As a proxy in front names the client: without, nobody can tell
        // whom to count (`perKnownAddress`).
        .set('x-forwarded-for', '203.0.113.21')
        .send({ email: member.email, password: 'immer-wieder-falsch-geraten' })

      statuses.push(answer.status)
    }

    // Not "some request failed": the last one has to be the limit and not
    // another wrong password, otherwise this test would pass with no limit
    // at all.
    expect(statuses.at(-1)).toBe(429)
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)
  })

  /**
   * The limits count by the address and the whole path, a row each, and they
   * counted before better-auth found that a path had no route: every made-up
   * path was a new row, from anybody, without a session. A path no route
   * answers is answered in front of it now, and leaves nothing behind.
   */
  it('leave nothing behind for a path no route answers', async () => {
    const limited = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
      secret: 'z'.repeat(64),
      rateLimited: true,
    })

    others.push(limited)

    for (const made of [
      'ausgedacht-1',
      'ausgedacht-2',
      'sign-in/ausgedacht',
      // The two routes with a value in their path, with values made up.
      'reset-password/ausgedacht-3',
      'callback/ausgedacht-4',
    ]) {
      await limited
        .http()
        .post(`${authenticationPath}/${made}`)
        .set('origin', origin)
        .set('x-forwarded-for', '203.0.113.22')
        .send({})
        .expect(404)
    }

    const { rows } = await admin.query<{ rows: number }>(
      "select count(*)::int as rows from auth_rate_limits where key like '%ausgedacht%'",
    )

    expect(rows[0]?.rows).toBe(0)

    // A route that is there is still reached, and counted.
    await limited
      .http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .set('x-forwarded-for', '203.0.113.22')
      .send({ email: member.email, password: 'falsch' })
      .expect(401)

    const { rows: counted } = await admin.query<{ rows: number }>(
      "select count(*)::int as rows from auth_rate_limits where key like '%sign-in/email%'",
    )

    expect(counted[0]?.rows).toBeGreaterThan(0)
  })

  /**
   * A recovery code is a second factor as much as the code from the app, and
   * an account has ten of them (#125). better-auth's plugin limits its routes
   * to three in ten seconds, which is eighteen guesses a minute; the rule of
   * ours is five a minute, like the code from the app. So five guesses, then
   * the window of the plugin is moved past, and the sixth still has to be
   * refused: only the minute of our rule refuses it there.
   */
  it('stop somebody working through recovery codes, five a minute and not eighteen', async () => {
    const limited = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
      secret: 'x'.repeat(64),
      rateLimited: true,
    })

    others.push(limited)

    const guess = () =>
      limited
        .http()
        .post(`${authenticationPath}/two-factor/verify-backup-code`)
        .set('origin', origin)
        .set('x-forwarded-for', '203.0.113.22')
        .send({ code: 'abcde-fghij' })

    await admin.query("delete from auth_rate_limits where key like '%verify-backup-code%'")

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await guess()).status).not.toBe(429)
    }

    await admin.query(
      "update auth_rate_limits set last_request = last_request - 11000 where key like '%verify-backup-code%'",
    )

    expect((await guess()).status).toBe(429)
  })

  /**
   * better-auth reads `X-Forwarded-For` only with a single entry, and counted
   * every other request in one counter (opengewerk-haustechnik#360). Now it
   * counts by the address this instance determines: the entry the proxy in
   * front appended, whatever the client wrote before it, and whatever it wrote
   * under the header the authentication reads.
   */
  it('count a client by the address the proxy in front added, not by what the client wrote', async () => {
    const limited = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
      secret: 'w'.repeat(64),
      rateLimited: true,
    })

    others.push(limited)

    const statuses: number[] = []

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const written = `198.51.100.${String(attempt)}`
      const answer = await limited
        .http()
        .post(`${authenticationPath}/sign-in/email`)
        .set('origin', origin)
        .set('x-forwarded-for', `${written}, 203.0.113.50`)
        .set('x-client-address', written)
        .send({ email: member.email, password: 'immer-wieder-falsch-geraten' })

      statuses.push(answer.status)
    }

    const keys = await admin.query<{ key: string }>(
      "select key from auth_rate_limits where key like '%198.51.100.%' or key like '%203.0.113.50%'",
    )

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    expect(keys.rows.map((row) => row.key)).toEqual(['203.0.113.50|/sign-in/email'])
  })

  /**
   * A connection at home or on a phone is given a whole /64 to pick its
   * addresses from. Counted per single address, it would never meet the limit.
   */
  it('count every address of one /64 as one client', async () => {
    const limited = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
      secret: 'u'.repeat(64),
      rateLimited: true,
    })

    others.push(limited)

    const statuses: number[] = []

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const answer = await limited
        .http()
        .post(`${authenticationPath}/sign-in/email`)
        .set('origin', origin)
        .set('x-forwarded-for', `2001:db8:4:5::${String(attempt)}`)
        .send({ email: member.email, password: 'immer-wieder-falsch-geraten' })

      statuses.push(answer.status)
    }

    const next = await limited
      .http()
      .post(`${authenticationPath}/sign-in/email`)
      .set('origin', origin)
      .set('x-forwarded-for', '2001:db8:4:6::1')
      .send({ email: member.email, password: 'immer-wieder-falsch-geraten' })

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    expect(next.status).toBe(401)
  })

  /**
   * Where nothing in front names a client, its address is the proxy's, the
   * same for everybody (opengewerk-haustechnik#360). Every such request counts
   * in one counter, under the limit of one address, never in none: two
   * clients without an address, one with no header and one whose header names
   * no address, are refused together after five wrong passwords. A client
   * whose address is known keeps its own allowance.
   */
  it('count every request whose address nobody named in one counter, under the same limit', async () => {
    const limited = await probeInstance(foundation.kit.applicationDatabaseUrl(), {
      secret: 'v'.repeat(64),
      rateLimited: true,
    })

    others.push(limited)

    const guess = (header?: string) => {
      const sending = limited
        .http()
        .post(`${authenticationPath}/sign-in/email`)
        .set('origin', origin)

      return (header === undefined ? sending : sending.set('x-forwarded-for', header)).send({
        email: member.email,
        password: 'immer-wieder-falsch-geraten',
      })
    }
    const statuses: number[] = []

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      statuses.push((await guess()).status, (await guess('unknown')).status)
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    expect((await guess('203.0.113.51')).status).toBe(401)
  })

  /**
   * The counter is in the database and not in memory, which is what makes the
   * limit survive a restart. Without it, anybody who can make the container
   * fall over gets a fresh allowance for free, and during an update that
   * happens on purpose.
   */
  it('are counted in the database, so a restart does not hand out a fresh allowance', async () => {
    const counters = await instance.database.forInstance((tx) => tx.select().from(authRateLimits))

    expect(counters.length).toBeGreaterThan(0)
  })
})

describe('an instance that has been closed', () => {
  /**
   * What an operator switches on during a restore. It is the state a server
   * is in before there is an authentication, and it stays available: closing
   * swaps the identity source and leaves better-auth unmounted, so there is
   * not even a sign in to get half way through, and the ways in for somebody
   * without an account are not on the routing table at all.
   */
  it('answers what is public and refuses everything else, the sign in included', async () => {
    const closed = await probeInstance(foundation.kit.applicationDatabaseUrl(), { closed: true })

    others.push(closed)

    const ask = () => request(closed.app.getHttpServer())

    await ask().get('/probe/health').expect(200)
    await ask().get('/probe/members').expect(401)
    await ask().get('/auth/tenants').expect(401)
    // Not mounted at all, so there is nothing to post a password to.
    await ask()
      .post(`${authenticationPath}/sign-in/email`)
      .send({ email: member.email, password })
      .expect(404)
    // Neither is the first run or the far end of a link.
    await ask().get('/setup').expect(404)
    await ask().get(`/invitation/${mintToken().token}`).expect(404)
  })
})

/**
 * A session whose time is up (opengewerk#1029). Its row went only when the
 * same cookie came back, so the network address and the browser of a device
 * nobody opens again stayed for as long as the account. The sweep takes it
 * out, and either way the stretch of work in the tenant ends when the session
 * ran out, so that the tenant's log does not say somebody is still at work.
 */
async function sessionsOf(email: string): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    `select s.id from auth_sessions s join auth_users u on u.id = s.user_id where u.email = $1`,
    [email],
  )

  return rows.map((row) => row.id)
}

/** Signs in, chooses a tenant (the north unless said) and hands back the cookies and the new session. */
async function atWork(
  email: string,
  tenantId: string = north.id,
): Promise<{ cookies: string; id: string }> {
  const before = new Set(await sessionsOf(email))
  const cookies = await signIn(email)

  await instance.chooseTenant(cookies, tenantId)

  const id = (await sessionsOf(email)).find((session) => !before.has(session))

  expect(id).toBeDefined()

  // Begun a day ago, so that a session the test lets run out an hour or two
  // back still ran out after its stretch began, as one always does.
  await admin.query(
    `update tenant_sessions set started_at = now() - interval '1 day' where session_id = $1`,
    [id],
  )

  return { cookies, id: id ?? '' }
}

async function endOfWork(sessionId: string): Promise<Date | null | undefined> {
  const { rows } = await admin.query<{ ended_at: Date | null }>(
    'select ended_at from tenant_sessions where session_id = $1',
    [sessionId],
  )

  return rows[0]?.ended_at
}

describe('a session that ran out', () => {
  it('goes with the sweep, ends its work when it ran out, and one still running stays', async () => {
    const ran = await atWork(member.email)
    const runs = await atWork(member.email)
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '2 hours' where id = $1
       returning expires_at`,
      [ran.id],
    )

    expect(await sweepExpiredSessions(instance.database)).toBeGreaterThanOrEqual(1)

    const left = await sessionsOf(member.email)

    expect(left).not.toContain(ran.id)
    expect(left).toContain(runs.id)
    expect((await endOfWork(ran.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
    expect(await endOfWork(runs.id)).toBeNull()

    const ended = await instance.database.forTenant({ tenantId: north.id }, (tx) =>
      tx
        .select({ reason: auditEntries.reason })
        .from(auditEntries)
        .where(
          and(eq(auditEntries.tableName, 'tenant_sessions'), eq(auditEntries.field, 'ended_at')),
        ),
    )

    expect(ended.some((entry) => entry.reason === 'session.expire')).toBe(true)
  })

  it('is not renewed by a request that read it a moment before it ran out', async () => {
    const ran = await atWork(member.email)
    const { rows } = await admin.query<{ expires_at: Date; user_id: string }>(
      `update auth_sessions set expires_at = now() - interval '1 minute' where id = $1
       returning expires_at, user_id`,
      [ran.id],
    )
    const read = { id: ran.id, expiresAt: new Date(Date.now() + 60_000), longLived: false }

    expect(await renewSession(instance.database, read, rows[0]?.user_id ?? '')).toBe(false)

    const after = await admin.query<{ expires_at: Date }>(
      'select expires_at from auth_sessions where id = $1',
      [ran.id],
    )

    expect(after.rows[0]?.expires_at.getTime()).toBe(rows[0]?.expires_at.getTime())
  })

  it('is not brought back by a choice of tenant that read it a moment before it ran out', async () => {
    const ran = await atWork(member.email)
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '1 minute' where id = $1
       returning expires_at`,
      [ran.id],
    )
    const expiredAt = rows[0]?.expires_at.getTime() ?? 0

    // The request reads the session by the clock of the process, a moment
    // before it ran out, and writes after it, by the clock of the database.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(expiredAt - 30_000)

    try {
      await http()
        .post('/auth/tenant')
        .set('cookie', ran.cookies)
        .set('origin', origin)
        .send({ tenantId: north.id })
        .expect(401)
    } finally {
      vi.useRealTimers()
    }

    const after = await admin.query<{ expires_at: Date }>(
      'select expires_at from auth_sessions where id = $1',
      [ran.id],
    )
    const open = await admin.query(
      'select 1 from tenant_sessions where session_id = $1 and ended_at is null',
      [ran.id],
    )

    expect(after.rows[0]?.expires_at.getTime()).toBe(expiredAt)
    // The stretch it had stays the one the sweep ends; no second one opens.
    expect(open.rowCount).toBe(1)
  })

  it('leaves the work of a session whose renewal is committed while the pass runs', async () => {
    const renewing = await atWork(member.email)

    await admin.query(
      `update auth_sessions set expires_at = now() - interval '1 minute' where id = $1`,
      [renewing.id],
    )

    // A renewal that checked the row a moment before it ran out, and commits
    // only once the pass has read the row as run out.
    const held = await admin.connect()
    let committed = false

    try {
      await held.query('begin')
      await held.query(
        `update auth_sessions set expires_at = now() + interval '12 hours' where id = $1`,
        [renewing.id],
      )

      const holder = await held.query<{ pid: number }>('select pg_backend_pid() as pid')
      const pass = sweepExpiredSessions(instance.database)
      let blocked = false

      // Until the pass waits for the row the renewal holds, and no further: a
      // pass that read the row after the commit would prove nothing.
      for (let tries = 0; tries < 200 && !blocked; tries += 1) {
        const { rows } = await admin.query<{ blocked: boolean }>(
          `select exists (
             select 1 from pg_stat_activity a where $1 = any(pg_blocking_pids(a.pid))
           ) as blocked`,
          [holder.rows[0]?.pid],
        )

        blocked = rows[0]?.blocked === true

        if (!blocked) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      await held.query('commit')
      committed = true
      await pass

      expect(blocked).toBe(true)
    } finally {
      // A connection whose transaction did not end goes, and its lock with it,
      // instead of going back to the pool holding the row.
      held.release(!committed)
    }

    expect(await sessionsOf(member.email)).toContain(renewing.id)
    expect(await endOfWork(renewing.id)).toBeNull()
  })

  it('closes the orphans also when a round fails, and reports that failure', async () => {
    const ran = await atWork(member.email)
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '1 minute' where id = $1
       returning expires_at`,
      [ran.id],
    )

    // The close of the round fails once, after its rows went: the first
    // close under the reason of the expiry, which the rounds write before the
    // orphans do.
    const forTenant = instance.database.forTenant.bind(instance.database)
    let failed = false
    const failing = vi.spyOn(instance.database, 'forTenant').mockImplementation(((
      identity: Parameters<Database['forTenant']>[0],
      work: Parameters<Database['forTenant']>[1],
    ) => {
      if (identity.reason === 'session.expire' && !failed) {
        failed = true

        return Promise.reject(new Error('closing failed'))
      }

      return forTenant(identity, work)
    }) as unknown as Database['forTenant'])

    try {
      await expect(sweepExpiredSessions(instance.database)).rejects.toThrow('closing failed')
    } finally {
      failing.mockRestore()
    }

    expect(await sessionsOf(member.email)).not.toContain(ran.id)
    // Still when it ran out: the pass knew that, and tried once more.
    expect((await endOfWork(ran.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
  })

  it('closes the stretch it carries over again when a revocation took the session meanwhile', async () => {
    const template = await atWork(member.email)
    const copy = newId<'session'>()

    // The session better-auth writes in the place of the old one at the setup
    // of the app, with its tenant, taken out by a revocation before its
    // stretch is written.
    await admin.query(
      `insert into auth_sessions (id, token, user_id, expires_at, credential_generation, active_tenant_id)
       select $1, $2, user_id, now() + interval '1 hour', credential_generation, active_tenant_id
         from auth_sessions where id = $3`,
      [copy, `token-${copy}`, template.id],
    )
    await admin.query('delete from auth_sessions where id = $1', [copy])

    await carryStretch(
      instance.database,
      { id: copy, userId: userIds.get(member.email) ?? '', activeTenantId: north.id } as {
        id: string
        userId: string
      },
      true,
    )

    const { rows } = await admin.query<{ ended: boolean }>(
      'select ended_at is not null as ended from tenant_sessions where session_id = $1',
      [copy],
    )

    expect(rows).toEqual([{ ended: true }])
  })

  it('never ends a stretch before it began', async () => {
    const working = await atWork(member.email)

    await admin.query(`update tenant_sessions set started_at = now() where session_id = $1`, [
      working.id,
    ])

    // A close worked out an hour before the stretch was opened.
    await endStretchesOf(
      instance.database,
      [{ id: working.id, userId: userIds.get(member.email) ?? '', tenantId: north.id }],
      { now: new Date(Date.now() - 60 * 60 * 1000) },
    )

    const { rows } = await admin.query<{ atItsStart: boolean }>(
      'select ended_at = started_at as "atItsStart" from tenant_sessions where session_id = $1',
      [working.id],
    )

    expect(rows).toEqual([{ atItsStart: true }])
  })

  it('takes a backlog in rounds of a bounded size, all of it in one pass', async () => {
    const template = await atWork(member.email)
    const backlog = Array.from({ length: 5 }, () => newId<'session'>())

    for (const id of backlog) {
      await admin.query(
        `insert into auth_sessions (id, token, user_id, expires_at, credential_generation)
         select $1, $2, user_id, now() - interval '1 hour', credential_generation
           from auth_sessions where id = $3`,
        [id, `token-${id}`, template.id],
      )
    }

    // Rounds of two: the five go in three rounds of the same pass.
    expect(await sweepExpiredSessions(instance.database, new Date(), 2)).toBeGreaterThanOrEqual(5)

    const left = await sessionsOf(member.email)

    expect(backlog.filter((id) => left.includes(id))).toEqual([])
    expect(left).toContain(template.id)
  })

  it('ends the work of a session that went without ending it, a release before this one', async () => {
    const gone = await atWork(member.email)

    // What better-auth did before #1029 with a session whose cookie came back
    // after it ran out: the row went, the stretch stayed open.
    await admin.query('delete from auth_sessions where id = $1', [gone.id])
    expect(await endOfWork(gone.id)).toBeNull()

    // A pass that began before the stretch did, as one that ran while the
    // stretch was opened: it does not end the stretch before it began.
    await sweepExpiredSessions(instance.database, new Date(Date.now() - 60 * 60 * 1000))

    const { rows } = await admin.query<{ ended: boolean }>(
      `select ended_at is not null and ended_at >= started_at as ended
         from tenant_sessions where session_id = $1`,
      [gone.id],
    )

    expect(rows).toEqual([{ ended: true }])
  })

  it('ends its work also when better-auth takes it out as its cookie comes back', async () => {
    const ran = await atWork(member.email)
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '1 minute' where id = $1
       returning expires_at`,
      [ran.id],
    )

    await http().get('/auth/tenants').set('cookie', ran.cookies).expect(401)

    expect(await sessionsOf(member.email)).not.toContain(ran.id)
    // The stretch stays, ended when the session ran out.
    expect((await endOfWork(ran.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
  })
})

/**
 * A new password ends the sessions of the account, and what they had open in
 * a tenant ends with them, at once, under the reason of the password and, where
 * the person set it, in their name (opengewerk#1029).
 */
describe('the work of a session a new password ends', () => {
  const another = 'ein-ganz-anderes-langes-passwort'

  async function newcomer(email: string): Promise<string> {
    const { userId } = await addStaffMember(instance.authentication, instance.database, {
      email,
      name: 'Nina Neu',
      password,
      tenantId: north.id,
      roles: ['member'],
    })

    return userId
  }

  async function stretchesOf(userId: string) {
    const { rows } = await admin.query<{
      open: boolean
      reason: string | null
      user: string | null
    }>(
      `select t.ended_at is null as open, a.reason, a.user_id as "user"
         from tenant_sessions t
         left join audit_entries a
           on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
        where t.user_id = $1`,
      [userId],
    )

    return rows
  }

  it('ends under the new password and in the name of the person when better-auth takes it out', async () => {
    const email = 'neues-passwort@example.de'
    const userId = await newcomer(email)
    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)

    const other = await signIn(email)

    await http()
      .post(`${authenticationPath}/change-password`)
      .set('cookie', other)
      .set('origin', origin)
      .send({ currentPassword: password, newPassword: another, revokeOtherSessions: true })
      .expect(200)

    expect(await stretchesOf(userId)).toEqual([
      { open: false, reason: 'password.change', user: userId },
    ])
  })

  it('ends under the new password the sessions the count of the credentials takes out, and one that ran out as run out', async () => {
    const email = 'neues-passwort-selbst@example.de'
    const userId = await newcomer(email)
    const ran = await signIn(email)

    await instance.chooseTenant(ran, north.id)
    // One that ran out before, its row still there: it ends as run out.
    await admin.query(
      `update tenant_sessions set started_at = now() - interval '1 day' where user_id = $1`,
      [userId],
    )
    await admin.query(
      `update auth_sessions set expires_at = now() - interval '1 hour' where user_id = $1`,
      [userId],
    )

    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)

    // What better-auth has not taken out when the password is written, a
    // session signed in between, goes with the count of the credentials.
    expect(await writePassword(instance.database, userId, 'neuer-hash', undefined)).not.toBeNull()

    // Each stretch with the reason of its own session: the one that ran out
    // began a day ago, the one at work just now.
    const { rows } = await admin.query<{
      ranOut: boolean
      reason: string | null
      user: string | null
    }>(
      `select t.started_at < now() - interval '12 hours' as "ranOut", a.reason, a.user_id as "user"
         from tenant_sessions t
         left join audit_entries a
           on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
        where t.user_id = $1 and t.ended_at is not null
        order by 1`,
      [userId],
    )

    expect(rows).toEqual([
      { ranOut: false, reason: 'password.reset', user: userId },
      { ranOut: true, reason: 'session.expire', user: null },
    ])
  })

  it('counts a session as at work by the moment the password took it out, not by a later one (#1034)', async () => {
    const email = 'passwort-langsam@example.de'
    const userId = await newcomer(email)
    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)

    // At work when the password takes it out, and run out a moment later,
    // by the time a slow commit is through: the expiry is set by the clock of
    // the database right before the delete, however slow everything before.
    let outAt = new Date(Number.NaN)
    let deleting = false
    const query = Client.prototype.query
    const databaseIsPast = async (moment: Date) =>
      (await admin.query<{ past: boolean }>('select clock_timestamp() > $1 as past', [moment]))
        .rows[0]?.past === true

    vi.useFakeTimers({ toFake: ['Date'], now: new Date() })
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')

      const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

      if (!deleting && /^delete from "auth_sessions"/i.test(text)) {
        deleting = true

        return admin
          .query<{ out: Date }>(
            `update auth_sessions set expires_at = clock_timestamp() + interval '400 milliseconds'
              where user_id = $1 returning expires_at as out`,
            [userId],
          )
          .then(({ rows }) => {
            outAt = rows[0]?.out ?? outAt
          })
          .then(forward)
      }

      if (deleting && /^commit/i.test(text)) {
        vi.setSystemTime(new Date(outAt.getTime() + 10_000))

        // The clock of the database past the expiry too before the commit
        // goes: a time read from it afterwards would count the session as
        // run out.
        const waitPast = async (): Promise<void> => {
          while (!(await databaseIsPast(outAt))) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }

        return waitPast().then(forward)
      }

      return forward()
    } as typeof query

    try {
      expect(await writePassword(instance.database, userId, 'neuer-hash', undefined)).not.toBeNull()
    } finally {
      Client.prototype.query = query
      vi.useRealTimers()
    }

    expect(await stretchesOf(userId)).toEqual([
      { open: false, reason: 'password.reset', user: userId },
    ])

    const { rows } = await admin.query<{ before: boolean }>(
      'select ended_at < $2 as before from tenant_sessions where user_id = $1',
      [userId, outAt],
    )

    expect(rows).toEqual([{ before: true }])
  })

  /**
   * Let in while alive and run out by the time its row goes: the work ended
   * when the session ran out, by the clock of the database (#1047).
   */
  it('ends at its expiry when a session runs out between its sign out and the delete', async () => {
    const email = 'abmelden-abgelaufen@example.de'
    const userId = await newcomer(email)
    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)
    // Begun well before, so that the end is the expiry and not the start.
    await admin.query(
      "update tenant_sessions set started_at = now() - interval '1 day' where user_id = $1",
      [userId],
    )

    const query = Client.prototype.query
    let outAt = new Date(Number.NaN)
    let done = false

    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

      if (!done && /^delete from "auth_sessions"/i.test(text)) {
        done = true

        return admin
          .query<{ out: Date }>(
            `update auth_sessions set expires_at = clock_timestamp() - interval '1 second'
              where user_id = $1 returning expires_at as out`,
            [userId],
          )
          .then(({ rows }) => {
            outAt = rows[0]?.out ?? outAt
          })
          .then(forward)
      }

      return forward()
    } as typeof query

    try {
      await http().post('/auth/sign-out').set('cookie', working).set('origin', origin).expect(201)
    } finally {
      Client.prototype.query = query
    }

    expect(done).toBe(true)
    expect(await stretchesOf(userId)).toEqual([
      { open: false, reason: 'session.expire', user: null },
    ])

    const { rows } = await admin.query<{ atExpiry: boolean }>(
      'select ended_at = $2 as "atExpiry" from tenant_sessions where user_id = $1',
      [userId, outAt],
    )

    expect(rows).toEqual([{ atExpiry: true }])
  })

  it('ends as run out, and in no name, when a session that ran out comes back to set a password', async () => {
    const email = 'abgelaufen-passwort@example.de'
    const userId = await newcomer(email)
    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)
    await admin.query(
      `update tenant_sessions set started_at = now() - interval '1 day' where user_id = $1`,
      [userId],
    )
    await admin.query(
      `update auth_sessions set expires_at = now() - interval '1 minute' where user_id = $1`,
      [userId],
    )

    // Refused, and the password stays: nothing the route would do happened.
    await http()
      .post(`${authenticationPath}/change-password`)
      .set('cookie', working)
      .set('origin', origin)
      .send({ currentPassword: password, newPassword: another, revokeOtherSessions: true })
      .expect(401)

    expect(await stretchesOf(userId)).toEqual([
      { open: false, reason: 'session.expire', user: null },
    ])
  })

  it('ends as run out a session that had run out when the command line sets a new password (#1030)', async () => {
    const email = 'kommandozeile-abgelaufen@example.de'
    const userId = await newcomer(email)
    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)
    await admin.query(
      `update tenant_sessions set started_at = now() - interval '2 hours' where user_id = $1`,
      [userId],
    )

    const ran = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '1 hour' where user_id = $1
       returning expires_at`,
      [userId],
    )

    await replacePassword(instance.authentication, instance.database, { email, password: another })

    expect(await stretchesOf(userId)).toEqual([
      { open: false, reason: 'session.expire', user: null },
    ])

    const { rows } = await admin.query<{ ended_at: Date }>(
      'select ended_at from tenant_sessions where user_id = $1',
      [userId],
    )

    expect(rows[0]?.ended_at).toEqual(ran.rows[0]?.expires_at)
  })

  it('ends at once and under the reset when the command line sets a new password', async () => {
    const email = 'kommandozeile@example.de'
    const userId = await newcomer(email)
    const working = await signIn(email)

    await instance.chooseTenant(working, north.id)
    await replacePassword(instance.authentication, instance.database, { email, password: another })

    expect(await stretchesOf(userId)).toEqual([
      { open: false, reason: 'password.reset', user: null },
    ])
  })
})

describe('work that cannot be closed when its session ends', () => {
  /**
   * Makes the closes of work that `fails` picks out fail while `run` runs, and
   * hands back what the server logged meanwhile.
   */
  async function whileClosingFails(
    fails: (identity: Parameters<Database['forTenant']>[0]) => boolean,
    run: () => Promise<unknown>,
  ): Promise<unknown[][]> {
    const forTenant = instance.database.forTenant.bind(instance.database)
    const logged: unknown[][] = []
    const failing = vi
      .spyOn(instance.database, 'forTenant')
      .mockImplementation(((
        identity: Parameters<Database['forTenant']>[0],
        work: Parameters<Database['forTenant']>[1],
      ) =>
        fails(identity)
          ? Promise.reject(new Error('closing failed'))
          : forTenant(identity, work)) as unknown as Database['forTenant'])
    const said = vi.spyOn(console, 'error').mockImplementation((...line: unknown[]) => {
      logged.push(line)
    })

    try {
      await run()
    } finally {
      failing.mockRestore()
      said.mockRestore()
    }

    return logged
  }

  async function joinedNorth(email: string): Promise<void> {
    await addStaffMember(instance.authentication, instance.database, {
      email,
      name: 'Sven Schließen',
      password,
      tenantId: north.id,
      roles: ['member'],
    })
  }

  it('does not keep a new password from being set, and the sweep closes it after', async () => {
    const email = 'schliessen-scheitert@example.de'

    await joinedNorth(email)

    const working = await atWork(email)
    const other = await signIn(email)
    const logged = await whileClosingFails(
      (identity) => identity.reason === 'password.change',
      () =>
        http()
          .post(`${authenticationPath}/change-password`)
          .set('cookie', other)
          .set('origin', origin)
          .send({
            currentPassword: password,
            newPassword: 'ein-ganz-anderes-langes-passwort',
            revokeOtherSessions: true,
          })
          .expect(200),
    )

    expect(logged).not.toHaveLength(0)
    expect(await sessionsOf(email)).not.toContain(working.id)
    expect(await endOfWork(working.id)).toBeNull()

    await sweepExpiredSessions(instance.database)

    expect(await endOfWork(working.id)).toBeInstanceOf(Date)
  })

  it('signs out also when its work cannot be closed, and the sweep closes it after (#1031)', async () => {
    const email = 'abmelden-schliessen@example.de'

    await joinedNorth(email)

    const working = await atWork(email)
    const logged = await whileClosingFails(
      (identity) => identity.reason === 'session.end',
      () =>
        http()
          .post('/auth/sign-out')
          .set('cookie', working.cookies)
          .set('origin', origin)
          .expect(201),
    )

    expect(logged).not.toHaveLength(0)
    expect(await sessionsOf(email)).not.toContain(working.id)
    expect(await endOfWork(working.id)).toBeNull()

    await sweepExpiredSessions(instance.database)

    expect(await endOfWork(working.id)).toBeInstanceOf(Date)
  })

  it('switches to another tenant also when the work in the first cannot be closed, and the sweep closes it after', async () => {
    const email = 'wechsel-schliessen@example.de'

    await joinedNorth(email)
    await addStaffMember(instance.authentication, instance.database, {
      email,
      name: 'Sven Schließen',
      password,
      tenantId: south.id,
      roles: ['member'],
    })

    const working = await atWork(email)
    const logged = await whileClosingFails(
      (identity) => identity.reason === 'session.switch',
      () => instance.chooseTenant(working.cookies, south.id),
    )
    const inNorth = async () => {
      const { rows } = await admin.query<{ ended_at: Date | null; reason: string | null }>(
        `select t.ended_at, a.reason from tenant_sessions t
           left join audit_entries a
             on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
          where t.session_id = $1 and t.tenant_id = $2`,
        [working.id, north.id],
      )

      return rows[0]
    }

    expect(logged).not.toHaveLength(0)
    expect(await inNorth()).toEqual({ ended_at: null, reason: null })

    await sweepExpiredSessions(instance.database)

    expect((await inNorth())?.reason).toBe('session.switch')
    expect((await inNorth())?.ended_at).toBeInstanceOf(Date)
    // The session works on in the tenant it chose.
    expect(await sessionsOf(email)).toContain(working.id)
  })

  it('closes the stretch a failed switch left open when the session comes back, and not the new one', async () => {
    const email = 'wechsel-zurueck@example.de'

    await joinedNorth(email)
    await addStaffMember(instance.authentication, instance.database, {
      email,
      name: 'Sven Schließen',
      password,
      tenantId: south.id,
      roles: ['member'],
    })

    const working = await atWork(email)

    await whileClosingFails(
      (identity) => identity.reason === 'session.switch',
      () => instance.chooseTenant(working.cookies, south.id),
    )
    // Back in the north before the sweep: a new stretch there, the old one open still.
    await instance.chooseTenant(working.cookies, north.id)

    const inNorth = async () => {
      const { rows } = await admin.query<{ open: boolean; reason: string | null }>(
        `select t.ended_at is null as open, a.reason from tenant_sessions t
           left join audit_entries a
             on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
          where t.session_id = $1 and t.tenant_id = $2
          order by t.started_at, t.id`,
        [working.id, north.id],
      )

      return rows
    }

    expect(await inNorth()).toEqual([
      { open: false, reason: 'session.switch' },
      { open: true, reason: null },
    ])

    await sweepExpiredSessions(instance.database)

    expect(await inNorth()).toEqual([
      { open: false, reason: 'session.switch' },
      { open: true, reason: null },
    ])
  })

  /**
   * A switch closes in the tenant it chose only what began before it. A
   * second request of the same session that chose that tenant meanwhile, to
   * register the device, keeps its stretch open (#1047).
   */
  it('leaves open the stretch another request of the session opened in the chosen tenant meanwhile', async () => {
    const email = 'wechsel-gleichzeitig@example.de'

    await joinedNorth(email)
    await addStaffMember(instance.authentication, instance.database, {
      email,
      name: 'Sven Gleichzeitig',
      password,
      tenantId: south.id,
      roles: ['member'],
    })

    const working = await atWork(email)
    const query = Client.prototype.query
    let state: 'before' | 'second' | 'done' = 'before'

    // The switch to the south has written the session; before it cleans up in
    // the south, the same session chooses the south again for its device.
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string; values?: unknown[] } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const values = (typeof config === 'string' ? args[1] : (config?.values ?? args[1])) as
        unknown[] | undefined
      const forward = () => (query as (...given: unknown[]) => Promise<unknown>).apply(this, args)

      if (
        state === 'before' &&
        /^update "tenant_sessions"/i.test(text) &&
        (values ?? []).includes(south.id)
      ) {
        state = 'second'

        return instance
          .chooseTenant(working.cookies, south.id, newId<'device'>())
          .then(() => {
            state = 'done'
          })
          .then(forward)
      }

      return forward()
    } as typeof query

    try {
      await instance.chooseTenant(working.cookies, south.id)
    } finally {
      Client.prototype.query = query
    }

    expect(state).toBe('done')

    const { rows } = await admin.query<{ open: boolean }>(
      'select ended_at is null as open from tenant_sessions where session_id = $1 and tenant_id = $2',
      [working.id, south.id],
    )

    expect(rows).toEqual([{ open: true }, { open: true }])
  })

  /**
   * The close in the tenant a switch leaves, too, takes only what began
   * before the switch. A second request of the same session that went back
   * meanwhile keeps the stretch it opened there (#1047, the review).
   */
  it('leaves open the stretch another request of the session opened in the tenant it left meanwhile', async () => {
    const email = 'wechsel-zurueck-gleichzeitig@example.de'

    await joinedNorth(email)
    await addStaffMember(instance.authentication, instance.database, {
      email,
      name: 'Sven Zurück',
      password,
      tenantId: south.id,
      roles: ['member'],
    })

    const working = await atWork(email)
    const query = Client.prototype.query
    let state: 'before' | 'back' | 'done' = 'before'

    // The switch to the south has written the session; before it closes its
    // stretch in the north, the same session goes back to the north.
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string; values?: unknown[] } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const values = (typeof config === 'string' ? args[1] : (config?.values ?? args[1])) as
        unknown[] | undefined
      const forward = () => (query as (...given: unknown[]) => Promise<unknown>).apply(this, args)

      if (
        state === 'before' &&
        /^update "tenant_sessions"/i.test(text) &&
        (values ?? []).includes(north.id)
      ) {
        state = 'back'

        return instance
          .chooseTenant(working.cookies, north.id)
          .then(() => {
            state = 'done'
          })
          .then(forward)
      }

      return forward()
    } as typeof query

    try {
      await instance.chooseTenant(working.cookies, south.id)
    } finally {
      Client.prototype.query = query
    }

    expect(state).toBe('done')

    const { rows } = await admin.query<{ open: boolean }>(
      `select ended_at is null as open from tenant_sessions where session_id = $1 and tenant_id = $2
        order by started_at, id`,
      [working.id, north.id],
    )

    expect(rows).toEqual([{ open: false }, { open: true }])
  })

  it('leaves both stretches open when a session chooses its tenant again for its device', async () => {
    const email = 'geraet-registrieren@example.de'

    await joinedNorth(email)

    const working = await atWork(email)

    // The site registers the device: the same tenant once more, with a device.
    await instance.chooseTenant(working.cookies, north.id, newId<'device'>())
    await sweepExpiredSessions(instance.database)

    const { rows } = await admin.query<{ open: boolean }>(
      'select ended_at is null as open from tenant_sessions where session_id = $1 and tenant_id = $2',
      [working.id, north.id],
    )

    expect(rows).toEqual([{ open: true }, { open: true }])
  })

  for (const when of [
    {
      after: 'which sessions have a stretch open',
      reads: /select distinct "session_id" from "tenant_sessions"/i,
      email: 'wechsel-im-lauf@example.de',
    },
    {
      after: 'the stretches themselves',
      reads: /select "id", "session_id" from "tenant_sessions"/i,
      email: 'wechsel-im-lauf-2@example.de',
    },
  ]) {
    it(`leaves the stretch of a session that left and came back while the sweep read it, away after ${when.after}`, async () => {
      const email = when.email

      await joinedNorth(email)
      await addStaffMember(instance.authentication, instance.database, {
        email,
        name: 'Sven Schließen',
        password,
        tenantId: south.id,
        roles: ['member'],
      })

      const working = await atWork(email)
      const query = Client.prototype.query
      let state: 'before' | 'away' | 'gone' | 'back' | 'done' = 'before'
      let switching = false
      const switchTo = async (tenantId: string) => {
        switching = true

        try {
          await instance.chooseTenant(working.cookies, tenantId)
        } finally {
          switching = false
        }
      }

      // Into the south once the sweep has read which sessions have a stretch
      // open in the north, and back once it has asked where they work.
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const config = args[0] as string | { text?: string; values?: unknown[] } | undefined
        const text = typeof config === 'string' ? config : (config?.text ?? '')
        const values = (typeof config === 'string' ? args[1] : (config?.values ?? args[1])) as
          unknown[] | undefined
        const forward = () => (query as (...given: unknown[]) => Promise<unknown>).apply(this, args)

        // Neither switch closes a stretch, as when its close fails: what ends
        // the stretch left behind in the north is the sweep's own work.
        if (switching && /^update "tenant_sessions"/i.test(text)) {
          return Promise.reject(new Error('The close of a switch, refused in this test'))
        }

        if (state === 'before' && when.reads.test(text) && (values ?? []).includes(north.id)) {
          state = 'away'

          return forward().then(async (result) => {
            await switchTo(south.id)
            state = 'gone'

            return result
          })
        }

        if (state === 'gone' && /"active_tenant_id" from "auth_sessions"/i.test(text)) {
          state = 'back'

          return forward().then(async (result) => {
            await switchTo(north.id)
            state = 'done'

            return result
          })
        }

        return forward()
      } as typeof query

      try {
        await endOrphanedStretches(instance.database)
      } finally {
        Client.prototype.query = query
      }

      const { rows } = await admin.query<{ open: boolean; reason: string | null }>(
        `select t.ended_at is null as open, a.reason from tenant_sessions t
         left join audit_entries a
           on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
        where t.session_id = $1 and t.tenant_id = $2
        order by t.started_at, t.id`,
        [working.id, north.id],
      )

      expect(state).toBe('done')
      expect(rows).toEqual([
        { open: false, reason: 'session.switch' },
        { open: true, reason: null },
      ])
    })
  }

  it('cuts a device off also when its work cannot be closed (#1031)', async () => {
    const email = 'geraet-schliessen@example.de'

    await joinedNorth(email)

    const device = await atWork(email)
    const keeping = await signIn(email)
    const logged = await whileClosingFails(
      (identity) => identity.reason === 'session.revoke',
      () =>
        http()
          .delete(`/auth/devices/${device.id}`)
          .set('cookie', keeping)
          .set('origin', origin)
          .expect(200),
    )

    expect(logged).not.toHaveLength(0)
    expect(await sessionsOf(email)).not.toContain(device.id)
  })

  it('does not make the command line report a password it set as not set', async () => {
    const email = 'schliessen-kommandozeile@example.de'

    await joinedNorth(email)

    const working = await atWork(email)
    let replaced: boolean | undefined

    // The record of the reset writes under the same reason in the person's
    // name; the close of the command acts for nobody.
    await whileClosingFails(
      (identity) => identity.reason === 'password.reset' && identity.userId === undefined,
      async () => {
        replaced = await replacePassword(instance.authentication, instance.database, {
          email,
          password: 'ein-ganz-anderes-langes-passwort',
        })
      },
    )

    expect(replaced).toBe(true)
    expect(await sessionsOf(email)).not.toContain(working.id)
  })
})

describe('an access past its last day', () => {
  /** A person of their own in these tenants, so that no other test sees the last day. */
  async function joined(email: string, tenants: readonly (typeof north.id)[]): Promise<string> {
    let userId = ''

    for (const tenantId of tenants) {
      ;({ userId } = await addStaffMember(instance.authentication, instance.database, {
        email,
        name: 'Lotte Letzter-Tag',
        password,
        tenantId,
        roles: ['member'],
      }))
    }

    return userId
  }

  /** Gives the access a last day this many days before today in Germany. */
  async function lastDayAgo(tenantId: string, userId: string, days: number): Promise<void> {
    await admin.query(
      `update memberships set last_day = (now() at time zone 'Europe/Berlin')::date - $3::int
        where tenant_id = $1 and user_id = $2`,
      [tenantId, userId, days],
    )
  }

  /** Midnight after the last day, in Germany: when the access ended. */
  async function endOfLastDay(tenantId: string, userId: string): Promise<number> {
    const { rows } = await admin.query<{ ended: Date }>(
      `select ((last_day + 1)::timestamp at time zone 'Europe/Berlin') as ended
         from memberships where tenant_id = $1 and user_id = $2`,
      [tenantId, userId],
    )

    return rows[0]?.ended.getTime() ?? Number.NaN
  }

  async function reasonOfEnd(sessionId: string): Promise<string | null | undefined> {
    const { rows } = await admin.query<{ reason: string | null }>(
      `select a.reason from tenant_sessions t
         join audit_entries a
           on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
        where t.session_id = $1`,
      [sessionId],
    )

    return rows[0]?.reason
  }

  /** Lets the stretch of a session begin days ago, well before the last day ended. */
  async function begunDaysAgo(sessionId: string): Promise<void> {
    await admin.query(
      `update tenant_sessions set started_at = now() - interval '5 days' where session_id = $1`,
      [sessionId],
    )
  }

  it('loses its sessions in that tenant, and its work ends with the day; elsewhere nothing changes', async () => {
    const email = 'letzter-tag@example.de'
    const userId = await joined(email, [north.id, south.id])
    const inNorth = await atWork(email)
    const inSouth = await atWork(email, south.id)
    const todayEmail = 'heute-letzter-tag@example.de'
    const todayId = await joined(todayEmail, [north.id])
    const lastToday = await atWork(todayEmail)

    await begunDaysAgo(inNorth.id)
    await lastDayAgo(north.id, userId, 2)
    await lastDayAgo(north.id, todayId, 0)

    await sweepExpiredSessions(instance.database)

    const left = await sessionsOf(email)

    expect(left).not.toContain(inNorth.id)
    expect((await endOfWork(inNorth.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(inNorth.id)).toBe('membership.end')
    // The same person in another tenant, and somebody whose last day is today.
    expect(left).toContain(inSouth.id)
    expect(await endOfWork(inSouth.id)).toBeNull()
    expect(await sessionsOf(todayEmail)).toContain(lastToday.id)
    expect(await endOfWork(lastToday.id)).toBeNull()
  })

  it('ends the work with the access when somebody signs out after the last day, before the pass', async () => {
    const email = 'letzter-tag-abmelden@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 2)
    // Signing out works, though every request into the tenant is refused.
    await http()
      .post('/auth/sign-out')
      .set('cookie', working.cookies)
      .set('origin', origin)
      .expect(201)

    expect((await endOfWork(working.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(working.id)).toBe('membership.end')
  })

  it('ends the work with the access when better-auth takes out a session that ran out after it', async () => {
    const email = 'letzter-tag-cookie@example.de'
    const userId = await joined(email, [north.id])
    const ran = await atWork(email)

    await begunDaysAgo(ran.id)
    await lastDayAgo(north.id, userId, 2)
    // Ran out a minute ago, a day after the access ended, and its cookie comes back.
    await admin.query(
      `update auth_sessions set expires_at = now() - interval '1 minute' where id = $1`,
      [ran.id],
    )
    await http().get('/auth/tenants').set('cookie', ran.cookies).expect(401)

    expect((await endOfWork(ran.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(ran.id)).toBe('membership.end')
  })

  it('ends the work with the access when a factor given up takes the other sessions out after the last day', async () => {
    const email = 'letzter-tag-faktor@example.de'
    const userId = await joined(email, [north.id])
    const kept = await atWork(email)
    const other = await atWork(email)

    await begunDaysAgo(other.id)
    await lastDayAgo(north.id, userId, 2)
    await endOtherSessions(instance.database, userId, kept.id, 'passkey.remove')

    expect((await endOfWork(other.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(other.id)).toBe('membership.end')
  })

  it('ends the work with the access when the session switches to another tenant after the last day', async () => {
    const email = 'letzter-tag-wechsel@example.de'
    const userId = await joined(email, [north.id, south.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 2)
    await instance.chooseTenant(working.cookies, south.id)

    const { rows } = await admin.query<{ ended_at: Date | null }>(
      'select ended_at from tenant_sessions where session_id = $1 and tenant_id = $2',
      [working.id, north.id],
    )

    expect(rows[0]?.ended_at?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(working.id)).toBe('membership.end')
  })

  for (const way of [
    {
      what: 'the office cuts the device off',
      email: 'letzter-tag-buero-geraet@example.de',
      run: (userId: string, sessionId: string) =>
        revokeDeviceOf(
          probeAccess,
          instance.database,
          { tenantId: north.id, userId },
          userId,
          sessionId,
        ),
    },
    {
      what: 'the office blocks the access',
      email: 'letzter-tag-sperre@example.de',
      run: (userId: string) =>
        setBlocked(probeAccess, instance.database, { tenantId: north.id, userId }, userId, true),
    },
    {
      what: 'the data of the access are removed',
      email: 'letzter-tag-daten@example.de',
      run: async (userId: string) => {
        await removeAccountData(
          probeAccess,
          instance.database,
          { tenantId: north.id, userId },
          userId,
        )
      },
    },
  ]) {
    it(`ends the work with the access when ${way.what} after the last day, before the pass`, async () => {
      const userId = await joined(way.email, [north.id])
      const working = await atWork(way.email)

      await begunDaysAgo(working.id)
      await lastDayAgo(north.id, userId, 2)
      await way.run(userId, working.id)

      expect((await endOfWork(working.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
      expect(await reasonOfEnd(working.id)).toBe('membership.end')
    })
  }

  it('ends a session that ran out before a last day moved on meanwhile when it ran out, when the office blocks the access', async () => {
    const email = 'letzter-tag-verschoben-sperre@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 3)

    // Runs out an hour after the access ended, by the last day read first.
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions s
          set expires_at = ((m.last_day + 1)::timestamp at time zone 'Europe/Berlin') + interval '1 hour'
         from memberships m
        where s.id = $1 and m.user_id = s.user_id and m.tenant_id = $2
       returning s.expires_at`,
      [working.id, north.id],
    )

    // The office moves the last day on by one, still past, as the block is
    // about to close with the end it read: the session ran out before the
    // access ended after all.
    const query = Client.prototype.query
    let moved = false

    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

      if (!moved && /from "memberships"/i.test(text) && /for share/i.test(text)) {
        moved = true

        return lastDayAgo(north.id, userId, 2).then(forward)
      }

      return forward()
    } as typeof query

    try {
      await setBlocked(probeAccess, instance.database, { tenantId: north.id, userId }, userId, true)
    } finally {
      Client.prototype.query = query
    }

    expect(moved).toBe(true)
    expect((await endOfWork(working.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
    expect(await reasonOfEnd(working.id)).toBe('session.expire')
  })

  for (const device of [
    { past: true, email: 'letzter-tag-geraet-abgelaufen@example.de' },
    { past: false, email: 'geraet-abgelaufen@example.de' },
  ]) {
    it(`ends when it ran out a device cut off after it ran out, before the pass${device.past ? ', the access ended after' : ''}`, async () => {
      const userId = await joined(device.email, [north.id])
      const gone = await atWork(device.email)
      const other = await atWork(device.email)

      await begunDaysAgo(gone.id)

      if (device.past) {
        await lastDayAgo(north.id, userId, 2)
      }

      // The list of devices shows one that ran out and the sweep has not
      // taken yet: an hour before the access ended, or an hour ago.
      const { rows } = await admin.query<{ expires_at: Date }>(
        device.past
          ? `update auth_sessions s
                set expires_at = ((m.last_day + 1)::timestamp at time zone 'Europe/Berlin') - interval '1 hour'
               from memberships m
              where s.id = $1 and m.user_id = s.user_id and m.tenant_id = $2
             returning s.expires_at`
          : `update auth_sessions set expires_at = now() - interval '1 hour' where id = $1
             returning expires_at`,
        device.past ? [gone.id, north.id] : [gone.id],
      )

      await http()
        .delete(`/auth/devices/${gone.id}`)
        .set('cookie', other.cookies)
        .set('origin', origin)
        .expect(200)

      expect((await endOfWork(gone.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
      expect(await reasonOfEnd(gone.id)).toBe('session.expire')
    })
  }

  it('asks the database when it took a device out, not the clock of the server', async () => {
    const email = 'geraet-uhr@example.de'
    const userId = await joined(email, [north.id])
    const gone = await atWork(email)
    const byTheOffice = await atWork(email)
    const other = await atWork(email)

    await begunDaysAgo(gone.id)
    await begunDaysAgo(byTheOffice.id)

    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = date_trunc('second', now()) - interval '1 hour'
        where id = any($1) returning expires_at`,
      [[gone.id, byTheOffice.id]],
    )

    // The clock of the server two hours behind the database: by it, the
    // device would still have run when it was cut off.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 2 * 60 * 60 * 1000 })

    try {
      await http()
        .delete(`/auth/devices/${gone.id}`)
        .set('cookie', other.cookies)
        .set('origin', origin)
        .expect(200)
      await revokeDeviceOf(
        probeAccess,
        instance.database,
        { tenantId: north.id, userId },
        userId,
        byTheOffice.id,
      )
    } finally {
      vi.useRealTimers()
    }

    for (const sessionId of [gone.id, byTheOffice.id]) {
      expect((await endOfWork(sessionId))?.getTime()).toBe(rows[0]?.expires_at.getTime())
      expect(await reasonOfEnd(sessionId)).toBe('session.expire')
    }
  })

  for (const way of [
    {
      what: 'a new password',
      email: 'passwort-uhr@example.de',
      run: async (userId: string) => {
        await writePassword(instance.database, userId, 'neuer-hash', undefined)
      },
    },
    {
      what: 'a factor given up',
      email: 'faktor-uhr@example.de',
      run: async (userId: string, kept: string) => {
        await endOtherSessions(instance.database, userId, kept, 'passkey.remove')
      },
    },
  ]) {
    it(`asks the database whether a session had run out when ${way.what} takes it out, not the clock of the server`, async () => {
      const userId = await joined(way.email, [north.id])
      const ran = await atWork(way.email)
      const kept = await atWork(way.email)

      await begunDaysAgo(ran.id)

      const { rows } = await admin.query<{ expires_at: Date }>(
        `update auth_sessions set expires_at = date_trunc('second', now()) - interval '1 hour'
          where id = $1 returning expires_at`,
        [ran.id],
      )

      // The clock of the server two hours behind the database: by it, the
      // session would still have run.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 2 * 60 * 60 * 1000 })

      try {
        await way.run(userId, kept.id)
      } finally {
        vi.useRealTimers()
      }

      expect((await endOfWork(ran.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
      expect(await reasonOfEnd(ran.id)).toBe('session.expire')
    })
  }

  /** A session at work in the north with five stretches open there, as choosing it again opens them. */
  async function fiveStretches(email: string, tenants: readonly (typeof north.id)[]) {
    const userId = await joined(email, tenants)
    const working = await atWork(email)

    for (let again = 0; again < 4; again += 1) {
      await instance.chooseTenant(working.cookies, north.id)
    }

    await begunDaysAgo(working.id)

    return { userId, working }
  }

  async function endsIn(sessionId: string, tenantId: string) {
    const { rows } = await admin.query<{ ended_at: Date | null; reason: string | null }>(
      `select t.ended_at, a.reason from tenant_sessions t
         left join audit_entries a
           on a.table_name = 'tenant_sessions' and a.record_id = t.id and a.field = 'ended_at'
        where t.session_id = $1 and t.tenant_id = $2`,
      [sessionId, tenantId],
    )

    return rows.map((row) => ({ at: row.ended_at?.getTime() ?? null, reason: row.reason }))
  }

  it('leaves to the next pass an access whose last day moved on to another past day while the round read it', async () => {
    const email = 'letzter-tag-runde-verschoben@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 3)

    // Runs out an hour after the access ended, by the last day read first.
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions s
          set expires_at = ((m.last_day + 1)::timestamp at time zone 'Europe/Berlin') + interval '1 hour'
         from memberships m
        where s.id = $1 and m.user_id = s.user_id and m.tenant_id = $2
       returning s.expires_at`,
      [working.id, north.id],
    )

    // The office moves the last day on by one, still past, as the round is
    // about to hold the memberships it read.
    const query = Client.prototype.query
    let moved = false

    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

      if (!moved && /from "memberships"/i.test(text) && /for share/i.test(text)) {
        moved = true

        return lastDayAgo(north.id, userId, 2).then(forward)
      }

      return forward()
    } as typeof query

    try {
      await endPastLastDays(instance.database)
    } finally {
      Client.prototype.query = query
    }

    expect(moved).toBe(true)
    expect(await endOfWork(working.id)).toBeNull()

    // The next pass reads the new end: the session ran out before it.
    await endPastLastDays(instance.database)

    expect((await endOfWork(working.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
    expect(await reasonOfEnd(working.id)).toBe('session.expire')
  })

  it('takes no second connection while a transaction of the last days is open', async () => {
    const email = 'letzter-tag-verbindung@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)
    const ranOut = await atWork(email)

    await begunDaysAgo(working.id)
    await begunDaysAgo(ranOut.id)
    await lastDayAgo(north.id, userId, 2)
    // One that ran out before the access ended, closed on a way of its own.
    await admin.query(
      `update auth_sessions s
          set expires_at = ((m.last_day + 1)::timestamp at time zone 'Europe/Berlin') - interval '1 hour'
         from memberships m
        where s.id = $1 and m.user_id = s.user_id and m.tenant_id = $2`,
      [ranOut.id, north.id],
    )

    const forTenant = instance.database.forTenant.bind(instance.database)
    const forInstance = instance.database.forInstance.bind(instance.database)
    let open = 0
    let nested = 0
    const tenants = vi.spyOn(instance.database, 'forTenant').mockImplementation(((
      identity: Parameters<Database['forTenant']>[0],
      work: Parameters<Database['forTenant']>[1],
    ) => {
      nested += open > 0 ? 1 : 0

      return forTenant(identity, async (tx) => {
        open += 1

        try {
          return await work(tx)
        } finally {
          open -= 1
        }
      })
    }) as unknown as Database['forTenant'])
    const instances = vi.spyOn(instance.database, 'forInstance').mockImplementation(((
      ...args: Parameters<Database['forInstance']>
    ) => {
      nested += open > 0 ? 1 : 0

      return forInstance(...args)
    }) as unknown as Database['forInstance'])

    try {
      await endPastLastDays(instance.database)
    } finally {
      tenants.mockRestore()
      instances.mockRestore()
    }

    expect(nested).toBe(0)
    expect(await sessionsOf(email)).not.toContain(working.id)
    expect((await endOfWork(working.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(ranOut.id)).toBe('session.expire')
  })

  it('refuses pieces of a size below 1 before it opens anything', async () => {
    await expect(endPastLastDays(instance.database, 0)).rejects.toThrow(RangeError)
    await expect(endOrphanedStretches(instance.database, 0)).rejects.toThrow(RangeError)
    await expect(endPastLastDayOf(instance.database, north.id, 'niemand', 0)).rejects.toThrow(
      RangeError,
    )
  })

  it('closes in pieces every stretch of an access that ended, however many a session opened', async () => {
    const { userId, working } = await fiveStretches('letzter-tag-stuecke@example.de', [north.id])

    await lastDayAgo(north.id, userId, 2)
    await endPastLastDays(instance.database, 2)

    const over = await endOfLastDay(north.id, userId)

    expect(await endsIn(working.id, north.id)).toEqual(
      Array.from({ length: 5 }, () => ({ at: over, reason: 'membership.end' })),
    )
  })

  /**
   * A piece whose stretch another close holds, and then closes first, closes
   * none of it. The pass goes on with the rest instead of leaving them to the
   * next one (#1047).
   */
  it('goes on past a piece that another close took first', async () => {
    const { userId, working } = await fiveStretches('letzter-tag-stueck-genommen@example.de', [
      north.id,
    ])

    await lastDayAgo(north.id, userId, 2)

    // The stretch the first piece chooses, in the order the pieces go.
    const { rows } = await admin.query<{ id: string }>(
      `select id from tenant_sessions where session_id = $1 and tenant_id = $2
        order by started_at, id limit 1`,
      [working.id, north.id],
    )
    const first = (rows[0]?.id ?? '') as (typeof tenantSessions.$inferSelect)['id']
    let written: (holder: number) => void = () => undefined
    let release: () => void = () => undefined
    const isWritten = new Promise<number>((resolve) => {
      written = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // Another close of that stretch, written and not committed yet.
    const other = instance.database.forTenant(
      { tenantId: north.id, reason: 'session.expire' },
      async (tx) => {
        await tx
          .update(tenantSessions)
          .set({ endedAt: sql`clock_timestamp()` })
          .where(eq(tenantSessions.id, first))

        const { rows: own } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)

        written(Number(own[0]?.pid))
        await released
      },
    )

    // A failure of the other close ends the wait for its signal too, and
    // shows; one of the pass shows below, once both are through.
    other.catch(() => undefined)

    const holder = await Promise.race([isWritten, other.then(() => Number.NaN)])
    const pass = endPastLastDays(instance.database, 1)

    pass.catch(() => undefined)

    let waited = false

    // The other close goes once the pass waits for it, at the stretch its
    // first piece chose, and not before.
    let settled: PromiseSettledResult<unknown>[] | undefined

    // Let go in any case, so that a failure here leaves no open transaction
    // behind for the pass and the tests after it.
    try {
      for (let tries = 0; tries < 200 && !waited; tries += 1) {
        const { rows: waiting } = await admin.query<{ n: number }>(
          'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
          [holder],
        )

        waited = (waiting[0]?.n ?? 0) > 0

        if (!waited) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    } finally {
      release()
      // Both to their end, whatever fails, and a failure still shows below.
      settled = await Promise.allSettled([pass, other])
    }

    for (const result of settled ?? []) {
      if (result.status === 'rejected') {
        throw result.reason
      }
    }

    expect(waited).toBe(true)

    const ends = await endsIn(working.id, north.id)

    expect(ends.filter((end) => end.at === null)).toEqual([])
    expect(ends.filter((end) => end.reason === 'membership.end')).toHaveLength(4)
  })

  it('closes in pieces every stretch before a block of an access that ended', async () => {
    const { userId, working } = await fiveStretches('letzter-tag-stuecke-sperre@example.de', [
      north.id,
    ])

    await lastDayAgo(north.id, userId, 2)
    await endPastLastDayOf(instance.database, north.id, userId, 2)

    const over = await endOfLastDay(north.id, userId)

    expect(await endsIn(working.id, north.id)).toEqual(
      Array.from({ length: 5 }, () => ({ at: over, reason: 'membership.end' })),
    )
  })

  it('closes in pieces the stretches a session left behind in a tenant it works in no more', async () => {
    const { working } = await fiveStretches('waisen-stuecke@example.de', [north.id, south.id])

    // At work in the south now, the stretches in the north left open, as a
    // failed close leaves them.
    await admin.query('update auth_sessions set active_tenant_id = $2 where id = $1', [
      working.id,
      south.id,
    ])
    await endOrphanedStretches(instance.database, 2)

    const ends = await endsIn(working.id, north.id)

    expect(ends.map((end) => end.reason)).toEqual(Array.from({ length: 5 }, () => 'session.switch'))
    expect(ends.every((end) => end.at !== null)).toBe(true)
  })

  it('ends at the end of the day a stretch whose session is already gone', async () => {
    const email = 'letzter-tag-verwaist@example.de'
    const userId = await joined(email, [north.id])
    const gone = await atWork(email)

    await begunDaysAgo(gone.id)
    await lastDayAgo(north.id, userId, 3)
    await admin.query('delete from auth_sessions where id = $1', [gone.id])

    await sweepExpiredSessions(instance.database)

    // At the end of the day and for that reason, not as an orphan at the time of the pass.
    expect((await endOfWork(gone.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(gone.id)).toBe('membership.end')
  })

  it('is not renewed while its access in the tenant is past its last day', async () => {
    const email = 'letzter-tag-verlaengern@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() + interval '1 hour' where id = $1
       returning expires_at`,
      [working.id],
    )
    // Renewed eleven hours ago, so that it is due.
    const read = {
      id: working.id,
      expiresAt: rows[0]?.expires_at ?? new Date(),
      longLived: false,
      activeTenantId: north.id,
    }

    await lastDayAgo(north.id, userId, 1)

    expect(await renewSession(instance.database, read, userId)).toBe(false)

    const after = await admin.query<{ expires_at: Date }>(
      'select expires_at from auth_sessions where id = $1',
      [working.id],
    )

    expect(after.rows[0]?.expires_at.getTime()).toBe(rows[0]?.expires_at.getTime())

    // With the access in force again, the same session is renewed.
    await admin.query(
      'update memberships set last_day = null where tenant_id = $1 and user_id = $2',
      [north.id, userId],
    )

    expect(await renewSession(instance.database, read, userId)).toBe(true)
  })

  /**
   * A check of the access that fails renews nothing and fails nothing: the
   * session lives until its present expiry, and the request goes on (#1047).
   */
  it('is not renewed, and fails nothing, when the check of its access fails', async () => {
    const email = 'verlaengern-pruefung-scheitert@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() + interval '1 hour' where id = $1
       returning expires_at`,
      [working.id],
    )
    const read = {
      id: working.id,
      expiresAt: rows[0]?.expires_at ?? new Date(),
      longLived: false,
      activeTenantId: north.id,
    }
    const query = Client.prototype.query
    let refused = false

    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text?: string } | undefined
      const text = typeof config === 'string' ? config : (config?.text ?? '')
      const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

      if (!refused && /from "memberships"/i.test(text)) {
        refused = true

        return Promise.reject(new Error('The check of the access, refused in this test'))
      }

      return forward()
    } as typeof query

    try {
      expect(await renewSession(instance.database, read, userId)).toBe(false)
    } finally {
      Client.prototype.query = query
    }

    expect(refused).toBe(true)

    const after = await admin.query<{ expires_at: Date }>(
      'select expires_at from auth_sessions where id = $1',
      [working.id],
    )

    expect(after.rows[0]?.expires_at.getTime()).toBe(rows[0]?.expires_at.getTime())
  })

  /**
   * A block and the removal of the data go through also when the work cannot
   * be closed with the end of the access first: their own close ends it then,
   * and the person is out (#1047).
   */
  for (const way of [
    {
      what: 'blocks',
      email: 'sperre-schliessen-scheitert@example.de',
      run: (userId: string) =>
        setBlocked(probeAccess, instance.database, { tenantId: north.id, userId }, userId, true),
    },
    {
      what: 'removes the data of the access',
      email: 'daten-schliessen-scheitert@example.de',
      run: async (userId: string) => {
        await removeAccountData(
          probeAccess,
          instance.database,
          { tenantId: north.id, userId },
          userId,
        )
      },
    },
  ]) {
    it(`${way.what} also when the close of the work with the end of the access fails`, async () => {
      const userId = await joined(way.email, [north.id])
      const working = await atWork(way.email)

      await lastDayAgo(north.id, userId, 2)

      const query = Client.prototype.query
      let refused = false

      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const config = args[0] as string | { text?: string; values?: unknown[] } | undefined
        const values = (typeof config === 'string' ? args[1] : (config?.values ?? args[1])) as
          unknown[] | undefined
        const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

        if (!refused && (values ?? []).includes('membership.end')) {
          refused = true

          return Promise.reject(new Error('The close of the work, refused in this test'))
        }

        return forward()
      } as typeof query

      try {
        await way.run(userId)
      } finally {
        Client.prototype.query = query
      }

      expect(refused).toBe(true)
      expect((await endsIn(working.id, north.id)).map((end) => end.at !== null)).toEqual([true])
    })
  }

  /**
   * The sessions of an access that ended go in the same pass as those that
   * ran out, and the pass counts them too (#1047).
   */
  it('counts the sessions of an access that ended among those it took out', async () => {
    // What other tests left goes first, so that the count is this one's.
    await sweepExpiredSessions(instance.database)

    const email = 'letzter-tag-gezaehlt@example.de'
    const userId = await joined(email, [north.id])

    await atWork(email)
    await lastDayAgo(north.id, userId, 2)

    expect(await sweepExpiredSessions(instance.database)).toBe(1)
  })

  it('ends with the access a session that was still alive then, though it ran out after', async () => {
    const email = 'letzter-tag-spaeter-abgelaufen@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 2)
    // Ran out an hour ago, a day after the access ended.
    await admin.query(
      `update auth_sessions set expires_at = now() - interval '1 hour' where id = $1`,
      [working.id],
    )

    await sweepExpiredSessions(instance.database)

    expect((await endOfWork(working.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(working.id)).toBe('membership.end')
  })

  it('ends when it ran out a session that ran out before the access ended', async () => {
    const email = 'letzter-tag-frueher-abgelaufen@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 2)

    // Ran out three days ago, before the last day ended.
    const { rows } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '3 days' where id = $1
       returning expires_at`,
      [working.id],
    )

    await sweepExpiredSessions(instance.database)

    expect(await sessionsOf(email)).not.toContain(working.id)
    expect((await endOfWork(working.id))?.getTime()).toBe(rows[0]?.expires_at.getTime())
    expect(await reasonOfEnd(working.id)).toBe('session.expire')
  })

  it('closes at the end of the day, a pass later, a stretch it could not close, and no orphan takes it', async () => {
    const email = 'letzter-tag-scheitert@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 2)

    // The close of the round fails once, and its sessions stay with it: they
    // go only after it commits.
    const forTenant = instance.database.forTenant.bind(instance.database)
    let failed = false
    const failing = vi.spyOn(instance.database, 'forTenant').mockImplementation(((
      identity: Parameters<Database['forTenant']>[0],
      work: Parameters<Database['forTenant']>[1],
    ) => {
      if (identity.reason === 'membership.end' && identity.tenantId === north.id && !failed) {
        return forTenant(identity, async (tx) => {
          await work(tx)
          failed = true

          throw new Error('closing failed')
        })
      }

      return forTenant(identity, work)
    }) as unknown as Database['forTenant'])

    try {
      await expect(sweepExpiredSessions(instance.database)).rejects.toThrow('closing failed')
    } finally {
      failing.mockRestore()
    }

    expect(await sessionsOf(email)).toContain(working.id)
    expect(await endOfWork(working.id)).toBeNull()

    // Before the next pass the session goes another way, its stretch left
    // open: the pass closes it with the access, not as an orphan.
    await admin.query('delete from auth_sessions where id = $1', [working.id])
    await sweepExpiredSessions(instance.database)

    expect((await endOfWork(working.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(working.id)).toBe('membership.end')
  })

  it('lets the expiry of that tenant wait a pass when its last days failed, and of no other', async () => {
    const email = 'letzter-tag-lauf-scheitert@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await begunDaysAgo(working.id)
    await lastDayAgo(north.id, userId, 2)
    // Ran out an hour ago, a day after the access ended.
    await admin.query(
      `update auth_sessions set expires_at = now() - interval '1 hour' where id = $1`,
      [working.id],
    )

    // Somebody in the south whose session ran out as well, with an access in force.
    const southEmail = 'sueden-abgelaufen@example.de'

    await joined(southEmail, [south.id])

    const elsewhere = await atWork(southEmail, south.id)
    const { rows: ranOut } = await admin.query<{ expires_at: Date }>(
      `update auth_sessions set expires_at = now() - interval '1 hour' where id = $1
       returning expires_at`,
      [elsewhere.id],
    )

    // The step for the last days fails in the north, before it closes anything.
    const forTenant = instance.database.forTenant.bind(instance.database)
    let failed = false
    const failing = vi.spyOn(instance.database, 'forTenant').mockImplementation(((
      identity: Parameters<Database['forTenant']>[0],
      work: Parameters<Database['forTenant']>[1],
    ) => {
      if (identity.reason === 'membership.end' && identity.tenantId === north.id && !failed) {
        failed = true

        return Promise.reject(new Error('last days failed'))
      }

      return forTenant(identity, work)
    }) as unknown as Database['forTenant'])

    try {
      await expect(sweepExpiredSessions(instance.database)).rejects.toThrow('last days failed')
    } finally {
      failing.mockRestore()
    }

    // The expiry did not take it as run out an hour ago; in the south it went on.
    expect(await sessionsOf(email)).toContain(working.id)
    expect(await endOfWork(working.id)).toBeNull()
    expect(await sessionsOf(southEmail)).not.toContain(elsewhere.id)
    expect((await endOfWork(elsewhere.id))?.getTime()).toBe(ranOut[0]?.expires_at.getTime())

    await sweepExpiredSessions(instance.database)

    expect((await endOfWork(working.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(working.id)).toBe('membership.end')
  })

  it('keeps the sessions of an access whose last day is moved on while the pass runs', async () => {
    const email = 'letzter-tag-verlaengert@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    await lastDayAgo(north.id, userId, 2)

    // An office that gives the access a new last day, and commits only once
    // the pass has read the membership as past its end.
    const held = await admin.connect()
    let committed = false
    let pass: Promise<unknown> | undefined

    try {
      await held.query('begin')
      await held.query(
        'update memberships set last_day = null where tenant_id = $1 and user_id = $2',
        [north.id, userId],
      )

      const holder = await held.query<{ pid: number }>('select pg_backend_pid() as pid')
      pass = sweepExpiredSessions(instance.database)
      // Its refusal is the test's, also while the loop still polls.
      pass.catch(() => undefined)

      let blocked = false

      for (let tries = 0; tries < 200 && !blocked; tries += 1) {
        const { rows } = await admin.query<{ blocked: boolean }>(
          `select exists (
             select 1 from pg_stat_activity a where $1 = any(pg_blocking_pids(a.pid))
           ) as blocked`,
          [holder.rows[0]?.pid],
        )

        blocked = rows[0]?.blocked === true

        if (!blocked) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      await held.query('commit')
      committed = true
      await pass

      expect(blocked).toBe(true)
    } finally {
      held.release(!committed)
      // Without the lock the pass goes on; it ends before the test does.
      await pass?.catch(() => undefined)
    }

    expect(await sessionsOf(email)).toContain(working.id)
    expect(await endOfWork(working.id)).toBeNull()
  })

  it('keeps a session that changed to another tenant while the pass took the ones working here', async () => {
    const email = 'letzter-tag-wechsel@example.de'
    const userId = await joined(email, [north.id, south.id])
    const working = await atWork(email)

    await lastDayAgo(north.id, userId, 2)

    // The pass reads the session as working in the north, and then waits
    // for the access there, which a transaction of the test holds. Meanwhile
    // the session chooses the south and commits: what the pass deletes after
    // is only what still works in the north (#1047, the review). Held at the
    // read of the sessions instead, the pass would never see the session in
    // the north, and the test would not ask the delete.
    const held = await admin.connect()
    let released = false
    let pass: Promise<unknown> | undefined

    try {
      await held.query('begin')
      await held.query(
        'select 1 from memberships where tenant_id = $1 and user_id = $2 for update',
        [north.id, userId],
      )

      const holder = await held.query<{ pid: number }>('select pg_backend_pid() as pid')

      pass = sweepExpiredSessions(instance.database)
      // Its refusal is the test's, also while the loop still polls.
      pass.catch(() => undefined)

      let blocked = false

      for (let tries = 0; tries < 200 && !blocked; tries += 1) {
        const { rows } = await admin.query<{ blocked: boolean }>(
          `select exists (
             select 1 from pg_stat_activity a where $1 = any(pg_blocking_pids(a.pid))
           ) as blocked`,
          [holder.rows[0]?.pid],
        )

        blocked = rows[0]?.blocked === true

        if (!blocked) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      await admin.query('update auth_sessions set active_tenant_id = $1 where id = $2', [
        south.id,
        working.id,
      ])
      await held.query('commit')
      released = true
      await pass

      expect(blocked).toBe(true)
    } finally {
      held.release(!released)
      // Without the lock the pass goes on; it ends before the test does.
      await pass?.catch(() => undefined)
    }

    expect(await sessionsOf(email)).toContain(working.id)
  })

  it('takes the sessions of an ended access in pieces, however many there are, and the tenant on (#1030)', async () => {
    const email = 'letzter-tag-viele@example.de'
    const userId = await joined(email, [north.id])
    const working = await atWork(email)

    // Seventy thousand sessions working in the north, more than one statement
    // takes values: what sign ins over days could leave before the last day.
    await admin.query(
      `with source as (select * from auth_sessions where id = $1)
       insert into auth_sessions
       select (jsonb_populate_record(null::auth_sessions, to_jsonb(source)
                || jsonb_build_object('id', 'viele-' || n, 'token', 'viele-token-' || n))).*
         from source, generate_series(1, 70000) n`,
      [working.id],
    )

    // Somebody else in the north whose session ran out two hours ago: the pass
    // takes it as well, and does not stop at the many.
    const nearby = 'letzter-tag-nebenan@example.de'

    await joined(nearby, [north.id])

    const other = await atWork(nearby)

    await admin.query(
      `update auth_sessions set expires_at = now() - interval '2 hours' where id = $1`,
      [other.id],
    )
    await lastDayAgo(north.id, userId, 2)
    await sweepExpiredSessions(instance.database)

    expect(await sessionsOf(email)).toEqual([])
    expect(await sessionsOf(nearby)).toEqual([])
    expect(await endOfWork(other.id)).not.toBeNull()
  }, 120_000)

  it('leaves to the last days a stretch whose access ended between reading the orphans and closing them', async () => {
    const email = 'letzter-tag-waise-mitternacht@example.de'
    const userId = await joined(email, [north.id])
    const gone = await atWork(email)

    await begunDaysAgo(gone.id)
    await admin.query('delete from auth_sessions where id = $1', [gone.id])

    // The orphans read it while the access is in force; the last day has
    // passed by the time they close it.
    const forTenant = instance.database.forTenant.bind(instance.database)
    let moved = false
    const passing = vi.spyOn(instance.database, 'forTenant').mockImplementation((async (
      identity: Parameters<Database['forTenant']>[0],
      work: Parameters<Database['forTenant']>[1],
    ) => {
      if (identity.reason === 'session.expire' && identity.tenantId === north.id && !moved) {
        moved = true
        await lastDayAgo(north.id, userId, 2)
      }

      return forTenant(identity, work)
    }) as unknown as Database['forTenant'])

    try {
      await endOrphanedStretches(instance.database)
    } finally {
      passing.mockRestore()
    }

    expect(moved).toBe(true)
    expect(await endOfWork(gone.id)).toBeNull()

    await sweepExpiredSessions(instance.database)

    expect((await endOfWork(gone.id))?.getTime()).toBe(await endOfLastDay(north.id, userId))
    expect(await reasonOfEnd(gone.id)).toBe('membership.end')
  })
})
