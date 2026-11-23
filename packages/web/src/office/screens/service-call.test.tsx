import 'fake-indexeddb/auto'

import {
  addDays,
  berlinInstant,
  type IsoDate,
  type RecordState,
  type RoleKey,
} from '@opengewerk/domain'
import { today } from '@opengewerk/platform-web/format'
import { SyncProvider, openLocalStore } from '@opengewerk/platform-web/sync'
import { TestServer } from '@opengewerk/platform-web/testing'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aTenantChoice } from '../../session/test-tenants.js'
import { SyncClient } from '../../sync/client.js'
import { JobList, JobScreen } from './jobs.js'
import { NewServiceCallScreen } from './service-call.js'

/**
 * A call taken on the phone (#292): one screen makes customer, site, service
 * call and appointment, finds a customer who is there already, says what is
 * missing, and is the office's, with the right to write jobs.
 */

let server: TestServer
let answers: Map<string, unknown>
let calls: { path: string; method: string; body: unknown }[]
let counter = 0

const berg: RecordState = {
  id: 'c-1',
  kind: 'private',
  name: 'Familie Berg',
  phone: '040 123 456',
  street: 'Lindenweg',
  houseNumber: '3',
  postalCode: '22301',
  city: 'Hamburg',
}

async function mount(at: string, roles: RoleKey[] = ['office']) {
  answers.set('/api/auth/get-session', {
    user: { id: 'u-1', email: 'buero@nord.example.de', name: 'Britta Büro' },
    session: { activeTenantId: 't-1' },
  })
  answers.set('/auth/tenants', [aTenantChoice(roles)])
  answers.set('/tasks/assignees', [
    { userId: 'u-2', name: 'Jonas Brandt', active: true },
    { userId: 'u-3', name: 'Max Becker', active: true },
  ])

  server.put('customers', berg)
  server.put('sites', {
    id: 's-1',
    customerId: 'c-1',
    designation: 'Einfamilienhaus Lindenweg',
    street: 'Lindenweg',
    houseNumber: '3',
    postalCode: '22301',
    city: 'Hamburg',
  })

  const client = await SyncClient.start({
    store: await openLocalStore(`service${String((counter += 1))}`),
    transport: server,
    writer: server,
    deviceId: 'office-computer',
    entities: ['customers', 'sites', 'installations', 'jobs'],
    onSignedOut: () => {},
  })

  await client.synchronise()

  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/auftraege', component: JobList }),
      createRoute({
        getParentRoute: () => root,
        path: '/auftraege/service',
        component: NewServiceCallScreen,
      }),
      createRoute({ getParentRoute: () => root, path: '/auftraege/$jobId', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
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

async function type(label: string, value: string) {
  const [field] = await screen.findAllByLabelText(new RegExp(`^${label.replace('.', '\\.')}`))

  if (!field) {
    throw new Error(`No field ${label}`)
  }

  await userEvent.clear(field)
  await userEvent.type(field, value)
}

beforeEach(() => {
  server = new TestServer()
  answers = new Map()
  calls = []

  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'

    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })

    if (path.startsWith('/appointments/board')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ absences: [{ userId: 'u-3', kind: 'absent' }], holidays: [] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }

    if (path === '/appointments' && method === 'POST') {
      return Promise.resolve(
        new Response(JSON.stringify({ appointment: { id: 'a-1', revision: 1 }, people: [] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    return Promise.resolve(
      new Response(JSON.stringify(answers.get(path) ?? {}), {
        status: answers.has(path) ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * The day of the call in these tests: a weekday some ten days back, so that
 * 02:14 is a call at night and within the year the form takes (#1085).
 */
function aWeekdayBack(): IsoDate {
  let day = addDays(today(), -10)

  while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) {
    day = addDays(day, -1)
  }

  return day
}

const callDay = aWeekdayBack()

describe('a call taken on the phone (#292)', () => {
  it('becomes customer, site, service call and appointment in one go', async () => {
    const { router } = await mount('/auftraege/service')

    await type('Kunde suchen', 'Lehmann')
    expect(
      await screen.findByText('Kein Kunde gefunden. Die Angaben unten legen einen neuen an.'),
    ).toBeTruthy()

    await type('Name', 'Klaus Lehmann')
    await type('E-Mail', 'klaus.lehmann@example.com')
    await type('Straße', 'Eppendorfer Weg')
    await type('Nr.', '112')
    await type('PLZ', '20259')
    await type('Ort', 'Hamburg')
    await type('Anliegen', 'Sicherung Küche löst aus')
    await userEvent.click(
      screen.getByLabelText('Dringende Reparatur, vom Kunden ausdrücklich angefordert', {
        exact: false,
      }),
    )
    await userEvent.click(screen.getByRole('checkbox', { name: /Jonas Brandt/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    await waitFor(() => {
      expect(calls.some((call) => call.path === '/appointments' && call.method === 'POST')).toBe(
        true,
      )
    })

    const [customer] = server.all('customers').filter((row) => row['name'] === 'Klaus Lehmann')
    const [site] = server.all('sites').filter((row) => row['customerId'] === customer?.['id'])
    const [job] = server.all('jobs')

    expect(customer).toMatchObject({
      kind: 'private',
      isBusiness: false,
      email: 'klaus.lehmann@example.com',
    })
    expect(site).toMatchObject({
      designation: 'Eppendorfer Weg 112',
      postalCode: '20259',
      city: 'Hamburg',
    })
    expect(job).toMatchObject({
      kind: 'service',
      status: 'active',
      designation: 'Sicherung Küche löst aus',
      urgentRepair: true,
      customerId: customer?.['id'],
      siteId: site?.['id'],
    })

    const appointment = calls.find(
      (call) => call.path === '/appointments' && call.method === 'POST',
    )

    expect(appointment?.body).toMatchObject({ jobId: job?.['id'], userIds: ['u-2'], rrule: null })

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/auftraege/${String(job?.['id'])}`)
    })
  })

  it('finds a customer who is there already and goes to one of its sites', async () => {
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
    await type('Anliegen', 'Steckdose Bad ohne Strom')
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    await waitFor(() => {
      expect(server.all('jobs')).toHaveLength(1)
    })

    expect(server.all('jobs')[0]).toMatchObject({
      customerId: 'c-1',
      siteId: 's-1',
      urgentRepair: false,
    })
    expect(server.all('customers')).toHaveLength(1)
    expect(server.all('sites')).toHaveLength(1)
    // Nobody to go: the job without an appointment.
    expect(calls.some((call) => call.path === '/appointments' && call.method === 'POST')).toBe(
      false,
    )
  })

  it('marks an emergency call with the moment of the call (#293)', async () => {
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
    await type('Anliegen', 'Heizung ohne Strom')
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await type('Anruf am', callDay)
    await type('um', '02:14')
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    await waitFor(() => {
      expect(server.all('jobs')).toHaveLength(1)
    })

    // 02:14 in Germany on that day, whether summer or winter time.
    expect(server.all('jobs')[0]?.['emergencyAt']).toBe(
      berlinInstant(callDay, 2 * 60 + 14).toISOString(),
    )
  })

  // The tariffs from the day of the call: 45,00 € at night (#1080).
  const fromTheCall = [
    {
      on: callDay,
      until: addDays(callDay, 28),
      night: { fromMinute: 20 * 60, untilMinute: 6 * 60 },
      surcharges: {
        night: { flatCents: 4500, basisPoints: 0 },
        weekend: { flatCents: 0, basisPoints: 5000 },
        holiday: { flatCents: 0, basisPoints: 0 },
      },
      vatBasisPoints: 1900,
      holidays: [],
    },
  ]

  it('names the surcharge to a consumer before the order and keeps it with the job (#1080, #1081)', async () => {
    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, fromTheCall)
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
    await type('Anliegen', 'Heizung ohne Strom')
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await type('Anruf am', callDay)
    await type('um', '02:14')

    expect(
      await screen.findByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 53,55/),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    await waitFor(() => {
      expect(server.all('jobs')).toHaveLength(1)
    })
    expect(server.all('jobs')[0]).toMatchObject({
      emergencyNamedFlatCents: 4500,
      emergencyNamedBasisPoints: 0,
    })
  })

  it('keeps the surcharge it showed when the window comes back into focus (#1081)', async () => {
    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, fromTheCall)
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
    await type('Anliegen', 'Heizung ohne Strom')
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await type('Anruf am', callDay)
    await type('um', '02:14')

    expect(
      await screen.findByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 53,55/),
    ).toBeTruthy()

    // Meanwhile somebody raises the surcharge at night to 60,00 €, and the
    // window comes back into focus.
    const [raised] = fromTheCall

    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, [
      {
        ...raised,
        surcharges: { ...raised?.surcharges, night: { flatCents: 6000, basisPoints: 0 } },
      },
    ])

    try {
      act(() => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      focusManager.setFocused(undefined)
    }

    expect(screen.getByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 53,55/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    await waitFor(() => {
      expect(server.all('jobs')).toHaveLength(1)
    })
    expect(server.all('jobs')[0]).toMatchObject({ emergencyNamedFlatCents: 4500 })
  })

  it('keeps the surcharge it showed for a day after another day and back (#1081)', async () => {
    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, fromTheCall)
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await type('Anruf am', callDay)
    await type('um', '02:14')
    expect(
      await screen.findByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 53,55/),
    ).toBeTruthy()

    const [raised] = fromTheCall

    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, [
      {
        ...raised,
        surcharges: { ...raised?.surcharges, night: { flatCents: 6000, basisPoints: 0 } },
      },
    ])
    await type('Anruf am', addDays(callDay, -1))
    await type('Anruf am', callDay)

    expect(
      await screen.findByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 53,55/),
    ).toBeTruthy()
    expect(screen.queryByText(/71,40/)).toBeNull()
  })

  it('asks the tariffs anew when the form is opened again', async () => {
    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, fromTheCall)
    const { router } = await mount('/auftraege/service')
    const fill = async () => {
      await type('Kunde suchen', 'Berg')
      await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
      await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
      await type('Anruf am', callDay)
      await type('um', '02:14')
    }

    await fill()
    expect(
      await screen.findByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 53,55/),
    ).toBeTruthy()

    const [raised] = fromTheCall

    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, [
      {
        ...raised,
        surcharges: { ...raised?.surcharges, night: { flatCents: 6000, basisPoints: 0 } },
      },
    ])
    await act(() => router.navigate({ to: '/auftraege' }))
    await act(() => router.navigate({ to: '/auftraege/service' }))
    await fill()

    expect(
      await screen.findByText(/^Vor dem Auftrag nennen: Notdienstzuschlag Nacht: 71,40/),
    ).toBeTruthy()
  })

  it('takes an emptied day of the call without breaking, and makes no job of it (#1080, #1084)', async () => {
    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, fromTheCall)
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await userEvent.clear(screen.getByLabelText('Anruf am'))

    expect(screen.queryByText(/^Vor dem Auftrag nennen/)).toBeNull()

    // Nor is a job made with a call of 01.01.1900 (#1084).
    await type('Anliegen', 'Heizung ohne Strom')
    await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    expect(
      await screen.findByText('Der Notdiensteinsatz braucht Tag und Uhrzeit des Anrufs.'),
    ).toBeTruthy()
    expect(server.all('jobs')).toHaveLength(0)
  })

  it.each([
    ['a year typed in half', '0026-10-28'],
    ['older than a year', addDays(today(), -367)],
    ['after today', addDays(today(), 1)],
  ])('takes no call %s (#1085)', async (_, day) => {
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Berg')
    await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
    await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
    await type('Anliegen', 'Heizung ohne Strom')
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await type('Anruf am', day)
    await type('um', '02:14')
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    expect(
      await screen.findByText('Der Anruf liegt höchstens ein Jahr zurück und nicht nach heute.'),
    ).toBeTruthy()
    expect(server.all('jobs')).toHaveLength(0)
  })

  it('asks the year of the call anew when saving, after midnight (#1085)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(new Date())
      await mount('/auftraege/service')

      await type('Kunde suchen', 'Berg')
      await userEvent.click(await screen.findByRole('button', { name: /Familie Berg/ }))
      await userEvent.click(screen.getByRole('radio', { name: /Einfamilienhaus Lindenweg/ }))
      await type('Anliegen', 'Heizung ohne Strom')
      await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
      await type('Anruf am', addDays(today(), -366))
      await type('um', '02:14')
      // The form stays open over midnight: the day is then more than a year back.
      vi.setSystemTime(new Date(Date.now() + 86_400_000))
      await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

      expect(
        await screen.findByText('Der Anruf liegt höchstens ein Jahr zurück und nicht nach heute.'),
      ).toBeTruthy()
      expect(server.all('jobs')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('names nothing to a business, and keeps nothing named (#1080)', async () => {
    answers.set(`/on-call-shifts/tariffs?from=${callDay}`, fromTheCall)
    await mount('/auftraege/service')

    await type('Kunde suchen', 'Lutz')
    await type('Name', 'Schreinerei Lutz')
    await userEvent.selectOptions(screen.getByLabelText('Art'), 'business')
    await type('Ort', 'Ladenburg')
    await type('Anliegen', 'Maschine ohne Strom')
    await userEvent.click(screen.getByLabelText('Notdiensteinsatz', { exact: false }))
    await type('Anruf am', callDay)
    await type('um', '02:14')

    expect(screen.queryByText(/^Vor dem Auftrag nennen/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Serviceeinsatz anlegen' }))

    await waitFor(() => {
      expect(server.all('jobs')).toHaveLength(1)
    })
    expect(server.all('jobs')[0]?.['emergencyNamedFlatCents']).toBeUndefined()
  })

  it('marks whoever is away that day', async () => {
    await mount('/auftraege/service')

    const max = await screen.findByRole('checkbox', { name: /Max Becker/ })

    expect(await within(max.closest('label') as HTMLElement).findByText('abwesend')).toBeTruthy()
  })

  it('says what is missing and makes nothing', async () => {
    await mount('/auftraege/service')

    await userEvent.click(await screen.findByRole('button', { name: 'Serviceeinsatz anlegen' }))

    expect(await screen.findByText('Wer anruft, braucht einen Namen.')).toBeTruthy()
    expect(screen.getByText('Worum es geht, steht als Bezeichnung am Auftrag.')).toBeTruthy()
    expect(server.all('jobs')).toEqual([])
    expect(server.all('customers')).toHaveLength(1)
  })

  it('is the office’s, with the right to write jobs', async () => {
    await mount('/auftraege/service', ['technician'])

    expect(
      await screen.findByText('Einen Serviceeinsatz legt an, wer Aufträge bearbeiten darf.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Serviceeinsatz anlegen' })).toBeNull()
  })

  it('is opened from the list of jobs, and only with that right', async () => {
    const { router } = await mount('/auftraege')

    const [open] = await screen.findAllByRole('button', { name: 'Serviceeinsatz erfassen' })

    await userEvent.click(open as HTMLElement)
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/auftraege/service')
    })
  })

  it('is not offered on the list without the right', async () => {
    await mount('/auftraege', ['technician'])

    expect(await screen.findByRole('heading', { name: 'Aufträge' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Serviceeinsatz erfassen' })).toBeNull()
  })
})

describe('the mark of an urgent repair on the job (#292)', () => {
  it('stands in the head and among the facts', async () => {
    server.put('jobs', {
      id: 'j-1',
      customerId: 'c-1',
      siteId: 's-1',
      installationId: null,
      parentJobId: null,
      predecessorJobId: null,
      kind: 'service',
      status: 'active',
      number: 'AU-2026-0240',
      designation: 'Sicherung Küche löst aus',
      description: null,
      vobAgreed: false,
      buildingWork: null,
      urgentRepair: true,
    })

    await mountJob()

    expect(await screen.findByText('Dringende Reparatur')).toBeTruthy()
    expect(screen.getByText('ja, vom Kunden ausdrücklich angefordert')).toBeTruthy()
  })
})

async function mountJob() {
  answers.set('/api/auth/get-session', {
    user: { id: 'u-1', email: 'buero@nord.example.de', name: 'Britta Büro' },
    session: { activeTenantId: 't-1' },
  })
  answers.set('/auth/tenants', [aTenantChoice(['office'])])
  answers.set('/tasks/assignees', [])
  server.put('customers', { ...berg, isBusiness: true })

  const client = await SyncClient.start({
    store: await openLocalStore(`service${String((counter += 1))}`),
    transport: server,
    writer: server,
    deviceId: 'office-computer',
    entities: ['customers', 'sites', 'installations', 'jobs', 'documents', 'job_assignments'],
    onSignedOut: () => {},
  })

  await client.synchronise()

  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/auftraege/$jobId', component: JobScreen }),
      createRoute({
        getParentRoute: () => root,
        path: '/kunden/$customerId',
        component: () => null,
      }),
      createRoute({ getParentRoute: () => root, path: '/objekte/$siteId', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/auftraege/j-1'] }),
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
}
