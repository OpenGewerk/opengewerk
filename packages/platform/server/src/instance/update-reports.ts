import type { Database } from '../database/database.js'
import type { MailContext } from '../mail/context.js'
import { failsServerWide } from '../mail/worker.js'
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
 * requests says it was told, so that it is told once. It is set once every
 * mail was handed to the server: a question to the database before, or a
 * failure of the server itself (no connection, no answer, no sign in), sets
 * none, and the next look a minute later tries again. A mail the server
 * turns away for its address alone is said in the log and not tried again,
 * as with every notice to an account.
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

  if (await updateTold(updates, run.id)) {
    return false
  }

  const connection = await instanceMailConnection(database, mail.key)

  if (connection?.state !== 'ready') {
    return false
  }

  const operators = await listOperators(database)
  const transport = mail.connect(connection.configuration)

  try {
    for (const operator of operators) {
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
      } catch (error) {
        if (failsServerWide(error)) {
          throw error
        }

        console.error(
          'Die Nachricht über die Aktualisierung der Instanz ging an eine Adresse nicht hinaus.',
          error,
        )
      }
    }
  } finally {
    transport.close()
  }

  await markUpdateTold(updates, run.id)

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
