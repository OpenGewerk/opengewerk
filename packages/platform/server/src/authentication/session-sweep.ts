import type { TenantId } from '@opengewerk/platform-domain'
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'

import type { Database } from '../database/database.js'
import { everyTenant } from '../database/every-tenant.js'
import { authSessions, tenantSessions } from '../schema.js'
import { type RepeatingJob, startRepeating } from '../start/repeat.js'

/** A session that is gone, with what its stretch of work in a tenant needs. */
export interface EndedSession {
  readonly id: string
  readonly userId: string
  readonly tenantId: string | null
  readonly expiresAt: Date
}

/**
 * Closes the stretches of work the sessions had open in a tenant, as signing
 * out closes them: the row is the tenant's record that somebody worked in it,
 * and an open one would say they still do. A stretch ends when its session
 * ran out, or now where it went before that. One transaction per tenant, so
 * that each change lands in that tenant's log.
 */
export async function endStretchesOf(
  database: Database,
  sessions: readonly EndedSession[],
  now: Date = new Date(),
): Promise<void> {
  const byTenant = new Map<TenantId, EndedSession[]>()

  for (const session of sessions) {
    if (session.tenantId !== null) {
      const tenantId = session.tenantId as TenantId

      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), session])
    }
  }

  for (const [tenantId, ended] of byTenant) {
    const expired = ended.every((session) => session.expiresAt <= now)

    await database.forTenant(
      { tenantId, reason: expired ? 'session.expire' : 'session.end' },
      async (tx) => {
        for (const session of ended) {
          await tx
            .update(tenantSessions)
            .set({ endedAt: session.expiresAt < now ? session.expiresAt : now })
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
 * keys than PostgreSQL takes. In each round the stretches of work are closed
 * first and the rows go after, so that a round that fails in between leaves
 * the rows for the next pass to find. The run acts for no person, like the
 * other jobs in the background.
 */
export async function sweepExpiredSessions(
  database: Database,
  now: Date = new Date(),
  batch: number = sweepBatch,
): Promise<number> {
  let gone = 0

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

    await endStretchesOf(database, expired, now)

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
        .returning({ id: authSessions.id }),
    )

    gone += deleted.length

    // A short round was the last; one that took nothing would only repeat.
    if (expired.length < batch || deleted.length === 0) {
      break
    }
  }

  await endOrphanedStretches(database, now, batch)

  return gone
}

/**
 * Closes the stretches of work whose session is gone without having closed
 * them (opengewerk#1029): the ones better-auth left open before this release,
 * when it took out a session whose cookie came back after it ran out, and any
 * a failure leaves behind. When they really ended is not known any more; they
 * end at the pass that finds them. A tenant at a time, each in its own log,
 * and the sessions in rounds of a bounded size. Says how many it closed.
 */
export async function endOrphanedStretches(
  database: Database,
  now: Date = new Date(),
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
          .set({ endedAt: now })
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
