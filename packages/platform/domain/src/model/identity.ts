import type { TenantId } from './identifier.js'

/**
 * Who is asking, and in which tenant.
 *
 * Two questions stand behind every request and two mechanisms answer them.
 * Whose data is in reach is decided by the tenant, in the database, through
 * row level security. What may be done with it is the application's to say:
 * it knows which rights there are and how somebody comes by them, and its own
 * identity carries whatever it needs to answer that, on top of these two.
 */
export interface TenantIdentity {
  readonly userId: string
  readonly tenantId: TenantId
}

/**
 * The header a page sends with every request to say which tenant it works in.
 *
 * A switch in one tab moves the session and not the other tabs; a page left
 * behind in the tenant before would otherwise send its outbox into the one it
 * no longer shows. The server refuses a request whose header names another
 * tenant than the session, and the page starts again in the tenant of the
 * session.
 *
 * In small letters, the way the organisation writes its name where only a
 * program reads it, and the way HTTP/2 sends the name of every header anyway.
 * A name in other letters is the same header: HTTP compares names without
 * regard to case, and Node hands every header to the server in small letters,
 * so a page that still sends the name the way it was written before is
 * understood as it was.
 */
export const workingInHeader = 'x-opengewerk-tenant'

/**
 * The header a page names the account in that it works for (opengewerk#882).
 *
 * The cookie of a session belongs to the browser and not to a tab. Once
 * somebody else signed in on the same browser, a tab still open for the one
 * before sent and asked under the name and with the rights of the one now.
 * The server holds what the header names against the session and refuses
 * another account with `otherAccountSignedIn` before anything is written or
 * read; a page that names none, one of a build from before, is taken as it
 * was. In small letters for the reason given at `workingInHeader`.
 */
export const workingAsHeader = 'x-account'
