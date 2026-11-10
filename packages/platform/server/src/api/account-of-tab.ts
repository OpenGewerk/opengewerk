import { ConflictException } from '@nestjs/common'
import { otherAccountSignedIn } from '@opengewerk/platform-domain'

/** What a page is told when the browser is signed in to another account than the one it names. */
export const otherAccountSentence = 'Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet.'

/**
 * Whether a page names another account than the one of the session. A page
 * that names none, one of a build from before, is taken as it was.
 */
export function namesAnotherAccount(named: string | null | undefined, userId: string): boolean {
  return named !== null && named !== undefined && named !== userId
}

/** The body of the refusal, the same from Nest and from in front of it (`otherAccountSignedIn`). */
export function otherAccountRefusal(message: string = otherAccountSentence) {
  return { statusCode: 409, code: otherAccountSignedIn, message } as const
}

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
  message: string = otherAccountSentence,
): void {
  if (namesAnotherAccount(named, userId)) {
    throw new ConflictException(otherAccountRefusal(message))
  }
}
