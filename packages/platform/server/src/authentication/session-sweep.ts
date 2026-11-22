import { type SignInMethod, signInMethods, type TenantId } from '@opengewerk/platform-domain'
import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm'

import type { Database } from '../database/database.js'
import { everyTenant } from '../database/every-tenant.js'
import { authSessions, memberships, tenantSessions } from '../schema.js'
import { beforeItsEnd, pastItsEnd } from './last-day.js'
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
 * of the person whose action ended them, where one did. Says how many it
 * closed; one closed before is not counted again.
 *
 * Where the access of the person in the tenant ended before the stretch would
 * (opengewerk#1030), it ends with the access and for that reason, on every
 * way a session goes, not only in the pass: signing out after midnight, a
 * device cut off by its person or by the office, a switch to another tenant,
 * a new password or better-auth taking a session out whose cookie came back.
 * Whichever came first is when the work ended. A block and the removal of the
 * data of an access close the stretches themselves, and ask
 * `endPastLastDayOf` first.
 */
export async function endStretchesOf(
  database: Database,
  sessions: readonly EndedSession[],
  how: { readonly now?: Date; readonly reason?: string; readonly actor?: string } = {},
): Promise<number> {
  let closed = 0
  const now = how.now ?? new Date()
  const { reason, actor } = how
  const byTenant = new Map<TenantId, EndedSession[]>()

  for (const session of sessions) {
    if (session.tenantId !== null) {
      const tenantId = session.tenantId as TenantId
      const group = byTenant.get(tenantId)

      if (group === undefined) {
        byTenant.set(tenantId, [session])
      } else {
        group.push(session)
      }
    }
  }

  const endOf = (session: EndedSession) =>
    session.expiresAt !== undefined && session.expiresAt < now ? session.expiresAt : now

  for (const [tenantId, all] of byTenant) {
    // Whose access here ended, and when: midnight after the last day, in
    // Germany, as the day itself is counted (`last-day.ts`).
    const users = [...new Set(all.map((session) => session.userId))]
    const accessEnded = await database.forTenant({ tenantId }, (tx) =>
      tx
        .select({
          userId: memberships.userId,
          endedAt: sql<
            Date | string
          >`((${memberships.lastDay} + 1)::timestamp at time zone 'Europe/Berlin')`,
        })
        .from(memberships)
        .where(
          and(eq(memberships.tenantId, tenantId), inArray(memberships.userId, users), pastItsEnd()),
        ),
    )
    const accessEnd = new Map(accessEnded.map((row) => [row.userId, new Date(row.endedAt)]))
    const withTheAccess: EndedSession[] = []
    const ended: EndedSession[] = []

    for (const session of all) {
      const over = accessEnd.get(session.userId)

      if (over !== undefined && over < endOf(session)) {
        withTheAccess.push(session)
      } else {
        ended.push(session)
      }
    }

    if (withTheAccess.length > 0) {
      closed += await database.forTenant({ tenantId, reason: 'membership.end' }, async (tx) => {
        let done = 0

        for (const session of withTheAccess) {
          const over = accessEnd.get(session.userId) ?? now
          const rows = await tx
            .update(tenantSessions)
            .set({
              endedAt: sql`greatest(${tenantSessions.startedAt}, ${over.toISOString()}::timestamptz)`,
            })
            .where(
              and(
                eq(tenantSessions.tenantId, tenantId),
                eq(tenantSessions.sessionId, session.id),
                eq(tenantSessions.userId, session.userId),
                isNull(tenantSessions.endedAt),
              ),
            )
            .returning({ id: tenantSessions.id })

          done += rows.length
        }

        return done
      })
    }

    if (ended.length === 0) {
      continue
    }

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
          const end = endOf(session)

          // Never before the stretch began: one a session opened a moment
          // after the time this close was worked out ends where it began.
          const done = await tx
            .update(tenantSessions)
            .set({
              endedAt: sql`greatest(${tenantSessions.startedAt}, ${end.toISOString()}::timestamptz)`,
            })
            .where(
              and(
                eq(tenantSessions.tenantId, tenantId),
                eq(tenantSessions.sessionId, session.id),
                eq(tenantSessions.userId, session.userId),
                isNull(tenantSessions.endedAt),
              ),
            )
            .returning({ id: tenantSessions.id })

          closed += done.length
        }
      },
    )
  }

  return closed
}

/**
 * `endStretchesOf` for sessions that are already gone, where what ended them
 * must not fail with the close: a new password, a revocation or the setup of
 * the app has done its work once the rows went, and a close that fails leaves
 * orphans the next pass of the sweep closes within the hour. The failure goes
 * to the log of the server, not to the person.
 */
export async function endStretchesOrLeaveThem(
  database: Database,
  sessions: readonly EndedSession[],
  how: { readonly now?: Date; readonly reason?: string; readonly actor?: string } = {},
): Promise<void> {
  try {
    await endStretchesOf(database, sessions, how)
  } catch (error) {
    console.error(
      'Die Arbeitsabschnitte beendeter Sitzungen ließen sich nicht schließen; ' +
        'der nächste Lauf über die Sitzungen schließt sie.',
      error,
    )
  }
}

/**
 * `endStretchesOrLeaveThem` for sessions taken out at one moment, each with
 * when it would have run out (opengewerk#1030): one still to run at `at` ends
 * then, for the reason given and in the name of who took it out; one that had
 * run out by then ends when it did, as run out, as the sweep would have closed
 * it. Either ends with the access where that ended first. `at` is the moment
 * the database took the sessions out (`clock_timestamp()` of the delete), the
 * first of them where there are several, so that no stretch ends after its
 * session went.
 */
export async function endStretchesOfTakenOut(
  database: Database,
  sessions: readonly (EndedSession & { readonly expiresAt: Date })[],
  at: Date,
  how: { readonly reason: string; readonly actor?: string },
): Promise<void> {
  await endStretchesOrLeaveThem(
    database,
    sessions.filter((session) => session.expiresAt > at),
    { now: at, ...how },
  )
  await endStretchesOrLeaveThem(
    database,
    sessions.filter((session) => session.expiresAt <= at),
    { now: at },
  )
}

/** The first moment the database took one of the sessions out, or now for none. */
export function firstOf(removed: readonly { readonly at: Date | string }[]): Date {
  return (
    removed.reduce<Date | null>((first, row) => {
      const at = new Date(row.at)

      return first === null || at < first ? at : first
    }, null) ?? new Date()
  )
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

  // The accesses past their last day first: a session still alive when its
  // access ended ends with the access, at the end of that day, and not when
  // it ran out later (opengewerk#1030). The sessions of a tenant where that
  // failed wait for the next pass, the rounds would take them for run out at
  // the wrong time and for the wrong reason; those of the other tenants go on.
  // Without even the list of tenants all of them wait. The orphans run in any
  // case, and the first failure is the one reported.
  let held: readonly TenantId[] = []
  let unsettled = false

  try {
    const lastDays = await endPastLastDays(database, batch)

    held = lastDays.held

    if (lastDays.held.length > 0) {
      failed = true
      failure = lastDays.failure
    }
  } catch (error) {
    unsettled = true
    failed = true
    failure = error
  }

  const settled =
    held.length === 0
      ? undefined
      : or(isNull(authSessions.activeTenantId), notInArray(authSessions.activeTenantId, [...held]))

  // The orphans are closed also after a round failed, so that the stretches
  // of rows that went before the failure do not wait for the next pass.
  try {
    for (; !unsettled;) {
      const expired = await database.forInstance((tx) =>
        tx
          .select({
            id: authSessions.id,
            userId: authSessions.userId,
            tenantId: authSessions.activeTenantId,
            expiresAt: authSessions.expiresAt,
          })
          .from(authSessions)
          .where(and(lte(authSessions.expiresAt, now), settled))
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
              settled,
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

      // A short round was the last. A full one goes on even when it took
      // nothing: a row it left was renewed meanwhile and has left the
      // selection, which counts against the same moment, so the next round
      // reads others and the rounds end.
      if (expired.length < batch) {
        break
      }
    }
  } catch (error) {
    if (!failed) {
      failed = true
      failure = error
    }
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
      failed = true
      failure = error
    }
  }

  if (failed) {
    throw failure
  }

  return gone
}

/**
 * Ends what a person still has open in a tenant once the last day of their
 * access there has passed (opengewerk#1030). From the next day on every
 * request into the tenant is refused; the sessions working there stayed
 * anyway, and so did the stretch of work, so that the tenant's log said the
 * person was still at work. Now the sessions working in that tenant go, as a
 * block takes them, and the open stretches there close at the end of the last
 * day, which is when the access ended, under a reason of their own. Sessions
 * of the same person in another tenant stay.
 *
 * A session that ran out before the access ended ends when it ran out, under
 * the reason of the expiry: whichever came first, the end of the access or of
 * the session, is when the work ended.
 *
 * Looked at are the people with a session working in the tenant and the ones
 * with a stretch still open there, also one left open by an earlier release
 * or one whose session is gone; both lists are bounded by what is open, not
 * by how many accesses ever ended. Each round holds the memberships it found
 * past their end in its own transaction until it is through (`FOR SHARE`): a
 * last day moved on meanwhile waits for the round, instead of losing its
 * sessions to a round that read it a moment before.
 *
 * Here the stretches close first and the sessions go after, the other way
 * round from everywhere else a session ends. There the order keeps a session
 * that may still work from working on without its stretch; a session of an
 * access past its end does no work, every request into the tenant is refused
 * and none is renewed (`renewSession`). This way a failure loses nothing: a
 * close that fails leaves the sessions, and the next pass does it all again;
 * a delete that fails undoes the close of the round with it, and the next
 * pass does that again as well. The
 * sessions it deletes are the ones it read, while the round still holds the
 * memberships. A stretch whose session is gone otherwise ends with the access
 * as well, and the orphans leave such stretches to this step
 * (`endOrphanedStretches`). A tenant at a time, the people in rounds of a
 * bounded size. Says how many stretches it closed.
 */
export async function endPastLastDays(
  database: Database,
  batch: number = sweepBatch,
): Promise<LastDaysPass> {
  let closed = 0
  const held: TenantId[] = []
  let failure: unknown

  for (const tenantId of await everyTenant(database)) {
    try {
      closed += await endPastLastDaysIn(database, tenantId, batch)
    } catch (error) {
      if (held.length === 0) {
        failure = error
      }

      held.push(tenantId)
    }
  }

  return held.length === 0 ? { closed, held } : { closed, held, failure }
}

/** What a pass over the last days did, and the tenants it could not finish. */
export interface LastDaysPass {
  readonly closed: number
  readonly held: readonly TenantId[]
  /** The first failure, where a tenant failed. */
  readonly failure?: unknown
}

/**
 * The stretches of one person in one tenant, before a way that closes them
 * there at its own time and for its own reason (a block, the removal of the
 * data of an access): where the access has ended, they end as the pass would
 * close them (opengewerk#1030), when their session ran out where that came
 * first, else with the access; the caller takes the sessions. Nothing where
 * the access has not ended.
 *
 * One step after the other, each in a transaction of its own, so that none
 * holds a connection while it waits for another: a route calls this, and
 * enough of them at once would take every connection of the pool. Which
 * sessions ran out first and when the others end both come from the end of
 * the access read at the start; the last step holds the membership and closes
 * only while that end still holds. Moved meanwhile, the steps begin again
 * with the new one, a few times at most; then the caller closes them.
 */
export async function endPastLastDayOf(
  database: Database,
  tenantId: TenantId,
  userId: string,
): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const closed = await endPastLastDayOnce(database, tenantId, userId)

    if (closed !== null) {
      return closed
    }
  }

  return 0
}

/** One pass of `endPastLastDayOf`, or null where the end of the access moved meanwhile. */
async function endPastLastDayOnce(
  database: Database,
  tenantId: TenantId,
  userId: string,
): Promise<number | null> {
  const accessEnd = sql<
    Date | string
  >`((${memberships.lastDay} + 1)::timestamp at time zone 'Europe/Berlin')`
  const ofThePerson = and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId))
  const [membership] = await database.forTenant({ tenantId }, (tx) =>
    tx.select({ endedAt: accessEnd }).from(memberships).where(and(ofThePerson, pastItsEnd())),
  )

  if (membership === undefined) {
    return 0
  }

  const over = new Date(membership.endedAt)
  const sessions = await database.forInstance((tx) =>
    tx
      .select({ id: authSessions.id, expiresAt: authSessions.expiresAt })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), eq(authSessions.activeTenantId, tenantId))),
  )
  // Those that ran out before the access ended, first, when they ran out.
  const ranOut = await endStretchesOf(
    database,
    sessions
      .filter((session) => session.expiresAt <= over)
      .map((session) => ({ id: session.id, userId, tenantId, expiresAt: session.expiresAt })),
  )
  const withTheAccess = await database.forTenant(
    { tenantId, reason: 'membership.end' },
    async (tx) => {
      const [still] = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(ofThePerson, pastItsEnd(), sql`${accessEnd} = ${over.toISOString()}::timestamptz`),
        )
        .for('share')

      if (still === undefined) {
        return null
      }

      // Never before the stretch began.
      const rows = await tx
        .update(tenantSessions)
        .set({
          endedAt: sql`greatest(${tenantSessions.startedAt}, ${over.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(tenantSessions.tenantId, tenantId),
            eq(tenantSessions.userId, userId),
            isNull(tenantSessions.endedAt),
          ),
        )
        .returning({ id: tenantSessions.id })

      return rows.length
    },
  )

  return withTheAccess === null ? null : ranOut + withTheAccess
}

/** `endPastLastDays` in one tenant. Says how many stretches it closed. */
async function endPastLastDaysIn(
  database: Database,
  tenantId: TenantId,
  batch: number,
): Promise<number> {
  let closed = 0

  const working = await database.forInstance((tx) =>
    tx
      .selectDistinct({ userId: authSessions.userId })
      .from(authSessions)
      .where(eq(authSessions.activeTenantId, tenantId)),
  )
  const open = await database.forTenant({ tenantId }, (tx) =>
    tx
      .selectDistinct({ userId: tenantSessions.userId })
      .from(tenantSessions)
      .where(and(eq(tenantSessions.tenantId, tenantId), isNull(tenantSessions.endedAt))),
  )
  const people = [...new Set([...working, ...open].map((row) => row.userId))]

  for (let start = 0; start < people.length; start += batch) {
    const round = people.slice(start, start + batch)

    closed += await database.forTenant({ tenantId, reason: 'membership.end' }, async (tx) => {
      const ended = await tx
        .select({ userId: memberships.userId, lastDay: memberships.lastDay })
        .from(memberships)
        .where(
          and(eq(memberships.tenantId, tenantId), inArray(memberships.userId, round), pastItsEnd()),
        )
        .for('share')

      if (ended.length === 0) {
        return 0
      }

      const users = ended.map((row) => row.userId)
      const lastDays = sql.join(
        ended.map((row) => sql`(${row.userId}, ${row.lastDay}::date)`),
        sql`, `,
      )
      // The end of the last day is midnight after it, in Germany, as the day
      // itself is counted (`last-day.ts`).
      const accessEnded = sql`((m.last_day + 1)::timestamp at time zone 'Europe/Berlin')`

      // The sessions working there, each with whether it ran out before its
      // access ended.
      const sessions = await database.forInstance(async (instance) => {
        const { rows } = await instance.execute<{
          id: string
          user_id: string
          expires_at: Date | string
          ran_out: boolean
        }>(sql`
          select s.id, s.user_id, s.expires_at, s.expires_at <= ${accessEnded} as ran_out
            from ${authSessions} s
            join (values ${lastDays}) as m(user_id, last_day) on s.user_id = m.user_id
           where s.active_tenant_id = ${tenantId}`)

        return rows
      })
      const ranOut = sessions.filter((session) => session.ran_out)

      // Those end when they ran out, under the reason of the expiry, in a
      // transaction of their own, since the reason is the transaction's.
      const ranOutClosed = await endStretchesOf(
        database,
        ranOut.map((session) => ({
          id: session.id,
          userId: session.user_id,
          tenantId,
          expiresAt: new Date(session.expires_at),
        })),
      )

      // The others with the access, never before the stretch began. The
      // membership is asked again here, under the lock the round holds. The
      // stretches of the sessions that ran out are closed and committed by
      // now, so `endedAt` keeps them out, without a list of them.
      const stretches = await tx
        .update(tenantSessions)
        .set({
          endedAt: sql`greatest(${tenantSessions.startedAt}, (
            select ((${memberships.lastDay} + 1)::timestamp at time zone 'Europe/Berlin')
              from ${memberships}
             where ${memberships.tenantId} = ${tenantSessions.tenantId}
               and ${memberships.userId} = ${tenantSessions.userId}))`,
        })
        .where(
          and(
            eq(tenantSessions.tenantId, tenantId),
            inArray(tenantSessions.userId, users),
            isNull(tenantSessions.endedAt),
            sql`exists (
              select 1 from ${memberships}
               where ${memberships.tenantId} = ${tenantSessions.tenantId}
                 and ${memberships.userId} = ${tenantSessions.userId}
                 and ${pastItsEnd()})`,
          ),
        )
        .returning({ id: tenantSessions.id })

      // Then the sessions it read go, as a block takes them, while the
      // round still holds the memberships; one that changed to another
      // tenant meanwhile works there and stays. In pieces of the size of a
      // round: the people of a round are bounded, their sessions are not,
      // and a statement takes at most 65,535 values.
      if (sessions.length > 0) {
        await database.forInstance(async (instance) => {
          for (let at = 0; at < sessions.length; at += batch) {
            await instance.delete(authSessions).where(
              and(
                inArray(
                  authSessions.id,
                  sessions.slice(at, at + batch).map((session) => session.id),
                ),
                eq(authSessions.activeTenantId, tenantId),
              ),
            )
          }
        })
      }

      return stretches.length + ranOutClosed
    })
  }

  return closed
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
        tx
          .select({ id: authSessions.id, tenantId: authSessions.activeTenantId })
          .from(authSessions)
          .where(inArray(authSessions.id, ids)),
      )
      const living = new Map(alive.map((row) => [row.id, row.tenantId]))
      // Gone, or working in another tenant since a switch whose close of the
      // stretch here failed (opengewerk#1030): the work here ended either way.
      const groups = [
        { reason: 'session.expire', sessions: ids.filter((id) => !living.has(id)) },
        {
          reason: 'session.switch',
          sessions: ids.filter((id) => living.has(id) && living.get(id) !== tenantId),
        },
      ]

      for (const { reason, sessions } of groups) {
        if (sessions.length === 0) {
          continue
        }

        const ended = await database.forTenant({ tenantId, reason }, (tx) =>
          tx
            .update(tenantSessions)
            .set({ endedAt: sql`clock_timestamp()` })
            .where(
              and(
                eq(tenantSessions.tenantId, tenantId),
                inArray(tenantSessions.sessionId, sessions),
                isNull(tenantSessions.endedAt),
                // Not the stretches of an access past its last day: those end
                // at the end of that day and for that reason (`endPastLastDays`),
                // also after a pass that failed to close them, and one whose
                // last day passed since they were read. Asked as they close.
                sql`not exists (
                  select 1 from ${memberships}
                   where ${memberships.tenantId} = ${tenantSessions.tenantId}
                     and ${memberships.userId} = ${tenantSessions.userId}
                     and ${pastItsEnd()})`,
              ),
            )
            .returning({ id: tenantSessions.id }),
        )

        closed += ended.length
      }
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
