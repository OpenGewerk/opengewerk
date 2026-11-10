import { RefreshCw, TriangleAlert, UserRound, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'

import { Strip, stripAction } from '../components/strip.js'
import { useEntry } from '../components/surface.js'
import { hasUnowned, unownedSummary, unownedVerb } from './decisions.js'
import { useSync, useSyncStatus } from './provider.js'

/**
 * The strip over every screen on both entries, when there is something to do.
 *
 * A person who left the cellar has to be able to tell at a glance whether
 * what they wrote down has arrived, and a conflict has to be in the way until
 * somebody decides it. Everything arrived is no strip at all: an application
 * says so quietly where it shows the state of the sync (#217). A strip that
 * is always there teaches people to stop reading strips.
 *
 * `conflictsLink` draws the way to the conflicts with the classes it is
 * handed, because the two entries route there each in their own router.
 */
export function SyncStatusBar({
  conflictsLink,
}: {
  readonly conflictsLink?: (className: string) => ReactNode
}) {
  const client = useSync()
  const status = useSyncStatus()
  const entry = useEntry()
  // A tab of a newer build pulls for the store of this browser
  // (opengewerk#899): trying again changes nothing, loading the page does.
  // Said beside a conflict or a refused entry as well, which keep their way
  // to a decision; what waits on the device stays in the store through the
  // reload.
  const outdated = status.troubleKind === 'outdated'
  const reload = (tone: 'conflict' | 'wait') => (
    <button
      type="button"
      className={stripAction('plain', tone, entry)}
      onClick={() => {
        globalThis.location.reload()
      }}
    >
      Neu laden
    </button>
  )

  // Louder than a conflict, and ahead of one: until the refused entry is
  // decided, nothing queued behind it leaves the device, a decision on a
  // conflict included.
  if (status.state === 'refused') {
    return (
      <Strip
        tone="conflict"
        icon={TriangleAlert}
        urgent
        detail={
          outdated
            ? `Bis sie entschieden ist, geht nichts hinaus. ${status.trouble ?? ''}`
            : 'Bis sie entschieden ist, geht nichts hinaus.'
        }
        actions={
          <>
            {conflictsLink?.(stripAction('plain', 'conflict', entry))}
            {outdated ? reload('conflict') : null}
          </>
        }
      >
        Der Server nimmt eine Änderung nicht an.
      </Strip>
    )
  }

  if (status.state === 'conflict') {
    const count = status.conflicts.length

    return (
      <Strip
        tone="conflict"
        icon={TriangleAlert}
        urgent
        {...(outdated && status.trouble !== null ? { detail: status.trouble } : {})}
        actions={
          <>
            {conflictsLink?.(stripAction('plain', 'conflict', entry))}
            {outdated ? reload('conflict') : null}
          </>
        }
      >
        {count === 1
          ? 'Ein Konflikt wartet auf eine Entscheidung.'
          : `${String(count)} Konflikte warten auf eine Entscheidung.`}
      </Strip>
    )
  }

  // Waiting changes with nothing gone wrong are no missing connection: that
  // is every change for the moment between the outbox and the server, and a
  // strip saying "Keine Verbindung." over a send that works was the result
  // (#223). A real failure always leaves its reason in `trouble`.
  if (status.state === 'offline' && status.trouble !== null) {
    const why = status.trouble
    const waiting =
      status.pending > 0
        ? `${String(status.pending)} Änderung${status.pending === 1 ? '' : 'en'} auf dem Gerät.`
        : null
    const retry = outdated ? (
      reload('wait')
    ) : (
      <button
        type="button"
        className={stripAction('plain', 'wait', entry)}
        disabled={status.exchanging}
        onClick={() => {
          void client.synchronise()
        }}
      >
        {status.exchanging ? 'Läuft' : 'Erneut versuchen'}
      </button>
    )

    // The office says the count first, as one line; the site names the state
    // in its first sentence and puts the count under it, as the two boards
    // draw it. Without a count, whatever else the reason says goes there, and
    // the reason to load the page again goes there before any count.
    const cut = why.indexOf('. ')
    const head = cut < 0 ? why : why.slice(0, cut + 1)
    const rest = cut < 0 ? null : why.slice(cut + 2)

    return entry === 'site' ? (
      <Strip
        tone="wait"
        icon={outdated ? RefreshCw : WifiOff}
        detail={outdated ? rest : (waiting ?? rest)}
        actions={retry}
      >
        {head}
      </Strip>
    ) : (
      <Strip tone="wait" icon={outdated ? RefreshCw : WifiOff} actions={retry}>
        {waiting ? `${waiting} ${why}` : why}
      </Strip>
    )
  }

  // Last: what waits for nobody holds up nothing else, and only the person
  // who made it can say so. The strip leads to the card that asks.
  if (hasUnowned(status.unowned)) {
    const summary = unownedSummary(status.unowned)
    const look = conflictsLink?.(stripAction('plain', 'wait', entry))

    return entry === 'site' ? (
      <Strip tone="wait" icon={UserRound} detail={`${summary} auf dem Gerät.`} actions={look}>
        Änderungen ohne Person.
      </Strip>
    ) : (
      <Strip tone="wait" icon={UserRound} actions={look}>
        {`Auf diesem Gerät ${unownedVerb(status.unowned)} ${summary} ohne Person.`}
      </Strip>
    )
  }

  return null
}
