import { APIError } from 'better-auth/api'
import type { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { and, eq, not, sql, type SQL } from 'drizzle-orm'

import { databaseCode } from '../api/database-errors.js'
import type { Database } from '../database/database.js'
import { authPasskeys, authSessions, authUsers, authVerifications } from '../schema.js'

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

/** Takes a session whose credentials were taken back out of the database. */
export async function endRevokedSession(database: Database, sessionId: string): Promise<void> {
  await database.forInstance((tx) => tx.delete(authSessions).where(theSession(sessionId)))
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
