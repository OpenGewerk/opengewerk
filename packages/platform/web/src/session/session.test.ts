import { type TenantId, workingAsHeader } from '@opengewerk/platform-domain'
import { WebAuthnError } from '@simplewebauthn/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RequestRefused, workAs } from '../sync/transport.js'
import { deviceIdentity } from './device.js'
import { passkeyTrouble } from './passkeys.js'
import {
  keptTenantsKey,
  rememberAccount,
  rememberedAccount,
  rememberedTenants,
  rememberTenants,
  signedInBesides,
} from './remembered.js'
import {
  type Account,
  availableTenants,
  chooseTenant,
  correctAccount,
  currentAccount,
  instanceVersion,
  invitationPath,
  invitationToken,
  invite,
  passwordResetToken,
  secretFrom,
  setBlocked,
  setRoles,
  signIn,
  signOut,
  type TenantChoice,
  verifyRecoveryCode,
} from './session.js'

/**
 * The questions of the session as the interface asks them of the server, with
 * a server that answers what the test tells it to. What matters most here is
 * what happens when it does not answer at all: a device then opens with what
 * it kept, and never with more than that.
 */

const tenantId = 't-1' as TenantId

const account: Account = {
  userId: 'u-1',
  email: 'erika@probewerk.example.de',
  name: 'Erika Berg',
  tenantId,
  twoFactorEnabled: false,
  emailVerified: true,
  signInMethod: 'password',
  secondFactor: false,
}

const choice: TenantChoice = {
  id: tenantId,
  name: 'Probewerk Nord',
  roles: ['member'],
  roleLabels: ['Mitglied'],
  rights: ['shelf.read'],
  secondFactor: false,
}

interface Asked {
  readonly path: string
  readonly method: string
  readonly body: unknown
  /** The account the request named (`workingAsHeader`), if any. */
  readonly account: string | undefined
}

let asked: Asked[]
let answers: (path: string, account: string | undefined) => Response | Error

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  globalThis.localStorage.clear()
  asked = []
  answers = () => json({})

  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const account = (init?.headers as Record<string, string> | undefined)?.[workingAsHeader]

    asked.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      account,
    })

    const answer = answers(path, account)

    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  workAs(null)
})

describe('who is signed in', () => {
  it('is what the server says, and is kept for a start without a network', async () => {
    answers = () =>
      json({
        user: { id: 'u-1', email: account.email, name: account.name, twoFactorEnabled: false },
        session: { activeTenantId: tenantId, signInMethod: 'password', deviceId: 'phone-1' },
      })

    expect(await currentAccount()).toEqual({ ...account, deviceId: 'phone-1' })
    // Without the device of the session: without a network nobody knows it.
    expect(rememberedAccount()).toEqual(account)
  })

  it('is nobody when the server says so, and nothing kept outlives that', async () => {
    rememberAccount(account)
    rememberTenants([choice])
    answers = () => json(null)

    expect(await currentAccount()).toBeNull()
    expect(rememberedAccount()).toBeNull()
    expect(rememberedTenants()).toBeNull()
  })

  it('is who was signed in here last when nobody answers', async () => {
    rememberAccount(account)
    answers = () => new TypeError('Failed to fetch')

    expect(await currentAccount()).toEqual(account)
  })

  it('stays a failure when nobody answers and nobody was ever signed in here', async () => {
    answers = () => new TypeError('Failed to fetch')

    await expect(currentAccount()).rejects.toThrow(TypeError)
  })

  it('stays a failure when the server answers with an error, whoever was kept', async () => {
    // The server spoke. A device must not open on what it kept when it could
    // have been told.
    rememberAccount(account)
    answers = () => json({ message: 'Datenbank nicht erreichbar.' }, 500)

    await expect(currentAccount()).rejects.toThrow(RequestRefused)
  })

  /**
   * The second factor is the session's, as the server writes it
   * (opengewerk-haustechnik#360): the app on the account gives a session that
   * began with the password alone none, and what the server does not say is
   * not there.
   */
  it('takes the second factor from the session and not from the account', async () => {
    answers = () =>
      json({
        user: { id: 'u-1', twoFactorEnabled: true },
        session: { activeTenantId: null, signInMethod: 'password', secondFactor: false },
      })

    expect(await currentAccount()).toMatchObject({ twoFactorEnabled: true, secondFactor: false })

    answers = () =>
      json({
        user: { id: 'u-1', twoFactorEnabled: true },
        session: { activeTenantId: null, signInMethod: 'password', secondFactor: true },
      })

    expect(await currentAccount()).toMatchObject({ twoFactorEnabled: true, secondFactor: true })

    answers = () =>
      json({ user: { id: 'u-1', twoFactorEnabled: true }, session: { activeTenantId: null } })

    expect(await currentAccount()).toMatchObject({ secondFactor: false })
  })

  it('takes a sign in the server does not know the kind of for one with a password', async () => {
    answers = () =>
      json({ user: { id: 'u-1' }, session: { activeTenantId: null, signInMethod: 'smoke' } })

    expect(await currentAccount()).toMatchObject({ tenantId: null, signInMethod: 'password' })
  })
})

describe('the tenants of an account', () => {
  it('are what the server says, and are kept', async () => {
    rememberAccount(account)
    answers = () => json([choice])

    expect(await availableTenants()).toEqual([choice])
    expect(rememberedTenants()).toEqual([choice])
  })

  it('are the kept ones when nobody answers', async () => {
    rememberAccount(account)
    rememberTenants([choice])
    answers = () => json({ message: 'Bad Gateway' }, 502)

    expect(await availableTenants()).toEqual([choice])
  })

  it('stay a failure when nobody answers and none are kept', async () => {
    answers = () => new TypeError('Failed to fetch')

    await expect(availableTenants()).rejects.toThrow(TypeError)
  })
})

describe('choosing a tenant', () => {
  it('forgets which one this device opens without a network, before it asks', async () => {
    rememberAccount(account)
    answers = () => new TypeError('Failed to fetch')

    await expect(chooseTenant('t-2' as TenantId, 'device-1')).rejects.toThrow(TypeError)

    // Until the new one has been opened, the device opens none.
    expect(rememberedAccount()).toBeNull()
    expect(asked).toEqual([
      { path: '/auth/tenant', method: 'POST', body: { tenantId: 't-2', deviceId: 'device-1' } },
    ])
  })
})

describe('signing in and out', () => {
  it('says when a second factor is asked for, which is no failure', async () => {
    answers = () => json({ twoFactorRedirect: true })

    expect(await signIn('erika@probewerk.example.de', 'a password of some length')).toBe(
      'second-factor',
    )

    answers = () => json({ token: 'x' })

    expect(await signIn('erika@probewerk.example.de', 'a password of some length')).toBe(
      'signed-in',
    )
  })

  it('leaves nothing for the next start to open, also when nobody hears the sign out', async () => {
    rememberAccount(account)
    rememberTenants([choice])
    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)

    expect(rememberedAccount()).toBeNull()
    expect(globalThis.localStorage.getItem(keptTenantsKey)).toBeNull()
  })

  /** A session as get-session answers it, begun `begun` milliseconds from now by the clock of the server. */
  function aSession(id: string, user: string, begun: number) {
    return json({
      user: { id: user, email: `${user}@example.de`, name: user },
      session: {
        id,
        activeTenantId: tenantId,
        createdAt: new Date(Date.now() + begun).toISOString(),
      },
    })
  }

  it('ends at the next start a session the server did not hear was signed out of', async () => {
    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)

    // Back online, the server still knows the session from before the sign out.
    answers = (path) =>
      path.endsWith('/get-session')
        ? json({
            user: { id: 'u-1', email: account.email, name: account.name },
            session: { activeTenantId: tenantId, createdAt: '2020-01-01T00:00:00.000Z' },
          })
        : json({})

    expect(await currentAccount()).toBeNull()
    expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', method: 'POST' })

    // Ended: the next start asks the server alone.
    asked = []
    answers = () => json(null)

    expect(await currentAccount()).toBeNull()
    expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
  })

  it('ends the session it finds once after a sign out that knew no session, and keeps the next', async () => {
    // An account kept from before this browser kept the id of its session.
    rememberAccount(account)
    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)

    // Whatever session the server finds is taken for the one signed out of,
    // however late its clock says it began.
    asked = []
    answers = (path) =>
      path.endsWith('/get-session') ? aSession('s-neu', 'neu', 60 * 60_000) : json({})

    expect(await currentAccount()).toBeNull()
    expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', method: 'POST' })

    // Ended and heard: the next sign in stays.
    asked = []

    expect(await currentAccount()).toMatchObject({ userId: 'neu' })
    expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
  })

  it('tells the session signed out of by its id, whichever way the clock of the device is off', async () => {
    // The clock of the server an hour ahead of the one of the device, and an hour behind.
    for (const skew of [60, -60].map((minutes) => minutes * 60_000)) {
      // Anna signed in ten minutes ago and signs out where nobody hears it.
      const anna = () => aSession('s-anna', 'anna', skew - 10 * 60_000)
      const signedOutOffline = async () => {
        globalThis.localStorage.clear()
        answers = anna

        expect(await currentAccount()).toMatchObject({ userId: 'anna' })

        answers = () => new TypeError('Failed to fetch')

        await expect(signOut()).rejects.toThrow(TypeError)
        asked = []
      }

      // Back online, the server still has her session: ended, nobody opened.
      await signedOutOffline()
      answers = (path) => (path.endsWith('/get-session') ? anna() : json({}))

      expect(await currentAccount()).toBeNull()
      expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', method: 'POST' })

      // Ben signs in a minute later: his session stays.
      await signedOutOffline()
      answers = () => aSession('s-ben', 'ben', skew - 9 * 60_000)

      expect(await currentAccount()).toMatchObject({ userId: 'ben' })
      expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
    }
  })

  it('keeps the session signed out of through a second sign out without a network', async () => {
    const anna = () => aSession('s-anna', 'anna', -10 * 60_000)

    answers = anna

    expect(await currentAccount()).toMatchObject({ userId: 'anna' })

    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)
    // Pressed again, still without a network.
    await expect(signOut()).rejects.toThrow(TypeError)

    // Her session is still told by its id: ended at the next start.
    asked = []
    answers = (path) => (path.endsWith('/get-session') ? anna() : json({}))

    expect(await currentAccount()).toBeNull()
    expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', method: 'POST' })
  })

  /**
   * A tab still open for Anna after Ben signed in on the browser
   * (opengewerk#905): what the browser keeps of his sign in stays, his
   * account, his tenants and the id of his session, and no sign out is kept
   * for the next start.
   */
  it('leaves what the browser keeps of the account signed in since in another tab', async () => {
    answers = () => aSession('s-ben', 'ben', -60_000)

    expect(await currentAccount()).toMatchObject({ userId: 'ben' })
    rememberTenants([choice])

    answers = () => new TypeError('Failed to fetch')

    await expect(signOut('anna')).rejects.toThrow(TypeError)

    expect(rememberedAccount()?.userId).toBe('ben')
    expect(rememberedTenants()?.map((each) => each.id)).toEqual([tenantId])
    expect(globalThis.localStorage.getItem('opengewerk.session')).toBe('s-ben')
    expect(globalThis.localStorage.getItem('opengewerk.signedOut')).toBeNull()

    // A sign out of the account the browser keeps forgets it, as ever.
    await expect(signOut('ben')).rejects.toThrow(TypeError)

    expect(rememberedAccount()).toBeNull()
    expect(rememberedTenants()).toBeNull()
  })

  /**
   * Who is signed in stays known without a tenant kept to open with
   * (opengewerk#905): before a tenant is chosen, and after another was chosen
   * without a network. The server saying nobody is signed in ends it.
   */
  /**
   * Ben signed in in another tab and has no tenant yet; what the device opens
   * with is still Anna's (opengewerk#905). The answer naming Ben lets go of
   * it, and so does her sign out beside him, where nothing has asked since.
   */
  it('forgets what the person before kept to open with once somebody else is signed in', async () => {
    answers = () => aSession('s-anna', 'anna', -10 * 60_000)

    expect(await currentAccount()).toMatchObject({ userId: 'anna' })
    rememberTenants([choice])

    answers = () =>
      json({
        user: { id: 'ben', email: 'ben@example.de', name: 'Ben' },
        session: { id: 's-ben', activeTenantId: null },
      })

    expect(await currentAccount()).toMatchObject({ userId: 'ben', tenantId: null })
    expect(rememberedAccount()).toBeNull()
    expect(globalThis.localStorage.getItem(keptTenantsKey)).toBeNull()

    // Her sign out beside him, with her account still kept: nothing opens as her.
    rememberAccount({ ...account, userId: 'anna' })
    rememberTenants([choice])
    answers = () => new TypeError('Failed to fetch')

    await expect(signOut('anna')).rejects.toThrow(TypeError)

    expect(rememberedAccount()).toBeNull()
    expect(globalThis.localStorage.getItem(keptTenantsKey)).toBeNull()
    expect(signedInBesides('anna')).toBe('ben')
    await expect(currentAccount()).rejects.toThrow(TypeError)
  })

  it('knows who signed in since without a tenant, until the server says nobody is', async () => {
    answers = () =>
      json({
        user: { id: 'ben', email: 'ben@example.de', name: 'Ben' },
        session: { id: 's-ben', activeTenantId: null },
      })

    expect(await currentAccount()).toMatchObject({ userId: 'ben', tenantId: null })
    expect(signedInBesides('anna')).toBe('ben')
    expect(signedInBesides('ben')).toBeNull()

    answers = () => new TypeError('Failed to fetch')

    await expect(chooseTenant(tenantId)).rejects.toThrow(TypeError)

    expect(rememberedAccount()).toBeNull()
    expect(signedInBesides('anna')).toBe('ben')

    answers = () => json(null)

    expect(await currentAccount()).toBeNull()
    expect(signedInBesides('anna')).toBeNull()
  })

  it('keeps a session of somebody else after a second sign out without a network', async () => {
    answers = () => aSession('s-anna', 'anna', -10 * 60_000)

    expect(await currentAccount()).toMatchObject({ userId: 'anna' })

    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)
    await expect(signOut()).rejects.toThrow(TypeError)

    // Ben's session, which is not the one signed out of, stays.
    asked = []
    answers = () => aSession('s-ben', 'ben', -60_000)

    expect(await currentAccount()).toMatchObject({ userId: 'ben' })
    expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
  })

  it('ends a session begun since the last answer, when it signs out without a network', async () => {
    // Anna was signed in, the server named her session.
    answers = () => aSession('s-anna', 'anna', -10 * 60_000)

    expect(await currentAccount()).toMatchObject({ userId: 'anna' })

    // Ben signs in on this browser; the network goes before the next answer.
    answers = () => json({ token: 'x' })

    expect(await signIn('ben@example.de', 'a password of some length')).toBe('signed-in')

    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)

    // The cookie is Ben's: his session is ended, not opened as one begun anew.
    asked = []
    answers = (path) =>
      path.endsWith('/get-session') ? aSession('s-ben', 'ben', -60_000) : json({})

    expect(await currentAccount()).toBeNull()
    expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', method: 'POST' })
  })

  /**
   * A tab still open for the person before (opengewerk#882): another tab of
   * the browser signed somebody else in since, and wrote the id of that
   * session where every tab keeps it.
   */
  describe('from a tab of the person before', () => {
    /** Bert's tab asks who is signed in and keeps the id of his session. */
    async function bertSignedInElsewhere() {
      answers = (path) =>
        path.endsWith('/get-session') ? aSession('s-bert', 'bert', -60_000) : json({})

      expect(await currentAccount()).toMatchObject({ userId: 'bert' })
    }

    /** The server: a sign out naming another account than Bert's is refused (`workingAsHeader`). */
    function serverWithBert(path: string, named: string | undefined): Response {
      if (path === '/auth/sign-out' && named !== undefined && named !== 'bert') {
        return json({ code: 'other_account', message: 'Anderes Konto.' }, 409)
      }

      return path.endsWith('/get-session') ? aSession('s-bert', 'bert', -60_000) : json({})
    }

    it('ends no session of the person signed in since, heard or not', async () => {
      await bertSignedInElsewhere()
      workAs('anna')

      // Anna signs out without a network, and the sign out waits for one.
      answers = () => new TypeError('Failed to fetch')

      await expect(signOut()).rejects.toThrow(TypeError)

      // Back online, in a page that names nobody yet: the session is Bert's,
      // and it stays.
      workAs(null)
      asked = []
      answers = serverWithBert

      expect(await currentAccount()).toMatchObject({ userId: 'bert' })
      expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
    })

    it('is refused for the account it names, ends nothing of the one now, and leaves nothing to end', async () => {
      await bertSignedInElsewhere()
      // The page moved on to Bert while Anna's sign out was under way.
      workAs('bert')
      answers = serverWithBert

      await expect(signOut('anna')).resolves.toBeUndefined()
      expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', account: 'anna' })

      asked = []

      expect(await currentAccount()).toMatchObject({ userId: 'bert' })
      expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
    })

    it('leaves the session of the one now to a sign out kept without an account', async () => {
      await bertSignedInElsewhere()
      // A sign out an earlier version kept, with the id of Bert's session.
      globalThis.localStorage.setItem('opengewerk.signedOut', JSON.stringify({ session: 's-bert' }))
      workAs('anna')
      asked = []
      answers = serverWithBert

      expect(await currentAccount()).toMatchObject({ userId: 'bert' })
      expect(asked.filter((each) => each.path === '/auth/sign-out')).toHaveLength(1)

      asked = []

      expect(await currentAccount()).toMatchObject({ userId: 'bert' })
      expect(asked.map((each) => each.path)).not.toContain('/auth/sign-out')
    })
  })

  it('ends the session of the account a kept sign out names, and names it', async () => {
    answers = (path) => (path.endsWith('/get-session') ? aSession('s-1', 'u-1', -60_000) : json({}))
    await currentAccount()
    workAs('u-1')
    answers = () => new TypeError('Failed to fetch')

    await expect(signOut()).rejects.toThrow(TypeError)

    workAs(null)
    asked = []
    answers = (path) => (path.endsWith('/get-session') ? aSession('s-1', 'u-1', -60_000) : json({}))

    expect(await currentAccount()).toBeNull()
    expect(asked.at(-1)).toMatchObject({ path: '/auth/sign-out', method: 'POST', account: 'u-1' })
  })

  it('sends a recovery code without the spaces it was copied with', async () => {
    await verifyRecoveryCode('  ab12c-d34ef \n')

    expect(asked.at(-1)?.body).toEqual({ code: 'ab12c-d34ef' })
  })
})

describe('the links somebody reaches the gate with', () => {
  const token = 'A'.repeat(43)

  it('are recognised by their path and the shape of their token', () => {
    expect(invitationToken(`/einladung/${token}`)).toBe(token)
    expect(invitationToken(`/einladung/${token}/und/mehr`)).toBe(token)
    expect(invitationToken(`/einladung/${token.slice(1)}`)).toBeNull()
    expect(invitationToken(`/einladung/${token.slice(1)}!`)).toBeNull()
    expect(invitationToken(`/anderswo/${token}`)).toBeNull()
    expect(invitationToken('/einladung')).toBeNull()

    expect(passwordResetToken('/passwort/abcdefghijklmnop')).toBe('abcdefghijklmnop')
    expect(passwordResetToken('/passwort/zu-kurz')).toBeNull()
    expect(passwordResetToken(`/passwort/${'a'.repeat(65)}`)).toBeNull()
    expect(passwordResetToken(`/einladung/${token}`)).toBeNull()
  })

  it('are put together from the address the browser is at, once, for a link passed on by hand', async () => {
    answers = () => json({ token, expiresAt: '2026-10-09T08:00:00.000Z' })

    const invited = await invite({
      email: 'neu@probewerk.example.de',
      name: 'Neu Hier',
      roles: ['member'],
      send: 'link',
    })

    expect(invited).toEqual({
      link: `${globalThis.location.origin}${invitationPath}/${token}`,
      expiresAt: '2026-10-09T08:00:00.000Z',
    })
  })

  it('are not handed back at all when the server sends them by mail', async () => {
    // The token is made when the message goes out, and is in that message
    // and nowhere else.
    answers = () => json({ token: null, expiresAt: '2026-10-09T08:00:00.000Z' })

    const invited = await invite({
      email: 'neu@probewerk.example.de',
      name: 'Neu Hier',
      roles: ['member'],
      send: 'mail',
    })

    expect(invited.link).toBeNull()
  })
})

describe('what the server is asked for the people of a tenant', () => {
  it('hands on what the application keeps beside a membership, with an invitation and with the roles', async () => {
    answers = () => json({ token: null, expiresAt: '2026-10-09T08:00:00.000Z' })

    await invite({
      email: 'neu@probewerk.example.de',
      name: 'Neu Hier',
      roles: ['member'],
      send: 'mail',
      additions: { shelf: 'A3' },
    })
    await setRoles('u 2', ['guest'], { shelf: 'B1' })

    expect(asked.slice(-2).map((entry) => [entry.method, entry.path, entry.body])).toEqual([
      [
        'POST',
        '/staff',
        {
          email: 'neu@probewerk.example.de',
          name: 'Neu Hier',
          roles: ['member'],
          send: 'mail',
          additions: { shelf: 'A3' },
        },
      ],
      ['PATCH', '/staff/u%202', { roles: ['guest'], additions: { shelf: 'B1' } }],
    ])
  })

  it('names nothing of it where a screen has nothing to say', async () => {
    await setRoles('u 2', ['member'])

    expect(asked.at(-1)?.body).toEqual({ roles: ['member'] })
  })

  it('corrects an account with what is named and nothing else', async () => {
    await correctAccount('u 2', { name: 'Max Mitglied' })
    await correctAccount('u 2', { email: 'max@probewerk.example.de' })

    expect(asked.map((entry) => [entry.method, entry.path, entry.body])).toEqual([
      ['PATCH', '/staff/u%202/account', { name: 'Max Mitglied' }],
      ['PATCH', '/staff/u%202/account', { email: 'max@probewerk.example.de' }],
    ])
  })

  it('shuts somebody out with one method and lets them back in with the other', async () => {
    await setBlocked('u 2', true)
    await setBlocked('u 2', false)

    expect(asked.map((entry) => [entry.method, entry.path])).toEqual([
      ['PUT', '/staff/u%202/block'],
      ['DELETE', '/staff/u%202/block'],
    ])
  })
})

describe('what a screen shows of an answer', () => {
  it('is the secret out of the address an authenticator app is fed, or nothing', () => {
    expect(secretFrom('otpauth://totp/Probewerk:erika?secret=JBSWY3DPEHPK3PXP&issuer=P')).toBe(
      'JBSWY3DPEHPK3PXP',
    )
    expect(secretFrom('otpauth://totp/Probewerk:erika')).toBe('')
    expect(secretFrom('not an address')).toBe('')
  })

  it('is the version the health check names, or none', async () => {
    answers = () => json({ status: 'ok', version: '0.4.0' })
    expect(await instanceVersion()).toBe('0.4.0')

    answers = () => json({ status: 'ok' })
    expect(await instanceVersion()).toBeNull()

    answers = () => json({ status: 'ok', version: '' })
    expect(await instanceVersion()).toBeNull()
  })
})

describe('what went wrong with a passkey', () => {
  const application = { name: 'Probewerk' }
  const fallback = 'Das hat nicht geklappt.'

  it('is the sentence of the server where the refusal is its own', () => {
    const refused = new RequestRefused(403, 'Bitte zuerst noch einmal bestätigen.', {
      code: 'RECONFIRMATION_REQUIRED',
    })

    expect(passkeyTrouble(refused, fallback, application)).toBe(
      'Bitte zuerst noch einmal bestätigen.',
    )
    // A route under `/auth` carries no code: its sentence is one already.
    expect(
      passkeyTrouble(
        new RequestRefused(404, 'Diesen Passkey gibt es nicht.'),
        fallback,
        application,
      ),
    ).toBe('Diesen Passkey gibt es nicht.')
  })

  it('says that the credentials changed where a revocation overtook the sign in', () => {
    const revoked = new RequestRefused(
      401,
      'Die Zugangsdaten dieses Kontos wurden geändert. Bitte noch einmal anmelden.',
      { code: 'SESSION_REVOKED' },
    )

    expect(passkeyTrouble(revoked, fallback, application)).toBe(
      'Die Zugangsdaten dieses Kontos wurden geändert. Bitte noch einmal anmelden.',
    )
  })

  it('names the application by the name it was given, and by no other', () => {
    const unknown = new RequestRefused(400, 'Passkey not found', { code: 'PASSKEY_NOT_FOUND' })

    expect(passkeyTrouble(unknown, fallback, application)).toBe(
      'Diesen Passkey kennt Probewerk nicht, vielleicht wurde er gelöscht. Die Anmeldung mit dem Passwort geht weiter.',
    )
    expect(passkeyTrouble(unknown, fallback, { name: 'Anderswerk' })).toContain(
      'kennt Anderswerk nicht',
    )
  })

  it('is translated where the plugin or the browser speaks, and the fallback otherwise', () => {
    expect(
      passkeyTrouble(
        new RequestRefused(400, 'Challenge not found', { code: 'CHALLENGE_NOT_FOUND' }),
        fallback,
        application,
      ),
    ).toMatch(/^Die Anfrage an den Browser ist abgelaufen/)
    expect(
      passkeyTrouble(
        new RequestRefused(429, 'Too many requests', { code: 'TOO_MANY' }),
        fallback,
        application,
      ),
    ).toBe('Zu viele Versuche hintereinander. Bitte in einer Minute noch einmal.')
    expect(
      passkeyTrouble(
        new RequestRefused(400, 'Something new', { code: 'SOMETHING_NEW' }),
        fallback,
        application,
      ),
    ).toBe(fallback)
    expect(
      passkeyTrouble(
        new WebAuthnError({
          message: 'aborted',
          code: 'ERROR_CEREMONY_ABORTED',
          cause: new Error('aborted'),
        }),
        fallback,
        application,
      ),
    ).toBe('Abgebrochen, oder die Zeit am Gerät ist abgelaufen.')

    const notAllowed = new Error('The operation is not allowed')

    notAllowed.name = 'NotAllowedError'

    expect(passkeyTrouble(notAllowed, fallback, application)).toBe(
      'Abgebrochen, oder die Zeit am Gerät ist abgelaufen.',
    )
    expect(passkeyTrouble(new Error('anything else'), fallback, application)).toBe(fallback)
  })
})

describe('the identity of a device', () => {
  it('is minted once and kept, under the name every installation keeps it by', () => {
    const first = deviceIdentity()

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(deviceIdentity()).toBe(first)
    expect(globalThis.localStorage.getItem('opengewerk.device')).toBe(first)
  })

  it('is a fresh one every time where a browser refuses to keep it', () => {
    // A longer device list and nothing worse; refusing to run would be worse.
    const refusing = {
      getItem: () => {
        throw new DOMException('refused', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('refused', 'SecurityError')
      },
    } as unknown as Storage

    const one = deviceIdentity(refusing)
    const two = deviceIdentity(refusing)

    expect(one).toMatch(/^[0-9a-f-]{36}$/)
    expect(two).not.toBe(one)
  })
})
