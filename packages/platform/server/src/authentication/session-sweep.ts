import type { TenantId } from '@opengewerk/platform-domain'
import { and, eq, inArray, isNull, lte } from 'drizzle-orm'

import type { Database } from '../database/database.js'
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
 * The stretches of work are closed first and the rows go after, so that a
 * pass that fails in between leaves the rows for the next one to find. The run
 * acts for no person, like the other jobs in the background.
 */
export async function sweepExpiredSessions(
  database: Database,
  now: Date = new Date(),
): Promise<number> {
  const expired = await database.forInstance((tx) =>
    tx
      .select({
        id: authSessions.id,
        userId: authSessions.userId,
        tenantId: authSessions.activeTenantId,
        expiresAt: authSessions.expiresAt,
      })
      .from(authSessions)
      .where(lte(authSessions.expiresAt, now)),
  )

  if (expired.length === 0) {
    return 0
  }

  await endStretchesOf(database, expired, now)

  const gone = await database.forInstance((tx) =>
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

  return gone.length
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
