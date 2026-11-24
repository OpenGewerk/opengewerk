import 'fake-indexeddb/auto'

import type { InstanceUpdateRun, InstanceUpdateView } from '@opengewerk/platform-domain'
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aTenant, inFrame, signedIn, standInServer } from '../in-frame.js'
import type { StandIn } from '../in-frame.js'
import { InstanceFrame } from './frame.js'
import { InstanceUpdateScreen } from './update.js'

/**
 * The update of the instance (opengewerk#1093, boards
 * "Instanz-Aktualisierung"): which version runs and the newest with its
 * notes, the button only where an update can be asked for, and the request
 * only after the password.
 */

let server: StandIn

const newer: InstanceUpdateView = {
  running: '0.3.0',
  service: 'alive',
  checkedAt: '2026-11-24T03:12:00.000Z',
  mode: 'ready',
  reason: null,
  latest: '0.3.1',
  publishedAt: '2026-12-02T10:00:00.000Z',
  url: 'https://github.com/OpenGewerk/opengewerk/releases/tag/v0.3.1',
  error: null,
  newer: true,
  notes: [
    { title: 'Sicherheit', security: true, items: ['Ein Link galt weiter.'] },
    { title: 'Behoben', security: false, items: ['Der Zuschlag rechnet neu.'] },
  ],
  run: null,
  pending: null,
  refusal: null,
}

const stopped: InstanceUpdateRun = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '0.3.1',
  from: '0.3.0',
  by: 'Lea Leitung',
  state: 'failed',
  reason: null,
  step: 'backup',
  startedAt: '2026-11-24T03:14:00.000Z',
  finishedAt: '2026-11-24T03:14:40.000Z',
  log: ['03:14:40 pg_dump: could not write to output file: No space left on device'],
}

async function page(view: InstanceUpdateView) {
  server.answer('GET', '/instance/update', view)

  const frame = (): ReactNode => (
    <InstanceFrame
      navigation={[{ to: '/instanz/aktualisierung', label: 'Aktualisierung', icon: RefreshCw }]}
    />
  )

  await inFrame(frame, {
    at: '/instanz/aktualisierung',
    screens: { '/instanz/aktualisierung': () => <InstanceUpdateScreen /> },
  })

  return userEvent.setup()
}

function sent(method: string, path: string): unknown[] {
  return server.heard
    .filter((call) => call.method === method && call.path === path)
    .map((call) => call.body)
}

beforeEach(() => {
  server = standInServer()
  server.answer('POST', '/api/auth/reconfirm', { reconfirmedUntil: '2026-10-20T10:10:00.000Z' })
  signedIn(server, [aTenant({ name: 'Probewerk Nord' })])
  server.answer('GET', '/instance/access', { operator: true, secondFactor: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the update of the instance', () => {
  it('shows the version that runs, the newer one and what it brings, the security part first', async () => {
    await page(newer)

    expect(await screen.findByText('Neuere Fassung')).toBeTruthy()
    const versions = screen.getByRole('region', { name: 'Fassung' })

    expect(within(versions).getByText('Läuft').nextElementSibling?.textContent).toBe('0.3.0')
    expect(within(versions).getByText('Neueste').nextElementSibling?.textContent).toContain('0.3.1')
    const notes = screen.getByRole('region', { name: 'Was 0.3.1 bringt' })
    const headings = within(notes)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)

    expect(headings).toEqual(['Sicherheit', 'Behoben'])
    expect(
      within(notes).getByRole('link', { name: 'Alle Hinweise zu 0.3.1 auf der Release-Seite' }),
    ).toBeTruthy()
  })

  it('asks for the password before it sends the request, and sends the newest version', async () => {
    const user = await page(newer)

    await user.click(await screen.findByRole('button', { name: 'Auf 0.3.1 aktualisieren' }))
    const dialog = screen.getByRole('dialog', { name: 'Auf 0.3.1 aktualisieren?' })

    expect(sent('POST', '/instance/update')).toEqual([])

    server.answer(
      'POST',
      '/instance/update',
      { ...newer, pending: { id: stopped.id, version: '0.3.1', at: '2026-11-24T03:14:00.000Z' } },
      202,
    )
    await user.type(within(dialog).getByLabelText('Passwort'), 'ein-ordentlich-langes-passwort')
    await user.click(within(dialog).getByRole('button', { name: 'Aktualisieren' }))

    expect(await screen.findByText('Die Instanz wird auf 0.3.1 aktualisiert.')).toBeTruthy()
    expect(sent('POST', '/instance/update')).toEqual([{ version: '0.3.1' }])
  })

  it('has no button for an instance from a checkout, and says how it is updated', async () => {
    await page({ ...newer, running: null, mode: 'checkout', reason: 'checkout', newer: false })

    expect(await screen.findByText(/läuft aus einem Checkout des Quelltexts/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /aktualisieren/i })).toBeNull()
  })

  it('has no button while the service for updates is silent', async () => {
    await page({ ...newer, service: 'silent' })

    expect(await screen.findByText(/meldet sich seit einigen Minuten nicht mehr/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /aktualisieren/i })).toBeNull()
  })

  it('shows where an update stopped, what that left, the end of its log, and the way to try again', async () => {
    await page({ ...newer, run: stopped })

    expect(await screen.findByText('Die Aktualisierung auf 0.3.1 ist abgebrochen.')).toBeTruthy()
    expect(screen.getByText('Die Sicherung ist fehlgeschlagen.')).toBeTruthy()
    expect(screen.getByText(/Es wurde nichts geändert, 0.3.0 läuft weiter/)).toBeTruthy()
    expect(screen.getByText(/No space left on device/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy()
  })

  it('keeps a run that stopped after the migration in view when a newer version came out, and offers that one', async () => {
    await page({
      ...newer,
      latest: '0.3.2',
      run: { ...stopped, step: 'restart', log: [] },
    })

    expect(await screen.findByText('Die Aktualisierung auf 0.3.1 ist abgebrochen.')).toBeTruthy()
    expect(screen.getByText(/Die Datenbank ist schon migriert/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Auf 0.3.2 aktualisieren' })).toBeTruthy()
  })

  it('no longer shows a run that stopped once the instance runs that version', async () => {
    await page({ ...newer, running: '0.3.1', latest: '0.3.1', newer: false, run: stopped })

    expect(await screen.findByText('Diese Instanz ist auf dem neuesten Stand.')).toBeTruthy()
    expect(screen.queryByText(/ist abgebrochen/)).toBeNull()
  })

  it('says why the service turned the last request away', async () => {
    await page({
      ...newer,
      refusal: { id: stopped.id, version: '0.3.1', reason: 'expired', at: stopped.startedAt },
    })

    expect(await screen.findByText(/länger als zehn Minuten/)).toBeTruthy()
  })
})
