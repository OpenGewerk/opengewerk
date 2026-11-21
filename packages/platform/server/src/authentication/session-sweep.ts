import { type SignInMethod, signInMethods, type TenantId } from '@opengewerk/platform-domain'
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'

import type { Database } from '../database/database.js'
import { everyTenant } from '../database/every-tenant.js'
import { authSessions, memberships, tenantSessions } from '../schema.js'
import { beforeItsEnd } from './last-day.js'
import { type RepeatingJob, startRepeating } from '../start/repeat.js'

/**
 * A session that is gone, with what its stretch of work in a tenant needs:
 * when it ran out, where that is known and is why it went.
 */
export interface EndedSession {
  readonly id: string
  readonly userId: string
  readonly tenantId: string | null
  readonly expiresAt?: Date
}

/**
 * Closes the stretches of work the sessions had open in a tenant, as signing
 * out closes them: the row is the tenant's record that somebody worked in it,
 * and an open one would say they still do. A stretch ends when its session
 * ran out, or now where it went before that. One transaction per tenant, so
 * that each change lands in that tenant's log, under the reason the caller
 * names, or else whether the sessions ran out or were ended, and in the name
 * of the person whose action ended them, where one did.
 */
export async function endStretchesOf(
  database: Database,
  sessions: readonly EndedSession[],
  how: { readonly now?: Date; readonly reason?: string; readonly actor?: string } = {},
): Promise<void> {
  const now = how.now ?? new Date()
  const { reason, actor } = how
  const byTenant = new Map<TenantId, EndedSession[]>()

  for (const session of sessions) {
    if (session.tenantId !== null) {
      const tenantId = session.tenantId as TenantId

      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), session])
    }
  }

  for (const [tenantId, ended] of byTenant) {
    const expired = ended.every(
      (session) => session.expiresAt !== undefined && session.expiresAt <= now,
    )

    await database.forTenant(
      {
        tenantId,
        reason: reason ?? (expired ? 'session.expire' : 'session.end'),
        ...(actor === undefined ? {} : { userId: actor }),
      },
      async (tx) => {
        for (const session of ended) {
          await tx
            .update(tenantSessions)
            .set({
              endedAt:
                session.expiresAt !== undefined && session.expiresAt < now
                  ? session.expiresAt
                  : now,
            })
            .where(
              and(
                eq(tenantSessions.tenantId, tenantId),
                eq(tenantSessions.sessionId, session.id),
                eq(tenantSessions.userId, session.userId),
                isNull(tenantSessions.endedAt),
              ),
            )
        }
      },
    )
  }
}

/**
 * A session better-auth writes in the place of another, when the app is set
 * up or the second factor changes, takes over the tenant the old one had
 * chosen, while the old one and its stretch of work end (opengewerk#1029). It
 * works on in that tenant, so it opens a stretch of its own there, as choosing
 * the tenant does: without one the tenant's log would say the work ended when
 * the app was set up, and the sign out later would find nothing to close. Only
 * such a session is born with a tenant; every other one chooses it after.
 *
 * Only where the person still works there, as choosing the tenant asks: not
 * blocked and not past the last day. And only for a session that still lives:
 * a revocation that takes it out while the stretch is being opened found
 * nothing to close, so the stretch is looked at again once it is written and
 * closed here when its session is gone. No lock on the session row, which the
 * tenant's half of the transaction could not reach, and which a block, holding
 * the membership first, would wait on in the other order.
 */
export async function carryStretch(
  database: Database,
  session: { readonly id: string; readonly userId: string },
  appSetUp: boolean,
): Promise<void> {
  const { activeTenantId, deviceId, signInMethod } = session as {
    activeTenantId?: string | null
    deviceId?: string | null
    signInMethod?: string | null
  }

  if (!activeTenantId) {
    return
  }

  const tenantId = activeTenantId as TenantId
  const reason = appSetUp ? 'second-factor.app' : 'session.start'

  const opened = await database.forTenant(
    { tenantId, userId: session.userId, reason, deviceId: deviceId ?? undefined },
    async (tx) => {
      // Shared, so that a block that comes in at the same moment waits and
      // closes this stretch along with the others.
      const [member] = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, session.userId),
            isNull(memberships.blockedAt),
            beforeItsEnd(),
          ),
        )
        .for('share')

      if (!member) {
        return false
      }

      await tx.insert(tenantSessions).values({
        tenantId,
        userId: session.userId,
        sessionId: session.id,
        deviceId: deviceId ?? null,
        signInMethod: signInMethods.includes(signInMethod as SignInMethod)
          ? (signInMethod as SignInMethod)
          : 'password',
      })

      return true
    },
  )

  if (!opened) {
    return
  }

  const [alive] = await database.forInstance((tx) =>
    tx.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.id, session.id)),
  )

  if (!alive) {
    await endStretchesOf(database, [{ id: session.id, userId: session.userId, tenantId }], {
      reason: 'session.revoke',
    })
  }
}

/** How many rows one round of a pass takes, so that no statement grows with the backlog. */
const sweepBatch = 1000

/**
 * Takes out every session that ran out (opengewerk#1029) and says how many
 * went.
 *
 * A session ends when its time is up (`session-lifetime.ts`). Its row stayed
 * after that: better-auth deletes it only when the same cookie comes back, and
 * a browser that is never opened again, or a device left for longer than the
 * cookie lives, never sends it. The row kept the network address, the browser
 * and the device until a new password, a lock or the account took it, while
 * the deletion concept promises that it goes once the session has ended.
 *
 * In rounds of a bounded size, the oldest first, until a round comes back
 * short: a backlog of any size goes in one pass, and no statement carries more
 * keys than PostgreSQL takes. In each round the rows go first and the
 * stretches of work of exactly the rows that went are closed after, as
 * everywhere a session ends: a renewal that is being committed while the pass
 * runs keeps its row, and with it its stretch. A close that fails after the
 * delete leaves an orphan, which the same pass closes at its end. The run acts
 * for no person, like the other jobs in the background.
 */
export async function sweepExpiredSessions(
  database: Database,
  now: Date = new Date(),
  batch: number = sweepBatch,
): Promise<number> {
  let gone = 0
  let failed = false
  let failure: unknown
  // The rows of a round that went and whose stretches are not closed yet.
  let pending: readonly EndedSession[] = []

  // The orphans are closed also after a round failed, so that the stretches
  // of rows that went before the failure do not wait for the next pass; the
  // failure of the round is the one reported.
  try {
    for (;;) {
      const expired = await database.forInstance((tx) =>
        tx
          .select({
            id: authSessions.id,
            userId: authSessions.userId,
            tenantId: authSessions.activeTenantId,
            expiresAt: authSessions.expiresAt,
          })
          .from(authSessions)
          .where(lte(authSessions.expiresAt, now))
          .orderBy(asc(authSessions.expiresAt), asc(authSessions.id))
          .limit(batch),
      )

      if (expired.length === 0) {
        break
      }

      const deleted = await database.forInstance((tx) =>
        tx
          .delete(authSessions)
          .where(
            and(
              inArray(
                authSessions.id,
                expired.map((session) => session.id),
              ),
              lte(authSessions.expiresAt, now),
            ),
          )
          .returning({
            id: authSessions.id,
            userId: authSessions.userId,
            tenantId: authSessions.activeTenantId,
            expiresAt: authSessions.expiresAt,
          }),
      )

      pending = deleted
      await endStretchesOf(database, deleted, { now })
      pending = []

      gone += deleted.length

      // A short round was the last; one that took nothing would only repeat.
      if (expired.length < batch || deleted.length === 0) {
        break
      }
    }
  } catch (error) {
    failed = true
    failure = error
  }

  // A round that failed after its rows went tries their stretches once more,
  // with the time each ran out, which only this pass still knows. What is
  // left after that goes with the orphans, at the time they are closed.
  if (pending.length > 0) {
    try {
      await endStretchesOf(database, pending, { now })
    } catch {
      // The orphans below take what is left.
    }
  }

  try {
    await endOrphanedStretches(database, batch)
  } catch (error) {
    if (!failed) {
      throw error
    }
  }

  if (failed) {
    throw failure
  }

  return gone
}

/**
 * Closes the stretches of work whose session is gone without having closed
 * them (opengewerk#1029): the ones better-auth left open before this release,
 * when it took out a session whose cookie came back after it ran out, and any
 * a failure leaves behind. When they really ended is not known any more; they
 * end when the pass closes them, by the clock of the database, so that one that
 * began while the pass ran does not end before it began. A tenant at a time, each in its own log,
 * and the sessions in rounds of a bounded size. Says how many it closed.
 */
export async function endOrphanedStretches(
  database: Database,
  batch: number = sweepBatch,
): Promise<number> {
  let closed = 0

  for (const tenantId of await everyTenant(database)) {
    const open = await database.forTenant({ tenantId }, (tx) =>
      tx
        .selectDistinct({ sessionId: tenantSessions.sessionId })
        .from(tenantSessions)
        .where(and(eq(tenantSessions.tenantId, tenantId), isNull(tenantSessions.endedAt))),
    )

    for (let start = 0; start < open.length; start += batch) {
      const ids = open.slice(start, start + batch).map((row) => row.sessionId)
      const alive = await database.forInstance((tx) =>
        tx.select({ id: authSessions.id }).from(authSessions).where(inArray(authSessions.id, ids)),
      )
      const living = new Set(alive.map((row) => row.id))
      const orphans = ids.filter((id) => !living.has(id))

      if (orphans.length === 0) {
        continue
      }

      const ended = await database.forTenant({ tenantId, reason: 'session.expire' }, (tx) =>
        tx
          .update(tenantSessions)
          .set({ endedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(tenantSessions.tenantId, tenantId),
              inArray(tenantSessions.sessionId, orphans),
              isNull(tenantSessions.endedAt),
            ),
          )
          .returning({ id: tenantSessions.id }),
      )

      closed += ended.length
    }
  }

  return closed
}

/**
 * The sweep of the sessions as a job of an instance: ten minutes after the
 * start, then every hour. The deletion concept promises that a session goes
 * at the latest a day after it ran out; a pass every hour keeps that with room
 * to spare, also when the pause counts from the end of a pass and a few passes
 * in a row fail. Not on a closed instance, which writes nothing; the
 * application decides that and does not start it there.
 */
export function startSessionSweep(
  database: Database,
  complain?: (line: string, error: unknown) => void,
): RepeatingJob {
  return startRepeating({
    run: () => sweepExpiredSessions(database),
    intervalMs: 60 * 60 * 1000,
    firstAfterMs: 10 * 60 * 1000,
    failure:
      'Das Aufräumen abgelaufener Sitzungen ist gescheitert, der nächste Lauf kommt in einer Stunde.',
    ...(complain === undefined ? {} : { complain }),
  })
}
