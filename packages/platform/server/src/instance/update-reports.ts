import { instanceUpdateStoppedIn } from '@opengewerk/platform-domain'
import { eq } from 'drizzle-orm'

import type { Database } from '../database/database.js'
import { everyTenant } from '../database/every-tenant.js'
import type { MailContext } from '../mail/context.js'
import { failsForGood, failsServerWide, refusesSender } from '../mail/worker.js'
import { type RepeatingJob, startRepeating } from '../start/repeat.js'
import type { AccountMessages } from './account-mail.js'
import { instanceMailConnection } from './mail-server.js'
import { listOperators } from './operators.js'
import { updateNotices, instanceUpdates } from '../schema.js'
import { type InstanceUpdates, markUpdateTold, readInstanceUpdate, updateTold } from './update.js'

/**
 * Everybody who runs the instance learns by mail how an update from its area
 * ended (opengewerk#1093), whoever asked for it: one that went through, and
 * above all one that stopped, which may have left the instance waiting for
 * somebody on the server.
 *
 * Told by whichever version of the application runs once the update ended:
 * the new one after an update that went through, the one before after an
 * update that stopped before the restart. A mark in the folder of the
 * requests keeps who was told, so that everybody is told once. A mail the
 * server takes counts, and so does one it turns away for good (an address
 * nobody can deliver to), which is said in the log. Anything else, a
 * question to the database, a server that cannot be reached or says it is
 * not available now, leaves the rest for the next look a minute later; who
 * got the mail by then does not get it again.
 *
 * Only an update that ended within the last day, so that an instance whose
 * mail server is set up a week later does not tell of an old one. Without a
 * mail server nothing goes out and nothing is marked: the screen says how it
 * ended either way.
 */
const toldWithinMs = 24 * 60 * 60_000

export interface UpdateReporting {
  readonly database: Database
  readonly mail: MailContext
  readonly messages: AccountMessages
  readonly updates: InstanceUpdates
}

/** One look at the last update, and the mail if it ended and was not told yet. True when it was told now. */
export async function reportFinishedUpdate(
  reporting: UpdateReporting,
  now: Date = new Date(),
): Promise<boolean> {
  const { database, mail, messages, updates } = reporting
  const words = messages.instanceUpdated

  if (!words) {
    return false
  }

  const { run } = await readInstanceUpdate(updates, null, now)

  if (
    !run ||
    run.state === 'running' ||
    run.finishedAt === null ||
    now.getTime() - new Date(run.finishedAt).getTime() > toldWithinMs
  ) {
    return false
  }

  const told = await updateTold(updates, run.id)

  if (told.done) {
    return false
  }

  const connection = await instanceMailConnection(database, mail.key)

  if (connection?.state !== 'ready') {
    return false
  }

  const operators = await listOperators(database)
  const reached = new Set(told.to)
  let missed: unknown = null
  const transport = mail.connect(connection.configuration)

  try {
    for (const operator of operators) {
      const address = operator.email.toLowerCase()

      if (reached.has(address)) {
        continue
      }

      const text = words({
        name: operator.name,
        version: run.version,
        from: run.from,
        succeeded: run.state === 'succeeded',
        step: run.step,
        reason: run.reason,
        by: run.by,
        startedAt: new Date(run.startedAt),
        link: mail.origin,
      })

      try {
        await transport.send({
          from: { name: messages.senderName, address: connection.configuration.from },
          replyTo: null,
          to: { name: operator.name || null, address: operator.email },
          subject: text.subject,
          text: text.body,
          attachments: [],
        })
        reached.add(address)
      } catch (error) {
        // A sender the server does not take is about the instance, for every
        // address alike, and for good only until somebody corrects it: the
        // rest waits for the next look, as for a server that cannot be
        // reached, and nobody is given up on.
        if (refusesSender(error)) {
          missed = error
          break
        }

        if (failsForGood(error)) {
          console.error(
            'Die Nachricht über die Aktualisierung der Instanz ging an eine Adresse nicht hinaus.',
            error,
          )
          reached.add(address)
          continue
        }

        missed = error

        // The server, not the address: the others would only wait for it.
        if (failsServerWide(error)) {
          break
        }
      }
    }
  } finally {
    transport.close()
  }

  const done = operators.every((operator) => reached.has(operator.email.toLowerCase()))

  await markUpdateTold(updates, run.id, { done, to: [...reached] })

  if (!done) {
    throw missed ?? new Error('Nicht jede Adresse hat die Nachricht bekommen.')
  }

  return true
}

/**
 * Writes how the last update ended into the log of the instance and into the
 * log of every tenant on it (opengewerk#1093), once per run and whether or
 * not a mail goes out. Every tenant first and the instance last: the row of
 * the instance says the run stands in every log, and a look that stopped
 * halfway writes the rest a minute later. A tenant that already has the run
 * is not written again. True when it wrote now.
 *
 * However long ago the run ended: an update that left the instance down
 * until somebody mended it on the server is the one the logs need most. A
 * new request writes the last run first (`update.controller.ts`), so that it
 * does not take its place in the folder unwritten.
 */
export async function recordFinishedUpdate(
  database: Database,
  updates: InstanceUpdates,
): Promise<boolean> {
  const { run } = await readInstanceUpdate(updates, null)

  if (!run || run.state === 'running' || run.finishedAt === null) {
    return false
  }

  const recorded = await database.forInstance(
    (tx) =>
      tx
        .select({ id: instanceUpdates.id })
        .from(instanceUpdates)
        .where(eq(instanceUpdates.id, run.id)),
    undefined,
    'instance.update',
  )

  if (recorded.length > 0) {
    return false
  }

  const succeeded = run.state === 'succeeded'
  const outcome = {
    toVersion: run.version,
    fromVersion: run.from,
    succeeded,
    stoppedIn: succeeded ? null : instanceUpdateStoppedIn(run),
    finishedAt: new Date(run.finishedAt),
  }

  for (const tenantId of await everyTenant(database)) {
    await database.forTenant({ tenantId, reason: 'instance.update' }, (tx) =>
      tx
        .insert(updateNotices)
        .values({ tenantId, runId: run.id, ...outcome })
        .onConflictDoNothing(),
    )
  }

  await database.forInstance(
    (tx) =>
      tx
        .insert(instanceUpdates)
        .values({ id: run.id, ...outcome })
        .onConflictDoNothing(),
    undefined,
    'instance.update',
  )

  return true
}

/**
 * Looks every minute whether an update ended that the logs do not have yet,
 * with or without a mail server.
 */
export function startUpdateRecords(
  database: Database,
  updates: InstanceUpdates,
  complain?: (line: string, error: unknown) => void,
): RepeatingJob {
  return startRepeating({
    run: () => recordFinishedUpdate(database, updates),
    intervalMs: 60_000,
    firstAfterMs: 15_000,
    failure:
      'Wie die Aktualisierung der Instanz ausging, ließ sich nicht ins Protokoll schreiben, der nächste Versuch kommt in einer Minute.',
    ...(complain === undefined ? {} : { complain }),
  })
}

/** Looks every minute whether an update ended that nobody was told of yet. */
export function startUpdateReports(
  reporting: UpdateReporting,
  complain?: (line: string, error: unknown) => void,
): RepeatingJob {
  return startRepeating({
    run: () => reportFinishedUpdate(reporting),
    intervalMs: 60_000,
    firstAfterMs: 20_000,
    failure:
      'Die Nachricht über die Aktualisierung der Instanz ging nicht hinaus, der nächste Versuch kommt in einer Minute.',
    ...(complain === undefined ? {} : { complain }),
  })
}
