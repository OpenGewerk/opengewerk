import type { Database } from '../database/database.js'
import type { MailContext } from '../mail/context.js'
import { failsForGood, failsServerWide } from '../mail/worker.js'
import { type RepeatingJob, startRepeating } from '../start/repeat.js'
import type { AccountMessages } from './account-mail.js'
import { instanceMailConnection } from './mail-server.js'
import { listOperators } from './operators.js'
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
    throw missed ?? new Error('Nicht jeder Betreiber hat die Nachricht bekommen.')
  }

  return true
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
