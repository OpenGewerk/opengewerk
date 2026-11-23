import 'fake-indexeddb/auto'

import {
  addDays,
  berlinClock,
  type EmergencyTariff,
  type RecordState,
  type RoleKey,
} from '@opengewerk/domain'
import { SyncProvider, openLocalStore } from '@opengewerk/platform-web/sync'
import { TestServer } from '@opengewerk/platform-web/testing'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aTenantChoice } from '../../session/test-tenants.js'
import { tariffWaitMs } from '../../session/on-call.js'
import { SyncClient, tariffsName } from '../../sync/client.js'
import { SiteJobList } from './jobs.js'
import { SiteNewCallScreen } from './on-call.js'

/**
 * A call taken on call on site (#293): the card on top of the open jobs while
 * the plan says so and with the right, and the call made there without a
 * network, a service call with the moment of the call.
 */

let server: TestServer
let answers: Map<string, unknown>
let counter = 0
// What the store of the tenant keeps of the tariffs before the screen opens (#1024).
let keptBefore: string | null = null
// Whether keeping in the store of the tenant fails, as on a device whose storage is full.
let keepFails = false
// Holds the answer for the tariffs back until it is opened, as a slow network does.
let tariffsHeld: Promise<void> | null = null

function shift(over: Partial<RecordState> = {}): RecordState {
  return {
    id: 'sh-1',
    userId: 'u-1',
    startsAt: new Date(Date.now() - 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    note: null,
    ...over,
  }
}

/** What a technician may do in a business that took the right to make a call on call from the role. */
const withoutOnCall = aTenantChoice(['technician']).rights.filter(
  (right) => right !== 'job.on_call',
)

async function mount(
  path: string,
  rows: Readonly<Record<string, RecordState[]>> = {},
  roles: RoleKey[] = ['technician'],
  rights?: readonly string[],
) {
  answers.set('/api/auth/get-session', {
    user: { id: 'u-1', email: 'jonas@nord.example.de', name: 'Jonas Brandt' },
    session: { activeTenantId: 't-1' },
  })
  answers.set('/auth/tenants', [aTenantChoice(roles, rights ? { rights } : {})])

  for (const [entity, list] of Object.entries({
    customers: [{ id: 'c-1', kind: 'private', name: 'Familie Berg', phone: '040 123 456' }],
    on_call_shifts: [shift()],
    ...rows,
  })) {
    for (const row of list) {
      server.put(entity, row)
    }
  }

  const client = await SyncClient.start({
    store: await openLocalStore(`einsatz${String((counter += 1))}`),
    transport: server,
    writer: server,
    deviceId: 'telefon-jonas',
    entities: [
      'customers',
      'sites',
      'jobs',
      'tasks',
      'on_call_shifts',
      'appointments',
      'appointment_people',
    ],
    onSignedOut: () => {},
  })

  await client.synchronise()

  if (keptBefore !== null) {
    await client.keep(tariffsName, keptBefore)
  }

  if (keepFails) {
    vi.spyOn(client, 'keep').mockRejectedValue(new Error('Der Speicher ist voll.'))
  }

  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: SiteJobList }),
      createRoute({
        getParentRoute: () => root,
        path: '/einsatz/neu',
        component: SiteNewCallScreen,
      }),
      createRoute({ getParentRoute: () => root, path: '/auftraege/$jobId', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SyncProvider client={client}>
        <RouterProvider router={router} />
      </SyncProvider>
    </QueryClientProvider>,
  )

  return { client, router }
}

beforeEach(() => {
  server = new TestServer()
  answers = new Map()
  keptBefore = null
  keepFails = false
  globalThis.localStorage.clear()
  answers.set('/tasks/assignees', [{ userId: 'u-1', name: 'Jonas Brandt', active: true }])

  tariffsHeld = null
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const held = tariffsHeld

    if (path === '/on-call-shifts/tariffs' && held) {
      // Held, as a slow network holds it, until opened or given up on.
      await new Promise<void>((resolve, reject) => {
        void held.then(resolve)
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Die Anfrage wurde abgebrochen.', 'AbortError'))
        })
      })
    }

    return new Response(JSON.stringify(answers.get(path) ?? {}), {
      status: answers.has(path) ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('on call on site (#293)', () => {
  it('shows the card on top of the open jobs, with the way to a new call', async () => {
    await mount('/')

    expect(await screen.findByText('Du hast Bereitschaft')).toBeTruthy()
    expect(
      (await screen.findByRole('link', { name: 'Einsatz anlegen' })).getAttribute('href'),
    ).toBe('/einsatz/neu')
  })

  it('shows no card outside the times of the plan', async () => {
    await mount('/', {
      on_call_shifts: [
        shift({
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        }),
      ],
    })

    expect(await screen.findByText('Offene Aufträge')).toBeTruthy()
    // The times come from the store after the list: give the card the time it would take.
    await expect(screen.findByText('Du hast Bereitschaft', {}, { timeout: 500 })).rejects.toThrow()
  })

  it('shows no card without the right, in a time of the plan as well', async () => {
    await mount('/', {}, ['technician'], withoutOnCall)

    expect(await screen.findByText('Offene Aufträge')).toBeTruthy()
    // The times come from the store after the list: give the card the time it would take.
    await expect(screen.findByText('Du hast Bereitschaft', {}, { timeout: 500 })).rejects.toThrow()
  })

  it('makes the call without a network: a new customer and a running service call with its moment', async () => {
    const { client, router } = await mount('/einsatz/neu')

    await userEvent.type(await screen.findByLabelText('Name'), 'Familie Arslan')
    await userEvent.type(screen.getByLabelText('Anliegen'), 'Heizung ohne Strom')
    await userEvent.click(screen.getByLabelText(/Dringende Reparatur/))
    await userEvent.click(screen.getByRole('button', { name: 'Einsatz anlegen' }))

    await waitFor(() => {
      expect(client.list('jobs')).toHaveLength(1)
    })

    const [job] = client.list('jobs')
    const made = client.list('customers').find((customer) => customer['name'] === 'Familie Arslan')

    expect(job).toMatchObject({
      kind: 'service',
      status: 'active',
      designation: 'Heizung ohne Strom',
      urgentRepair: true,
      customerId: made?.['id'],
    })
    expect(Date.now() - new Date(String(job?.['emergencyAt'])).getTime()).toBeLessThan(60_000)
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/auftraege/${String(job?.['id'])}`)
    })
  })

  it('takes a customer who is on the device', async () => {
    const { client } = await mount('/einsatz/neu')

    await userEvent.type(await screen.findByLabelText('Kunde suchen'), 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: 'Familie Berg' }))
    await userEvent.type(screen.getByLabelText('Anliegen'), 'Licht im Bad')
    await userEvent.click(screen.getByRole('button', { name: 'Einsatz anlegen' }))

    await waitFor(() => {
      expect(client.list('jobs')).toHaveLength(1)
    })

    expect(client.list('jobs')[0]).toMatchObject({ customerId: 'c-1' })
    expect(client.list('customers')).toHaveLength(1)
  })

  it('makes nothing outside a time of the plan', async () => {
    await mount('/einsatz/neu', { on_call_shifts: [] })

    expect(await screen.findByText(/wer laut Plan gerade Bereitschaft hat/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Einsatz anlegen' })).toBeNull()
  })

  it('makes nothing without the right, in a time of the plan as well', async () => {
    await mount('/einsatz/neu', {}, ['technician'], withoutOnCall)

    expect(await screen.findByText(/wer laut Plan gerade Bereitschaft hat/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Einsatz anlegen' })).toBeNull()
  })
})

describe('the surcharge named before the order (#1024)', () => {
  const today = berlinClock(new Date()).day
  // A night around the clock, so that a call at any hour of a weekday is one.
  const tariff = (on: string, until: string, flatCents: number): EmergencyTariff => ({
    on,
    until,
    night: { fromMinute: 0, untilMinute: 24 * 60 },
    surcharges: {
      night: { flatCents, basisPoints: 0 },
      weekend: { flatCents, basisPoints: 0 },
      holiday: { flatCents, basisPoints: 0 },
    },
    vatBasisPoints: 1900,
    holidays: [],
  })
  // Until yesterday 45,00 €, from today 60,00 €: the call is today.
  const tariffs = [
    tariff(addDays(today, -2), addDays(today, -1), 4500),
    tariff(today, addDays(today, 28), 6000),
  ]
  const named = /^Notdienstzuschlag (Nacht|Wochenende): 71,40/

  it('is the one of the business on the day of the call, asked from the server and kept in the store of the tenant', async () => {
    answers.set('/on-call-shifts/tariffs', tariffs)
    const { client } = await mount('/einsatz/neu')

    expect(await screen.findByText(named)).toBeTruthy()
    expect(screen.getByText(/^Nenne den Zuschlag, bevor der Kunde den Auftrag gibt/)).toBeTruthy()
    await waitFor(() => {
      expect(JSON.parse(client.kept(tariffsName) ?? 'null')).toEqual(tariffs)
    })
    // Not in the storage of the browser, which a sign out leaves behind.
    expect(Object.keys(globalThis.localStorage).filter((key) => key.includes('tariff'))).toEqual([])
  })

  it('comes from what the device kept where the server does not answer', async () => {
    keptBefore = JSON.stringify(tariffs)
    await mount('/einsatz/neu')

    expect(await screen.findByText(named)).toBeTruthy()
  })

  it('is said to be missing where the device kept none, none it can read, or none for the day', async () => {
    keptBefore = JSON.stringify([{ ...tariffs[1], holidays: 'keine' }])
    await mount('/einsatz/neu')

    expect(
      await screen.findByText(/^Dieses Gerät kennt den Notdienstzuschlag noch nicht/),
    ).toBeTruthy()
  })

  it('is said to be missing where what the device kept ended before the day of the call', async () => {
    keptBefore = JSON.stringify([tariffs[0]])
    await mount('/einsatz/neu')

    expect(
      await screen.findByText(/^Dieses Gerät kennt den Notdienstzuschlag noch nicht/),
    ).toBeTruthy()
    expect(screen.queryByText(/^Notdienstzuschlag/)).toBeNull()
  })

  it('is named from the answer of the server where keeping it fails', async () => {
    answers.set('/on-call-shifts/tariffs', tariffs)
    keepFails = true
    await mount('/einsatz/neu')

    expect(await screen.findByText(named)).toBeTruthy()
  })

  it('is asked again when the screen opens, whatever the card asked a minute before', async () => {
    answers.set('/on-call-shifts/tariffs', [tariff(today, addDays(today, 28), 4500)])
    const { client } = await mount('/')

    expect(await screen.findByText('Du hast Bereitschaft')).toBeTruthy()
    // The card has asked and kept the answer of then.
    await waitFor(() => {
      expect(client.kept(tariffsName)).toContain('"flatCents":4500')
    })
    // The office raised the surcharge since.
    answers.set('/on-call-shifts/tariffs', tariffs)
    await userEvent.click(await screen.findByRole('link', { name: 'Einsatz anlegen' }))

    expect(await screen.findByText(named)).toBeTruthy()
  })

  it('is not named from what the device kept while the server is being asked', async () => {
    keptBefore = JSON.stringify([tariff(today, addDays(today, 28), 4500)])
    answers.set('/on-call-shifts/tariffs', tariffs)

    let open = () => {}

    tariffsHeld = new Promise((resolve) => {
      open = resolve
    })
    await mount('/einsatz/neu')

    expect(
      await screen.findByText(/^Der Notdienstzuschlag wird gerade vom Server geholt/),
    ).toBeTruthy()
    expect(screen.queryByText(/^Notdienstzuschlag (Nacht|Wochenende): 53,55/)).toBeNull()

    open()

    expect(await screen.findByText(named)).toBeTruthy()
  })

  it('is named from what the device kept where the server does not answer in time', async () => {
    keptBefore = JSON.stringify(tariffs)
    answers.set('/on-call-shifts/tariffs', tariffs)
    // An answer that never comes, as in a cellar where the phone shows a network.
    tariffsHeld = new Promise(() => {})
    await mount('/einsatz/neu')

    expect(
      await screen.findByText(/^Der Notdienstzuschlag wird gerade vom Server geholt/),
    ).toBeTruthy()
    expect(await screen.findByText(named, {}, { timeout: tariffWaitMs + 3_000 })).toBeTruthy()
  }, 20_000)

  it('is not named to a business, which is owed it on no such ground', async () => {
    answers.set('/on-call-shifts/tariffs', tariffs)
    await mount('/einsatz/neu', {
      customers: [
        { id: 'c-2', kind: 'business', name: 'Schreinerei Lutz', isBusiness: true, phone: null },
      ],
    })

    expect(await screen.findByText(named)).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Kunde suchen'), 'Lutz')
    await userEvent.click(await screen.findByRole('button', { name: 'Schreinerei Lutz' }))

    await waitFor(() => {
      expect(screen.queryByText(named)).toBeNull()
    })
    expect(screen.queryByText(/kennt den Notdienstzuschlag noch nicht/)).toBeNull()
  })
})
