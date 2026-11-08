import { ConflictException } from '@nestjs/common'
import { otherAccountSignedIn } from '@opengewerk/platform-domain'

/**
 * Holds the account a tab names for what it sends or asks against the
 * session. The cookie of a session belongs to the browser, not to a tab: a tab
 * still open for the person before sent and pulled under the name and with the
 * rights of the one signed in now. Refused before anything is written or read,
 * with a code the tab knows (`otherAccountSignedIn`). A tab that names no
 * account, one of a build from before, is taken as it was.
 */
export function heldForTheSession(
  named: string | null | undefined,
  userId: string,
  message: string,
): void {
  if (named !== null && named !== undefined && named !== userId) {
    throw new ConflictException({ statusCode: 409, code: otherAccountSignedIn, message })
  }
}
