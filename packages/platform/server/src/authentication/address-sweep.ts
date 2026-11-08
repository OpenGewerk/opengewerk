import { lte } from 'drizzle-orm'

import type { Database } from '../database/database.js'
import { authAddressConfirmations } from '../schema.js'
import { type RepeatingJob, startRepeating } from '../start/repeat.js'

/**
 * Takes out every address whose link ran out (opengewerk#862) and says how
 * many went.
 *
 * A new address waits in `auth_address_confirmations` until its link is
 * opened, discarded or replaced, or the account goes. A link nobody opens
 * left the row behind for good: the address, who asked for it and the hash of
 * the link. Once the link is out of time the row is good for nothing, since
 * neither the page of the link nor the account shows it any more.
 *
 * The run acts for no person, like the other jobs in the background, and the
 * table writes nothing into a log.
 */
export async function sweepExpiredAddresses(
  database: Database,
  now: Date = new Date(),
): Promise<number> {
  const gone = await database.forInstance((tx) =>
    tx
      .delete(authAddressConfirmations)
      .where(lte(authAddressConfirmations.expiresAt, now))
      .returning({ id: authAddressConfirmations.id }),
  )

  return gone.length
}

/**
 * The sweep of the addresses as a job of an instance: an hour after the
 * start, then once a day, so that an address goes at the latest a day after
 * its link ran out. Not on a closed instance, which writes nothing; the
 * application decides that and does not start it there.
 */
export function startAddressSweep(
  database: Database,
  complain?: (line: string, error: unknown) => void,
): RepeatingJob {
  return startRepeating({
    run: () => sweepExpiredAddresses(database),
    intervalMs: 24 * 60 * 60 * 1000,
    firstAfterMs: 60 * 60 * 1000,
    failure:
      'Das Aufräumen abgelaufener E-Mail-Adressen ist gescheitert, der nächste Lauf kommt in einem Tag.',
    ...(complain === undefined ? {} : { complain }),
  })
}
