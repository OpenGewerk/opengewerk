import type { Database } from '../database/database.js'
import { endStretchesOfRevoked, revokeCredentials, theSession } from './credentials.js'

/**
 * Ends every session of an account apart from the one named, as a new
 * password does, and closes what each of them had open in a tenant, as
 * cutting off one device does.
 *
 * For the moments the account gives up a factor: a passkey deleted, the
 * recovery codes renewed. A session is given its second factor when it is
 * written and does not say which passkey or which code gave it, so one
 * opened with the factor that is gone would otherwise keep that second
 * factor for as long as it is used, and every role that asks for one with
 * it.
 *
 * The rows go first, so that the sessions stop whatever happens next; the
 * stretches of work are closed after, as a new password closes them
 * (`endStretchesOfRevoked`): a session that had run out ends as run out, an
 * access past its end with itself, and a close that fails is left to the
 * pass. The count of the credentials goes up with them (`credentials.ts`),
 * so that a sign in with the factor that is gone, written a moment later, is
 * refused as well.
 */
export async function endOtherSessions(
  database: Database,
  userId: string,
  keep: string,
  reason: string,
): Promise<void> {
  const revoked = await database.forInstance(async (tx) => {
    const at = new Date()

    return { ...(await revokeCredentials(tx, userId, theSession(keep))), at }
  }, userId)

  await endStretchesOfRevoked(database, userId, revoked, reason)
}
