import {
  invitationPath,
  isSignInMethod,
  type LegalTextKind,
  type LegalTexts,
  type RoleDefinition,
  type SignInMethod,
  type TenantChoice as ChoiceOf,
  type TenantId,
} from '@opengewerk/platform-domain'

import { accountHeader, isOtherAccount, pageAccount, request } from '../sync/transport.js'

import {
  forgetAccount,
  forgetOpeningAccount,
  forgetSignIn,
  rememberAccount,
  rememberedAccount,
  rememberedTenants,
  rememberSignedIn,
  rememberTenants,
  signedInBesides,
  unreachable,
} from './remembered.js'

/**
 * The three steps between opening the application and being able to work,
 * exactly as ADR 0006 cuts them.
 *
 * Who are you, which tenant, and only then what may you do. The middle step
 * is the one that is easy to skip and impossible to add later: a session that
 * carries no tenant would have to be given one by every request, and then the
 * answer to "which tenant" comes from the caller instead of from the session.
 * Row level security would isolate that tenant perfectly, for whoever asked.
 */

/** Where better-auth's own routes are mounted, in front of the API. */
const authentication = '/api/auth'

/**
 * The shortest password the server accepts for an account somebody sets up
 * for themselves.
 *
 * Said here as well so that the screen can refuse a short one without a round
 * trip, and only here, so that the two screens that ask for a password do not
 * each carry a twelve of their own. The server keeps the same floor and is
 * the one that decides; this is the courtesy in front of it.
 */
export const shortestPassword = 12

export interface Account {
  readonly userId: string
  readonly email: string
  readonly name: string
  /** Null until a tenant has been chosen for this session. */
  readonly tenantId: TenantId | null
  /**
   * Whether a second factor is set up. Whether one is required follows from
   * the roles of the memberships, so the two are asked separately and only the
   * pair answers "can this person work here" (ADR 0006).
   */
  readonly twoFactorEnabled: boolean
  /**
   * Whether the address of the account was confirmed by a link in a mail to
   * it (opengewerk#754). Left out, as by an account kept on the device from
   * before, it was.
   */
  readonly emailVerified?: boolean
  /** With what this session was signed in (#167), the password or a passkey. */
  readonly signInMethod: SignInMethod
  /**
   * Whether this session carries a second factor, which the server writes
   * when it begins (opengewerk-haustechnik#360): with the code from the app,
   * a recovery code or a passkey, or in the session the app was set up in.
   * The gate asks this and not `twoFactorEnabled`, as the server does: a
   * session that began with the password alone has none, whatever the
   * account has since.
   */
  readonly secondFactor: boolean
  /**
   * The device this session is registered for, null where it is registered
   * for none. Not there on an account kept from an earlier start: without a
   * network nobody knows.
   */
  readonly deviceId?: string | null
}

/**
 * One of the tenants this account works in, as the server tells it: the keys
 * of the roles, what the tenant calls them, and the rights they add up to
 * there at the moment of asking (ADR 0010). The screens decide by these
 * rights what to offer, which are the ones the guard asks on every request.
 *
 * Which rights there are is the catalogue of the application; to this code a
 * right is a string, and a screen asks for one by its name.
 */
export type TenantChoice<Right extends string = string> = ChoiceOf<Right>

export interface DeviceEntry {
  readonly sessionId: string
  readonly userAgent: string | null
  readonly deviceId: string | null
  readonly longLived: boolean
  readonly signedInAt: string
  readonly expiresAt: string
  readonly current: boolean
  /** Where the session was signed in from, where the web server in front said so (#563). */
  readonly ipAddress: string | null
}

/**
 * What signing in produced. `second-factor` is not a failure: the password was
 * right and the account has TOTP switched on, which whoever leads a tenant
 * must.
 */
export type SignInOutcome = 'signed-in' | 'second-factor'

interface SessionAnswer {
  readonly user?: {
    readonly id?: unknown
    readonly email?: unknown
    readonly name?: unknown
    readonly twoFactorEnabled?: unknown
    readonly emailVerified?: unknown
  }
  readonly session?: {
    readonly activeTenantId?: unknown
    readonly signInMethod?: unknown
    readonly secondFactor?: unknown
    readonly deviceId?: unknown
    readonly id?: unknown
  }
}

/**
 * The session this browser last opened, by the id the server gives it. A
 * sign out keeps it as the one it signed out of.
 */
const sessionKey = 'opengewerk.session'

/**
 * The sign out of this browser the server has not confirmed: the session it
 * was of. A sign out without a network forgets everything here, but
 * the cookie of the session is the server's and outlives it: the next start
 * would have found the session again and opened it for whoever comes next.
 * Kept until the server ends that session, or until another session shows
 * somebody signed in anew.
 */
const signedOutKey = 'opengewerk.signedOut'

interface SignedOut {
  /** The id of the session signed out of, when this browser knew it. */
  readonly session: string | null
  /**
   * The account the page signed out of, when it named one (opengewerk#882).
   * The id of the session is kept where every tab of the browser keeps it,
   * and a tab still open for the person before found the id of the next
   * person's session there: its sign out would have ended theirs.
   */
  readonly account: string | null
}

function kept(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key)
  } catch {
    return null
  }
}

function keep(key: string, value: string | null): void {
  try {
    if (value === null) {
      globalThis.localStorage.removeItem(key)
    } else {
      globalThis.localStorage.setItem(key, value)
    }
  } catch {
    // A browser that keeps nothing keeps no session either.
  }
}

/**
 * Forgets the id kept of the session, before anything that may begin a new
 * one: a sign in by password, a second factor or a passkey, the first run,
 * an invitation redeemed, a password changed or reset. The cookie of the new
 * session replaces the old, while the id stayed the old one until the next
 * answer of `get-session`: a sign out without a network in between kept the
 * old id, and the next start opened the new session as somebody else's.
 * Without an id a sign out ends whatever session it finds (`signedOutOf`).
 */
export function forgetSessionId(): void {
  keep(sessionKey, null)
}

/** The sign out kept for the server (`signedOutKey`), or null where none is or it does not read. */
function signedOut(): SignedOut | null {
  try {
    const raw: unknown = JSON.parse(kept(signedOutKey) ?? 'null')

    if (typeof raw !== 'object' || raw === null) {
      return null
    }

    if (!('session' in raw)) {
      return null
    }

    const { session, account } = raw as { session?: unknown; account?: unknown }

    return {
      session: typeof session === 'string' && session !== '' ? session : null,
      account: typeof account === 'string' && account !== '' ? account : null,
    }
  } catch {
    return null
  }
}

/**
 * Whether the session the server found is the one signed out of. Told by its
 * id, so that no clock has to agree with another: compared by time, a device
 * whose clock was behind the server's opened the session of the person before
 * for the next, and one whose clock was ahead ended a sign in just made. A
 * sign out that knew no id, of an account this browser kept from before it
 * kept ids, takes the session it finds for the one signed out of. Ended once
 * too often is a sign in to make again; opened once too often is the work of
 * somebody else.
 *
 * A sign out that names its account ends a session of that account alone
 * (opengewerk#882): a session of another is somebody else's sign in since,
 * whatever id the browser kept.
 */
function signedOutOf(
  session: SessionAnswer['session'],
  userId: string,
  pending: SignedOut,
): boolean {
  return (
    (pending.account === null || pending.account === userId) &&
    (pending.session === null || typeof session?.id !== 'string' || session.id === pending.session)
  )
}

/** Who is signed in on this browser, or nobody. */
export async function currentAccount(): Promise<Account | null> {
  let answer: SessionAnswer | null

  try {
    answer = await request<SessionAnswer | null>(`${authentication}/get-session`)
  } catch (error) {
    // Nobody answered, which is not the same as "nobody is signed in". The
    // device then works with who was signed in here last, so that it opens
    // the day's work in a basement (#123); the server decides again at the
    // first request that reaches it. With nobody kept, the failure stays a
    // failure and the gate says the device needs a network once.
    const kept = unreachable(error) ? rememberedAccount() : null

    if (kept) {
      return kept
    }

    throw error
  }

  const user = answer?.user
  const pending = signedOut()

  if (pending !== null && user && typeof user.id === 'string') {
    if (signedOutOf(answer?.session, user.id, pending)) {
      // The session of whoever signed out here, which the server never
      // heard about: ended now, and nobody is signed in. Without an answer
      // it stays to be ended at the next start.
      forgetSignIn()

      try {
        await request('/auth/sign-out', {
          method: 'POST',
          headers: accountHeader(pending.account ?? undefined),
        })
        keep(signedOutKey, null)

        return null
      } catch (error) {
        if (!isOtherAccount(error)) {
          // Asked again next time.
          return null
        }

        // The page names another account than the session's (opengewerk#882),
        // for a sign out kept without one: the session is somebody else's
        // sign in since, and not this sign out's to end. Who it is goes on
        // below.
      }
    }
  }

  if (pending !== null) {
    // Nobody signed in, or somebody anew since: nothing left to end.
    keep(signedOutKey, null)
  }

  if (!user || typeof user.id !== 'string') {
    // The server said so, and it decides: nothing kept outlives that.
    forgetSignIn()
    keep(sessionKey, null)

    return null
  }

  const tenantId = answer?.session?.activeTenantId
  const signInMethod = answer?.session?.signInMethod
  const deviceId = answer?.session?.deviceId
  const account: Account = {
    userId: user.id,
    email: typeof user.email === 'string' ? user.email : '',
    name: typeof user.name === 'string' ? user.name : '',
    tenantId: typeof tenantId === 'string' ? (tenantId as TenantId) : null,
    twoFactorEnabled: user.twoFactorEnabled === true,
    emailVerified: user.emailVerified !== false,
    signInMethod: isSignInMethod(signInMethod) ? signInMethod : 'password',
    secondFactor: answer?.session?.secondFactor === true,
    deviceId: typeof deviceId === 'string' && deviceId !== '' ? deviceId : null,
  }

  // Somebody else than the person kept to open with (opengewerk#905): what
  // was kept of the one before goes now, also where this one has no tenant
  // yet and nothing of theirs takes its place. A device opened without a
  // network after that opened as the person before.
  const before = rememberedAccount()

  if (before !== null && before.userId !== account.userId) {
    forgetOpeningAccount()
  }

  rememberAccount(account)
  // Also without a tenant, and left alone when another is chosen: a sign out
  // in the tab of the person before asks it (opengewerk#905).
  rememberSignedIn(account.userId)
  keep(sessionKey, typeof answer?.session?.id === 'string' ? answer.session.id : null)

  return account
}

/**
 * Whether this instance has never been used and is waiting to be set up.
 *
 * Asked only when nobody is signed in, which is the one moment the answer
 * matters. A signed in browser never pays for the question.
 */
export async function setupNeeded(): Promise<boolean> {
  const answer = await request<{ needed?: unknown }>('/setup')

  return answer.needed === true
}

/**
 * The version this installation runs, as the health check names it (#259),
 * for the foot of the sign in. Null for a checkout, which has none to name,
 * and for any answer that carries none.
 */
export async function instanceVersion(): Promise<string | null> {
  const answer = await request<unknown>('/health')
  const version =
    typeof answer === 'object' && answer !== null ? (answer as { version?: unknown }).version : null

  return typeof version === 'string' && version !== '' ? version : null
}

/**
 * The legal texts of the instance (opengewerk-haustechnik#129), for the foot
 * of the sign in and the page they stand on: asked without a session and
 * without a tenant, as anybody may read them.
 */
export function legalTexts(): Promise<LegalTexts> {
  return request<LegalTexts>('/legal-texts')
}

/** Where the legal texts stand: the legal notice at this path, the notice on data protection under it. */
export const legalPath = '/rechtliches'

/** The address of the page of one legal text. */
export function legalAddress(kind: LegalTextKind): string {
  return kind === 'imprint' ? legalPath : `${legalPath}/datenschutz`
}

/** Which legal text the address bar asks for, or null when it asks for none. */
export function legalPage(path: string): LegalTextKind | null {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path

  return trimmed === legalPath ? 'imprint' : trimmed === legalAddress('privacy') ? 'privacy' : null
}

export interface FirstRun {
  /**
   * The code from `docker/.env` on the server (#215), sent as typed: case,
   * spaces and the dash are the server's business, which compares them away.
   */
  readonly setupCode: string
  readonly company: string
  readonly name: string
  readonly email: string
  readonly password: string
}

/**
 * The first tenant, the first account and the membership between them.
 *
 * Signing in afterwards is a separate call and deliberately so: it is the
 * ordinary sign in, with the ordinary cookie and the ordinary rate limit, and
 * a route that handed out a session of its own would be a second way in to
 * keep right.
 */
export async function runSetup(firstRun: FirstRun): Promise<{ tenantId: TenantId }> {
  forgetSessionId()

  return request<{ tenantId: TenantId }>('/setup', {
    method: 'POST',
    body: JSON.stringify(firstRun),
  })
}

/** The secret and the codes a second factor is set up from, shown once. */
export interface SecondFactorStart {
  readonly totpUri: string
  readonly backupCodes: readonly string[]
}

/**
 * Starts setting up a second factor. The password is asked for again because
 * better-auth asks for it: this is the one change to an account that hands out
 * a way in, and a screen somebody walked away from should not be enough.
 *
 * Nothing is switched on yet. The factor counts as set up once a code from it
 * has been checked, which is what keeps a mistyped secret from locking
 * somebody out of their own instance.
 */
export async function startSecondFactor(password: string): Promise<SecondFactorStart> {
  const answer = await request<{ totpURI?: unknown; backupCodes?: unknown }>(
    `${authentication}/two-factor/enable`,
    { method: 'POST', body: JSON.stringify({ password, method: 'totp' }) },
  )

  return {
    totpUri: typeof answer.totpURI === 'string' ? answer.totpURI : '',
    backupCodes: Array.isArray(answer.backupCodes)
      ? answer.backupCodes.filter((code): code is string => typeof code === 'string')
      : [],
  }
}

/**
 * The secret out of the address the authenticator app is fed.
 *
 * For the line under the picture. A camera is the usual way in and a printed
 * row of characters is the way that still works on a machine with no camera,
 * behind a proxy that mangles images, or for somebody who cannot see the code.
 */
export function secretFrom(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get('secret') ?? ''
  } catch {
    return ''
  }
}

export async function signIn(email: string, password: string): Promise<SignInOutcome> {
  forgetSessionId()

  const answer = await request<{ twoFactorRedirect?: boolean }>(`${authentication}/sign-in/email`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })

  return answer.twoFactorRedirect === true ? 'second-factor' : 'signed-in'
}

export async function verifySecondFactor(code: string): Promise<void> {
  forgetSessionId()

  await request(`${authentication}/two-factor/verify-totp`, {
    method: 'POST',
    // `trustDevice` is deliberately not sent. It would let a browser skip the
    // second factor next time, and the second factor is the one thing between
    // a stolen password and everything a tenant keeps.
    body: JSON.stringify({ code }),
  })
}

/**
 * The second step of a sign in with a recovery code instead of the code from
 * the app, for somebody whose phone is gone (#125). Each code works once.
 */
export async function verifyRecoveryCode(code: string): Promise<void> {
  forgetSessionId()

  await request(`${authentication}/two-factor/verify-backup-code`, {
    method: 'POST',
    // `trustDevice` is not sent here either, for the same reason as above.
    body: JSON.stringify({ code: code.trim() }),
  })
}

/** How many recovery codes this account has left; `null` without a second factor. */
export async function recoveryCodesLeft(): Promise<number | null> {
  const answer = await request<{ left?: unknown }>('/auth/recovery-codes')

  return typeof answer.left === 'number' ? answer.left : null
}

/**
 * A new set of recovery codes, which replaces the old one entirely. Asks for
 * the password and the code from the app, as a sign in does: a session left
 * open at a desk, or the password alone, must not be enough to make a new way
 * past the second factor (opengewerk-haustechnik#360). The two go first to
 * the confirmation (`reconfirm`), and the password once more to the route of
 * better-auth, which asks for it itself.
 */
export async function newRecoveryCodes(password: string, code: string): Promise<readonly string[]> {
  await request(`${authentication}/reconfirm`, {
    method: 'POST',
    body: JSON.stringify({ password, code: code.trim() }),
  })

  const answer = await request<{ backupCodes?: unknown }>(
    `${authentication}/two-factor/generate-backup-codes`,
    { method: 'POST', body: JSON.stringify({ password }) },
  )

  return Array.isArray(answer.backupCodes)
    ? answer.backupCodes.filter((code): code is string => typeof code === 'string')
    : []
}

/**
 * The tenants of this account and what its roles add up to in each. Without
 * a network, the ones kept from the last answer (#184), so that a device
 * opened in a basement shows the screens its rights allow; the server
 * decides again at the first request that reaches it, as with the account.
 */
export async function availableTenants(): Promise<readonly TenantChoice[]> {
  try {
    const tenants = await request<readonly TenantChoice[]>('/auth/tenants')

    rememberTenants(tenants)

    return tenants
  } catch (error) {
    const kept = unreachable(error) ? rememberedTenants() : null

    if (kept) {
      return kept
    }

    throw error
  }
}

/**
 * Picks the tenant this session works in.
 *
 * The device id goes along on the site entry and not in the office, and that
 * is what decides the length of the session: thirty days on a registered
 * device, twelve hours at a desk somebody walks away from.
 */
export async function chooseTenant(tenantId: TenantId, deviceId?: string): Promise<void> {
  // The tenant this device opens without a network changes with it; until
  // the new one has been opened, it opens none (#123).
  forgetAccount()
  await request('/auth/tenant', {
    method: 'POST',
    body: JSON.stringify({ tenantId, deviceId }),
  })
}

/**
 * Registers this device for the session, in the tenant it works in already,
 * as the sign in on the site does: what that device sends through the sync
 * and what the server answers about it are then the same device's, and the
 * session is the long one of a device (ADR 0006).
 *
 * For a session that reached the site without it: signed in at a desk and
 * sent on to the site on a phone, or registered for this device before its
 * storage was emptied. The tenant does not change, so what the device opens
 * without a network stays as it is.
 */
export async function registerDevice(tenantId: TenantId, deviceId: string): Promise<void> {
  await request('/auth/tenant', {
    method: 'POST',
    body: JSON.stringify({ tenantId, deviceId }),
  })
}

export function devices(): Promise<readonly DeviceEntry[]> {
  return request<readonly DeviceEntry[]>('/auth/devices')
}

export async function revokeDevice(sessionId: string): Promise<void> {
  await request(`/auth/devices/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

/**
 * Signs `account` out, by default the account the page works for now. The
 * caller names it where the page may move on to another account while the
 * sign out is under way (`SignOutButton`, opengewerk#882): the sign out is of
 * the account whose screen asked for it, and the server refuses it for any
 * other. Refused so, the account signed out of has no session on this
 * browser any more, and the other one is not this sign out's to end.
 */
export async function signOut(account: string | null = pageAccount()): Promise<void> {
  // Another account signed in on this browser since (opengewerk#905): the
  // account kept, its tenants and the id of its session are theirs, and so is
  // the cookie. Nothing of it is forgotten, and no sign out is kept for the
  // next start, which would end a sign in of this account made since. The
  // server is asked all the same: it refuses for the other session
  // (opengewerk#882), and ends this account's where the cookie is its own
  // again before the page has heard of it.
  if (signedInBesides(account) !== null) {
    // Except where what is kept to open with is still this account's: the
    // one signed in since has no tenant yet, and nothing of theirs replaced
    // it. A start without a network opened as this account after its sign out.
    if (rememberedAccount()?.userId === account) {
      forgetOpeningAccount()
    }

    try {
      await request('/auth/sign-out', {
        method: 'POST',
        headers: accountHeader(account ?? undefined),
      })
    } catch (error) {
      if (!isOtherAccount(error)) {
        throw error
      }
    }

    return
  }

  // First, so that a sign out without a network still leaves nothing for the
  // next start to open on its own (#123), nor the roles of whoever it was (#184).
  const signedIn = rememberedAccount() !== null
  const session = kept(sessionKey)

  forgetSignIn()

  // A sign out of nobody leaves the one before as it was. A second one
  // without a network, after the first, found no id kept and wrote a sign out
  // that knew none, and the next start ended whatever session it found, the
  // one of somebody who had signed in since among them. The browser holds one
  // cookie, and it is still the one of the session signed out of first.
  if (signedIn || signedOut() === null) {
    keep(signedOutKey, JSON.stringify({ session, account } satisfies SignedOut))
  }

  keep(sessionKey, null)

  try {
    await request('/auth/sign-out', {
      method: 'POST',
      headers: accountHeader(account ?? undefined),
    })
  } catch (error) {
    if (!isOtherAccount(error)) {
      throw error
    }
  }

  keep(signedOutKey, null)
}

/**
 * Who works in this tenant, and what can be done about it at a desk.
 *
 * Behind `membership.read` and `membership.write`, which whoever leads the
 * tenant has. The screen that uses them lives in the office entry because
 * that is where a desk is.
 */

export interface StaffEntry {
  readonly userId: string
  readonly name: string
  readonly email: string
  /** The keys of the roles, as the tenant has them (`staffRoles`). */
  readonly roles: readonly string[]
  /** Null while they work here, a moment in time once they were shut out. */
  readonly blockedAt: string | null
  /** When this tenant last saw them start work, not the instance. */
  readonly lastSignInAt: string | null
  readonly twoFactorEnabled: boolean
  /** Whether the account has a passkey, a second factor as well (#167). */
  readonly hasPasskey: boolean
  /** The last day they work here, none for an access without an end (for opengewerk-haustechnik#339). */
  readonly lastDay?: string | null
  /** A corrected address that waits for the person to open its link (opengewerk#754). */
  readonly pendingEmail?: string | null
  readonly pendingUntil?: string | null
}

/** Where the message with an invitation stands, for one sent by mail. */
export interface InvitationMail {
  readonly status: 'pending' | 'sent' | 'failed'
  readonly sentAt: string | null
  readonly lastError: string | null
}

export interface InvitationEntry {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly roles: readonly string[]
  readonly expiresAt: string
  readonly invitedBy: string
  /** Null for a link somebody passed on themselves. */
  readonly mail: InvitationMail | null
}

export function staff(): Promise<readonly StaffEntry[]> {
  return request<readonly StaffEntry[]>('/staff')
}

/**
 * The roles this tenant has, in the order it made them: what the screen
 * offers when somebody is invited or given a role, what it calls them, and
 * which of them ask for a second factor. From the rows of the tenant and not
 * from a list in any code, because those are the roles the server accepts.
 */
export function staffRoles(): Promise<readonly RoleDefinition[]> {
  return request<readonly RoleDefinition[]>('/staff/roles')
}

export function openInvitations(): Promise<readonly InvitationEntry[]> {
  return request<readonly InvitationEntry[]>('/staff/invitations')
}

/**
 * Invites somebody, and hands the link back once, or has it sent by mail.
 *
 * For a link somebody passes on, the address is put together here rather
 * than on the server, out of the one the browser is already looking at. The
 * server would have to be told an address, and a wrong one would produce links
 * that lead nowhere on exactly the installations nobody tested.
 *
 * Sent by mail, there is no link to hand back: the server makes the token when
 * the message goes out, and it is in that message and nowhere else.
 *
 * `additions` is what the application keeps beside a membership, in the shape
 * its server reads; written with the invitation or not at all.
 */
export async function invite(wanted: {
  readonly email: string
  readonly name: string
  readonly roles: readonly string[]
  readonly send: 'link' | 'mail'
  readonly additions?: unknown
  /** The last day of the access, left out for one without an end. */
  readonly lastDay?: string
}): Promise<{ link: string | null; expiresAt: string }> {
  const answer = await request<{ token: string | null; expiresAt: string }>('/staff', {
    method: 'POST',
    body: JSON.stringify(wanted),
  })

  return {
    link:
      answer.token === null
        ? null
        : `${globalThis.location.origin}${invitationPath}/${answer.token}`,
    expiresAt: answer.expiresAt,
  }
}

export async function withdrawInvitation(invitationId: string): Promise<void> {
  await request(`/staff/invitations/${encodeURIComponent(invitationId)}`, { method: 'DELETE' })
}

/**
 * Gives somebody these roles, and with them what the application keeps
 * beside a membership where a screen names it (`additions`): both are written
 * or neither. A last day goes with them where it changed, null for none.
 */
export async function setRoles(
  userId: string,
  roles: readonly string[],
  additions?: unknown,
  lastDay?: string | null,
): Promise<void> {
  await request(`/staff/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ roles, additions, ...(lastDay === undefined ? {} : { lastDay }) }),
  })
}

/**
 * Corrects the name or the address of somebody's account, with what is named
 * and nothing else: a name that was misspelt, an address that has changed.
 * The server refuses it for an account that is not this tenant's alone, in
 * the words of the application.
 */
export async function correctAccount(
  userId: string,
  wanted: { readonly name?: string; readonly email?: string },
): Promise<void> {
  await request(`/staff/${encodeURIComponent(userId)}/account`, {
    method: 'PATCH',
    body: JSON.stringify(wanted),
  })
}

export async function setBlocked(userId: string, blocked: boolean): Promise<void> {
  await request(`/staff/${encodeURIComponent(userId)}/block`, {
    method: blocked ? 'PUT' : 'DELETE',
  })
}

/** Takes the second factor of somebody who has lost theirs, the app and every passkey (N6). */
export async function resetSecondFactor(userId: string): Promise<void> {
  await request(`/staff/${encodeURIComponent(userId)}/second-factor`, { method: 'DELETE' })
}

export function staffDevices(userId: string): Promise<readonly DeviceEntry[]> {
  return request<readonly DeviceEntry[]>(`/staff/${encodeURIComponent(userId)}/devices`)
}

export async function revokeStaffDevice(userId: string, sessionId: string): Promise<void> {
  await request(`/staff/${encodeURIComponent(userId)}/devices/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

// The far end of the link, a screen somebody reaches before they have an
// account at all. The path is the foundation's, because the job that sends an
// invitation by mail makes its link with it as well; handed on here, where
// the screens have always taken it from.
export { invitationPath }

export type InvitationState = 'open' | 'redeemed' | 'revoked' | 'expired'

export interface InvitationOffer {
  readonly state: InvitationState
  readonly company: string
  readonly name: string
  readonly email: string
  readonly expiresAt: string
  /** Whether this address already has an account, which keeps its password. */
  readonly knownAccount: boolean
  /**
   * The roles the invitation gives, as the tenant names them, and what the
   * application says beside them, or null. Empty once the link is spent.
   */
  readonly roles: readonly string[]
  readonly beside: string | null
}

/**
 * One's own name or address, after confirming again (`reconfirm`), as
 * "Konto" changes it (opengewerk-haustechnik#128). The answer is what the
 * account is called now.
 */
export async function changeOwnAccount(change: {
  readonly name?: string
  readonly email?: string
}): Promise<{ name: string; email: string; pending: PendingAddress | null }> {
  return request<{ name: string; email: string; pending: PendingAddress | null }>('/auth/account', {
    method: 'PATCH',
    body: JSON.stringify(change),
  })
}

/** An address that waits for the link in the mail to it (opengewerk#754). */
export interface PendingAddress {
  readonly email: string
  readonly expiresAt: string
}

/** The address of one's own account that waits for its link, or null. */
export async function waitingAddress(): Promise<PendingAddress | null> {
  // Nothing waiting is an answer without a body, and a query may not hold
  // undefined: it would fail and keep showing the address that waited.
  return (await request<PendingAddress | undefined>('/auth/account/address')) ?? null
}

/**
 * The link once more, to the address that waits, or to the one the account
 * has where it was never confirmed.
 */
export function sendAddressLink(): Promise<PendingAddress> {
  return request<PendingAddress>('/auth/account/address', { method: 'POST' })
}

/** Takes the address that waits away; the one the account has stays. */
export async function discardWaitingAddress(): Promise<void> {
  await request('/auth/account/address', { method: 'DELETE' })
}

/** Takes back a corrected address of somebody that waits for its link. */
export async function discardCorrectedAddress(userId: string): Promise<void> {
  await request(`/staff/${encodeURIComponent(userId)}/account/address`, { method: 'DELETE' })
}

/** What the page of the link shows before anything is confirmed. */
export interface AddressOffer {
  readonly state: 'open' | 'gone'
  readonly name: string
  readonly email: string
}

export function addressOffer(token: string): Promise<AddressOffer> {
  return request<AddressOffer>(`/auth/address/${encodeURIComponent(token)}`)
}

/** Opens the link: the address holds for the account from now on. */
export function confirmAddressLink(token: string): Promise<{ email: string; changed: boolean }> {
  return request<{ email: string; changed: boolean }>(
    `/auth/address/${encodeURIComponent(token)}`,
    {
      method: 'POST',
    },
  )
}

/**
 * A new password with the old one as confirmation (#126). Every other device
 * of the account is signed out, this one stays.
 */
export async function changePassword(current: string, next: string): Promise<void> {
  forgetSessionId()

  await request(`${authentication}/change-password`, {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    }),
  })
}

/**
 * Asks for a link to a new password. The answer is the same whether the
 * address has an account or not, and whether a mail goes out depends on
 * whether a tenant it works in sends mail at all.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await request(`${authentication}/request-password-reset`, {
    method: 'POST',
    body: JSON.stringify({ email: email.trim() }),
  })
}

/** The new password behind the link, which works once. */
export async function resetPassword(token: string, password: string): Promise<void> {
  forgetSessionId()

  await request(`${authentication}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ token, newPassword: password }),
  })
}

/** Where the link in the mail points: this path and the token after it. */
export const passwordResetPath = '/passwort'

/** The token of a link to a new password out of the address bar, or nothing. */
/** Where the link in the mail to an address leads (opengewerk#754), as the server writes it. */
export const addressPath = '/adresse'

/** The token of the link to an address out of the address bar, or nothing. */
export function addressToken(path: string): string | null {
  if (!path.startsWith(`${addressPath}/`)) {
    return null
  }

  const token = path.slice(addressPath.length + 1).split('/')[0] ?? ''

  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null
}

export function passwordResetToken(path: string): string | null {
  if (!path.startsWith(`${passwordResetPath}/`)) {
    return null
  }

  const token = path.slice(passwordResetPath.length + 1).split('/')[0] ?? ''

  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null
}

/** The token out of the address bar, or nothing. */
export function invitationToken(path: string): string | null {
  if (!path.startsWith(`${invitationPath}/`)) {
    return null
  }

  const token = path.slice(invitationPath.length + 1).split('/')[0] ?? ''

  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export function invitationOffer(token: string): Promise<InvitationOffer> {
  return request<InvitationOffer>(`/invitation/${encodeURIComponent(token)}`)
}

/**
 * Uses the link. Signing in afterwards is the ordinary sign in and a separate
 * call, because a route that handed out a session of its own would be a second
 * way in to keep right.
 *
 * Without a password for an address that already has an account: that one
 * joins signed in as itself, with the cookie of the session it has
 * (opengewerk-haustechnik#31), and keeps the password it had.
 */
export function redeemInvitation(
  token: string,
  password?: string,
): Promise<{ tenantId: TenantId; company: string; email: string; created: boolean }> {
  forgetSessionId()

  return request(`/invitation/${encodeURIComponent(token)}`, {
    method: 'POST',
    body: JSON.stringify(password === undefined ? {} : { password }),
  })
}
