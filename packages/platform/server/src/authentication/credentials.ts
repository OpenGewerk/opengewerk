import { APIError } from 'better-auth/api'
import type { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { and, eq, exists, not, notExists, sql, type SQL } from 'drizzle-orm'

import { databaseCode } from '../api/database-errors.js'
import type { Database } from '../database/database.js'
import {
  authAccounts,
  authPasskeys,
  authSessions,
  authTwoFactors,
  authUsers,
  authVerifications,
} from '../schema.js'

/**
 * The count of an account's credentials, against a session written after
 * they were taken back.
 *
 * A sign in reads the password or the passkey, checks it, and writes its
 * session a moment later. Ending every session when a password changes does
 * not reach one that is written in that moment: it was checked against the
 * old password and written after the old sessions were gone. better-auth
 * does nothing about it for sessions kept in the database alone.
 *
 * So every revocation counts the account up, in the transaction that ends
 * its sessions, and a sign in takes the count as it begins, before anything
 * of the credentials is read (`authentication.ts`). Its session carries that
 * count, and the database takes no session whose count is not the account's
 * (`session_fits_its_credentials` in `setup.sql`), reading the account under
 * a lock that a revocation has to wait for or that waits for it. Every
 * request asks the same again (`revokedSince`, in the hook before the routes
 * of better-auth, through which the server asks for a session too), for a
 * session that slipped in between a revocation of better-auth's own and the
 * count that follows it.
 */

type InstanceTransaction = Parameters<Parameters<Database['forInstance']>[0]>[0]

/**
 * Counts the credentials of an account up and ends its sessions, apart from
 * those `keep` names, which take the new count. Also ends a sign in waiting
 * for its second code: it began with the credentials that are gone. Returns
 * the new count and the sessions that ended.
 */
export async function revokeCredentials(
  tx: InstanceTransaction,
  userId: string,
  keep: SQL | null = null,
): Promise<{
  readonly generation: number
  readonly ended: readonly { readonly id: string; readonly tenantId: string | null }[]
}> {
  const [counted] = await tx
    .update(authUsers)
    .set({ credentialGeneration: sql`${authUsers.credentialGeneration} + 1` })
    .where(eq(authUsers.id, userId))
    .returning({ generation: authUsers.credentialGeneration })
  const generation = counted?.generation ?? 0
  const ofTheAccount = eq(authSessions.userId, userId)

  const ended = await tx
    .delete(authSessions)
    .where(keep === null ? ofTheAccount : and(ofTheAccount, not(keep)))
    .returning({ id: authSessions.id, tenantId: authSessions.activeTenantId })

  if (keep !== null) {
    await tx
      .update(authSessions)
      .set({ credentialGeneration: generation })
      .where(and(ofTheAccount, keep))
  }

  await tx.delete(authVerifications).where(eq(authVerifications.value, userId))

  return { generation, ended }
}

/**
 * Writes a new password of an account and counts its credentials up, in one
 * transaction under the lock of the account, and hands back the new count;
 * null where nothing was written.
 *
 * better-auth checks the old password of a change and hashes the new one
 * before it writes, two runs of argon2 long, and asks nothing after that: a
 * revocation in between, a link from a mail or the command line, was written
 * over, and the change got its session. So the write happens here, and at a
 * change only while the account still has `asking`, the count of the
 * session that asks for it. A link from a mail asks without one, `undefined`:
 * whoever holds the link sets the password, whatever came before.
 */
export async function writePassword(
  database: Database,
  userId: string,
  hash: string,
  asking: unknown,
): Promise<number | null> {
  return database.forInstance(async (tx) => {
    const [account] = await tx
      .select({ generation: authUsers.credentialGeneration })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .for('update')

    if (!account || (asking !== undefined && asking !== account.generation)) {
      return null
    }

    const written = await tx
      .update(authAccounts)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'credential')))
      .returning({ id: authAccounts.id })

    if (written.length === 0) {
      return null
    }

    return (await revokeCredentials(tx, userId)).generation
  }, userId)
}

/** The session that is named, as what `keep` takes. */
export function theSession(sessionId: string): SQL {
  return eq(authSessions.id, sessionId)
}

/** The count of the account with this address, or null for an address without one. */
export async function generationOfAddress(
  database: Database,
  email: string,
): Promise<number | null> {
  const [found] = await database.forInstance((tx) =>
    tx
      .select({ generation: authUsers.credentialGeneration })
      .from(authUsers)
      .where(eq(authUsers.email, email.trim().toLowerCase())),
  )

  return found?.generation ?? null
}

/** The count of the account, or null for one that is not there. */
export async function generationOfAccount(
  database: Database,
  userId: string,
): Promise<number | null> {
  const [found] = await database.forInstance((tx) =>
    tx
      .select({ generation: authUsers.credentialGeneration })
      .from(authUsers)
      .where(eq(authUsers.id, userId)),
  )

  return found?.generation ?? null
}

/** The count of the account a passkey belongs to, or null for one nobody registered. */
export async function generationOfPasskey(
  database: Database,
  credentialId: string,
): Promise<number | null> {
  const [found] = await database.forInstance((tx) =>
    tx
      .select({ generation: authUsers.credentialGeneration })
      .from(authPasskeys)
      .innerJoin(authUsers, eq(authUsers.id, authPasskeys.userId))
      .where(eq(authPasskeys.credentialID, credentialId)),
  )

  return found?.generation ?? null
}

/**
 * Whether the credentials of the account were taken back since the session
 * was signed in: its count is not the account's. A session without one is
 * one of those, and so is one whose account has none to compare with.
 */
export function revokedSince(found: { readonly session: object; readonly user: object }): boolean {
  const session = (found.session as { readonly credentialGeneration?: unknown })
    .credentialGeneration
  const account = (found.user as { readonly credentialGeneration?: unknown }).credentialGeneration

  return typeof session !== 'number' || typeof account !== 'number' || session !== account
}

/**
 * Whether a sign in that waits for its second code still stands under the
 * count its password step began with. better-auth writes the row of that wait
 * after the session of the password, which it deletes again, and a revocation
 * in between found no row to end: the row outlived it, and the code read the
 * new count. Read under the lock a revocation takes, so that one under way is
 * waited for; one that comes later finds the row and ends it. A row that does
 * not stand goes.
 */
export async function secondStepStands(
  database: Database,
  waiting: { readonly id: string; readonly value: string },
  generation: unknown,
): Promise<boolean> {
  return database.forInstance(async (tx) => {
    const [account] = await tx
      .select({ generation: authUsers.credentialGeneration })
      .from(authUsers)
      .where(eq(authUsers.id, waiting.value))
      .for('share')

    if (typeof generation === 'number' && account?.generation === generation) {
      return true
    }

    await tx.delete(authVerifications).where(eq(authVerifications.id, waiting.id))

    return false
  }, waiting.value)
}

/**
 * Takes an app back that was being set up when a revocation overtook it.
 * better-auth marks the account as having the app before it writes the
 * session that confirms it, and the app is confirmed only after that session:
 * refused by the count, it left an account that asks for a code its app was
 * never confirmed for, and so could not sign in with it. The account goes
 * back to how it was before the setup, and an app that was confirmed already
 * stays.
 */
export async function withdrawUnconfirmedApp(database: Database, userId: string): Promise<void> {
  await database.forInstance(
    (tx) =>
      tx
        .update(authUsers)
        .set({ twoFactorEnabled: false })
        .where(
          and(
            eq(authUsers.id, userId),
            eq(authUsers.twoFactorEnabled, true),
            notExists(
              tx
                .select({ id: authTwoFactors.id })
                .from(authTwoFactors)
                .where(and(eq(authTwoFactors.userId, userId), eq(authTwoFactors.verified, true))),
            ),
          ),
        ),
    userId,
  )
}

/**
 * Switches an app back on whose secret is confirmed, and says whether it was
 * off. Two confirmations of the same setup sent together (a second click, a
 * retry) raced: the setup of the one counted up past the session of the
 * other, which took the app back (`withdrawUnconfirmedApp`) before
 * better-auth confirmed the secret for the first. The confirmation that ends
 * with success puts it right, after its secret is confirmed.
 */
export async function reinstateConfirmedApp(database: Database, userId: string): Promise<boolean> {
  const switched = await database.forInstance(
    (tx) =>
      tx
        .update(authUsers)
        .set({ twoFactorEnabled: true })
        .where(
          and(
            eq(authUsers.id, userId),
            eq(authUsers.twoFactorEnabled, false),
            exists(
              tx
                .select({ id: authTwoFactors.id })
                .from(authTwoFactors)
                .where(and(eq(authTwoFactors.userId, userId), eq(authTwoFactors.verified, true))),
            ),
          ),
        )
        .returning({ id: authUsers.id }),
    userId,
  )

  return switched.length > 0
}

/**
 * Takes a session whose credentials were taken back out of the database, and
 * says whether it went. Asked again as it is deleted: better-auth reads a
 * session and its account in two queries, and a revocation that keeps the
 * session and gives it the new count can come in between. Such a session
 * fits its account at the time it would go, and stays.
 */
export async function endRevokedSession(database: Database, sessionId: string): Promise<boolean> {
  const ended = await database.forInstance((tx) =>
    tx
      .delete(authSessions)
      .where(
        and(
          theSession(sessionId),
          sql`${authSessions.credentialGeneration} is distinct from (select ${authUsers.credentialGeneration} from ${authUsers} where ${authUsers.id} = ${authSessions.userId})`,
        ),
      )
      .returning({ id: authSessions.id }),
  )

  return ended.length > 0
}

/** What somebody is told whose session ended with a change of the credentials. */
export const sessionRevoked =
  'Die Zugangsdaten dieses Kontos wurden geändert. Bitte noch einmal anmelden.'

/** What `session_fits_its_credentials` raises for a session it does not take. */
const refusedByTheDatabase = 'OG015'

type AdapterFactory = ReturnType<typeof drizzleAdapter>

type Adapter = ReturnType<AdapterFactory>

/**
 * The adapter, with a session the database refused for its count answered
 * as a sign in that has to begin again. Without it, the sign in that lost
 * the race against a revocation ended as an error of the server: the trigger
 * is the last thing that stands in its way, and better-auth passes on what
 * its adapter throws. Only the code of the trigger is translated, and only
 * for a new session; everything else goes on as it was thrown.
 *
 * The adapter better-auth hands into a transaction is wrapped the same: the
 * change of a password writes its session through it.
 */
export function refusingRevokedSessions(factory: AdapterFactory): AdapterFactory {
  return (options) => {
    const adapter = factory(options)

    return {
      ...refusing(adapter),
      transaction: (callback) => adapter.transaction((inside) => callback(refusing(inside))),
    }
  }
}

function refusing<Some extends Pick<Adapter, 'create'>>(adapter: Some): Some {
  const create = async (data: Parameters<Adapter['create']>[0]) => {
    try {
      return await adapter.create(data)
    } catch (error) {
      if (data.model === 'session' && databaseCode(error) === refusedByTheDatabase) {
        throw new APIError('UNAUTHORIZED', { code: 'SESSION_REVOKED', message: sessionRevoked })
      }

      throw error
    }
  }

  return { ...adapter, create: create as Some['create'] }
}
