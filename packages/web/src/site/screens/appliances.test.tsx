import 'fake-indexeddb/auto'

import { readFormValues, type RecordState } from '@opengewerk/domain'
import { today } from '@opengewerk/platform-web/format'
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
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aTenantChoice } from '../../session/test-tenants.js'
import { SyncClient } from '../../sync/client.js'
import { SiteAppliancesScreen, SiteNewApplianceScreen } from './appliances.js'
import { SiteJobScreen } from './job.js'
import { SiteProtocolScreen } from './protocol.js'

/**
 * The appliances of a site tested on site after DGUV Vorschrift 3 (#303):
 * the card on the job, the list at the site, a tap that opens the draft of
 * today or starts a test from the last one, a new appliance tested right
 * after it is made, the limits worked out of the appliance, and the way to
 * the next one once a test is signed.
 */

/**
 * A browser in a test has no canvas that draws, so making a picture smaller
 * is put in place, as for the files of #77.
 */
vi.mock('../../app/pictures.js', () => ({
  shrinkPicture: (_file: Blob, longEdge: number) =>
    Promise.resolve(new Uint8Array(longEdge > 1000 ? 1000 : 100).fill(7).buffer),
}))

let server: TestServer
let counter = 0

const signature = {
  name: 'Anna Weber',
  path: 'M100,300L240,120L400,280',
  signedAt: '2026-01-10T10:00:00.000Z',
}

/** The last test of the extension lead, signed in January. */
const lastYear = {
  tester: 'Anna Weber',
  instrument: 'Benning ST 760, 21044817',
  test_kind: 'recurring',
  current_method: 'differential',
  housing: 'ok',
  cord: 'ok',
  plug: 'ok',
  markings: 'ok',
  suitability: 'ok',
  protective_conductor: 520,
  function: 'ok',
  safety_devices: 'not_applicable',
  verdict: 'passed',
  next_inspection_months: 12_000,
  tester_signature: signature,
}

function rows(): Readonly<Record<string, RecordState[]>> {
  return {
    customers: [{ id: 'c-1', kind: 'business', name: 'Hausverwaltung Süd GmbH' }],
    sites: [{ id: 's-1', customerId: 'c-1', designation: 'Rheinstraße 12' }],
    jobs: [
      {
        id: 'j-1',
        customerId: 'c-1',
        siteId: 's-1',
        installationId: null,
        kind: 'service',
        status: 'active',
        designation: 'Geräte prüfen',
        number: 'AU-2026-0190',
      },
    ],
    appliances: [
      {
        id: 'a-2',
        siteId: 's-1',
        inventoryNumber: '002',
        designation: 'Verlängerungsleitung 25 m',
        protectionClass: 'I',
        mobility: 'portable',
        location: 'Werkstatt',
        cordLengthMilli: 25_000,
      },
      {
        id: 'a-1',
        siteId: 's-1',
        inventoryNumber: '001',
        designation: 'Bohrhammer',
        protectionClass: 'II',
        mobility: 'portable',
        location: 'Werkstatt',
        cordLengthMilli: null,
      },
    ],
    form_records: [
      {
        id: 'p-1',
        definitionKey: 'dguv-v3',
        definitionVersion: 1,
        installationId: null,
        applianceId: 'a-2',
        jobId: null,
        performedOn: '2026-01-10',
        status: 'signed',
        values: JSON.stringify(lastYear),
      },
    ],
  }
}

async function mount(path: string, more: Readonly<Record<string, RecordState[]>> = {}) {
  for (const [entity, list] of Object.entries({ ...rows(), ...more })) {
    for (const row of list) {
      server.put(entity, row)
    }
  }

  const client = await SyncClient.start({
    store: await openLocalStore(`site-appliances${String((counter += 1))}`),
    transport: server,
    writer: server,
    deviceId: 'geraet-in-der-werkstatt',
    entities: [
      'customers',
      'sites',
      'installations',
      'jobs',
      'appliances',
      'form_records',
      'attachments',
      'attachment_versions',
    ],
    onSignedOut: () => {},
  })

  await client.synchronise()

  const root = createRootRoute()
  const at = (route: string, component: () => React.JSX.Element) =>
    createRoute({ getParentRoute: () => root, path: route, component })
  const router = createRouter({
    routeTree: root.addChildren([
      at('/auftraege/$jobId', SiteJobScreen),
      at('/auftraege/$jobId/geraete', SiteAppliancesScreen),
      at('/auftraege/$jobId/geraete/neu', SiteNewApplianceScreen),
      at('/auftraege/$jobId/pruefprotokolle/$recordId', SiteProtocolScreen),
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A technician, who may add files: the session and the role, the rest of the API not there. */
function asTechnician() {
  const answers = new Map<string, unknown>([
    [
      '/api/auth/get-session',
      {
        user: { id: 'u-1', email: 'anna@nord.example.de', name: 'Anna Weber' },
        session: { activeTenantId: 't-1' },
      },
    ],
    ['/auth/tenants', [aTenantChoice(['technician'])]],
    ['/tasks/assignees', []],
  ])

  vi.stubGlobal('fetch', (path: string) =>
    Promise.resolve(
      new Response(JSON.stringify(answers.get(path) ?? {}), {
        status: answers.has(path) ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

describe('the appliances of a site on site (#303)', () => {
  it('are reached from the job, in the order of their numbers, each with how it stands', async () => {
    const user = userEvent.setup()

    await mount('/auftraege/j-1')

    const card = await screen.findByRole('region', { name: 'Geräte nach DGUV Vorschrift 3' })

    expect(within(card).getByText('2 Geräte am Objekt, heute noch keines geprüft.')).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: 'Geräte prüfen' }))

    const list = await screen.findByRole('list', { name: 'Geräte am Objekt' })
    const names = within(list)
      .getAllByRole('button')
      .map((row) => row.textContent ?? '')

    expect(names[0]).toContain('Bohrhammer')
    expect(names[0]).toContain('Noch nicht geprüft')
    expect(names[1]).toContain('Verlängerungsleitung 25 m')
    expect(names[1]).toContain('Geprüft am 10.01.2026')
  })

  it('starts the test of an appliance from its last one, keeping what describes the test and nothing found', async () => {
    const user = userEvent.setup()
    const { client, router } = await mount('/auftraege/j-1/geraete')

    await user.click(await screen.findByRole('button', { name: /Verlängerungsleitung 25 m/ }))
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/auftraege\/j-1\/pruefprotokolle\//)
    })

    const made = client.list('form_records').find((record) => record['id'] !== 'p-1')

    expect(made).toMatchObject({
      definitionKey: 'dguv-v3',
      applianceId: 'a-2',
      jobId: 'j-1',
      status: 'draft',
      performedOn: today(),
    })
    expect(made && 'installationId' in made ? made['installationId'] : undefined).toBeUndefined()
    expect(readFormValues(made?.['values'])).toEqual({
      tester: 'Anna Weber',
      instrument: 'Benning ST 760, 21044817',
      test_kind: 'recurring',
      current_method: 'differential',
      next_inspection_months: 12_000,
    })
  })

  it('opens the draft of today instead of starting a second test', async () => {
    const user = userEvent.setup()
    const { client, router } = await mount('/auftraege/j-1/geraete')

    await user.click(await screen.findByRole('button', { name: /Bohrhammer/ }))
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/pruefprotokolle\//)
    })

    const first = router.state.location.pathname

    await router.navigate({ to: '/auftraege/j-1/geraete' })
    await user.click(await screen.findByRole('button', { name: /Bohrhammer/ }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(first)
    })
    expect(
      client.list('form_records').filter((record) => record['applianceId'] === 'a-1'),
    ).toHaveLength(1)
  })

  it('judges a measured value by the limit worked out of the appliance', async () => {
    const user = userEvent.setup()

    await mount('/auftraege/j-1/geraete')
    await user.click(await screen.findByRole('button', { name: /Verlängerungsleitung 25 m/ }))
    await user.click(
      await screen
        .findByRole('link', { name: /Messen/ })
        .catch(() => screen.findByRole('button', { name: /Messen/ })),
    )

    // 0,3 Ω up to 5 m and 0,1 Ω for each of the three lengths of 7,5 m begun beyond.
    const resistance = await screen.findByLabelText(/Schutzleiterwiderstand RPE/)

    await user.type(resistance, '0,65')

    expect(await screen.findByText(/Außerhalb des Grenzwerts, höchstens 0,60 Ω/)).toBeTruthy()
    expect(screen.getByText('≥ 1,00 MΩ')).toBeTruthy()
  })

  it('makes an appliance that is missing and tests it right away, without a template', async () => {
    const user = userEvent.setup()
    const { client, router } = await mount('/auftraege/j-1/geraete/neu')

    await user.type(await screen.findByLabelText('Bezeichnung'), 'Kabeltrommel 50 m')
    await user.type(screen.getByLabelText('Inventarnummer'), '008')
    await user.type(screen.getByLabelText('Länge der Anschlussleitung in m'), '50')
    await user.click(screen.getByRole('button', { name: 'Anlegen und prüfen' }))
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/pruefprotokolle\//)
    })

    const appliance = client
      .list('appliances')
      .find((row) => row['designation'] === 'Kabeltrommel 50 m')

    expect(appliance).toMatchObject({
      siteId: 's-1',
      inventoryNumber: '008',
      protectionClass: 'I',
      mobility: 'portable',
      cordLengthMilli: 50_000,
    })
    expect(
      client.list('form_records').find((record) => record['applianceId'] === appliance?.['id']),
    ).toMatchObject({ definitionKey: 'dguv-v3', values: '{}' })
  })

  it('refuses a lead that is no figure before anything is made', async () => {
    const user = userEvent.setup()
    const { client } = await mount('/auftraege/j-1/geraete/neu')

    await user.type(await screen.findByLabelText('Bezeichnung'), 'Kabeltrommel')
    await user.type(screen.getByLabelText('Länge der Anschlussleitung in m'), 'lang')
    await user.click(screen.getByRole('button', { name: 'Anlegen und prüfen' }))

    expect(
      await screen.findByText('Die Länge der Anschlussleitung ist eine Zahl in Metern, etwa 1,5.'),
    ).toBeTruthy()
    expect(client.list('appliances')).toHaveLength(2)
  })
})

describe('a photo of what is wrong with an appliance (#817)', () => {
  it('is taken at its test for the files of the appliance, which its result offers', async () => {
    asTechnician()

    const { client } = await mount('/auftraege/j-1/pruefprotokolle/p-2', {
      form_records: [
        ...(rows()['form_records'] ?? []),
        {
          id: 'p-2',
          definitionKey: 'dguv-v3',
          definitionVersion: 2,
          installationId: null,
          applianceId: 'a-2',
          jobId: 'j-1',
          performedOn: today(),
          status: 'draft',
          values: '{}',
        },
      ],
      attachments: [
        { id: 'f-1', applianceId: 'a-2', siteId: 's-1', title: 'Typenschild' },
        { id: 'f-2', siteId: 's-1', title: 'Hausansicht' },
        { id: 'f-3', applianceId: 'a-2', title: 'Prüfbericht des Herstellers' },
      ],
      attachment_versions: [
        { id: 'v-1', attachmentId: 'f-1', fileName: 'typenschild.jpg', mediaType: 'image/jpeg' },
        { id: 'v-2', attachmentId: 'f-2', fileName: 'haus.jpg', mediaType: 'image/jpeg' },
        { id: 'v-3', attachmentId: 'f-3', fileName: 'bericht.pdf', mediaType: 'application/pdf' },
      ],
    })

    const photo = await screen.findByLabelText('Foto')

    expect(within(photo).getByRole('option', { name: 'Typenschild' })).toBeTruthy()
    expect(within(photo).queryByRole('option', { name: 'Hausansicht' })).toBeNull()
    // A PDF is no photo the page of the protocol could print.
    expect(within(photo).queryByRole('option', { name: 'Prüfbericht des Herstellers' })).toBeNull()
    expect(screen.getByText('Ein Foto aus den Dateien des Geräts.')).toBeTruthy()

    await userEvent.upload(
      await screen.findByLabelText('Foto zum Mangel aufnehmen'),
      new File([new Uint8Array(5000).fill(1)], 'leitung.jpg', { type: 'image/jpeg' }),
    )

    await waitFor(() => {
      expect(
        client
          .list('attachments')
          .filter((row) => !['f-1', 'f-2', 'f-3'].includes(String(row['id']))),
      ).toEqual([
        expect.objectContaining({
          applianceId: 'a-2',
          jobId: 'j-1',
          siteId: 's-1',
          customerId: 'c-1',
        }),
      ])
    })

    const made = client
      .list('attachments')
      .find((row) => !['f-1', 'f-2', 'f-3'].includes(String(row['id'])))

    expect(made && 'installationId' in made ? made['installationId'] : undefined).toBeUndefined()
    expect(
      await screen.findByText(
        'Das Foto liegt bei den Dateien des Geräts und lässt sich oben als Foto wählen.',
      ),
    ).toBeTruthy()
  })

  it('is not offered at a test in the version without a photo', async () => {
    asTechnician()

    const draft = (id: string, version: number) => ({
      id,
      definitionKey: 'dguv-v3',
      definitionVersion: version,
      installationId: null,
      applianceId: id === 'p-2' ? 'a-2' : 'a-1',
      jobId: 'j-1',
      performedOn: today(),
      status: 'draft',
      values: '{}',
    })
    const { router } = await mount('/auftraege/j-1/pruefprotokolle/p-3', {
      form_records: [...(rows()['form_records'] ?? []), draft('p-2', 1), draft('p-3', 2)],
    })

    // In version 2 the button is there once the rights of the person are known.
    expect(await screen.findByRole('button', { name: 'Foto zum Mangel' })).toBeTruthy()

    await router.navigate({ to: '/auftraege/j-1/pruefprotokolle/p-2' })
    await waitFor(() => {
      expect(screen.queryByLabelText('Foto')).toBeNull()
    })
    expect(screen.queryByRole('button', { name: 'Foto zum Mangel' })).toBeNull()
  })

  it('hangs on the job of the route when the draft was begun in the office without one', async () => {
    asTechnician()

    const { client } = await mount('/auftraege/j-1/pruefprotokolle/p-4', {
      form_records: [
        ...(rows()['form_records'] ?? []),
        {
          id: 'p-4',
          definitionKey: 'dguv-v3',
          definitionVersion: 2,
          installationId: null,
          applianceId: 'a-2',
          jobId: null,
          performedOn: today(),
          status: 'draft',
          values: '{}',
        },
      ],
    })

    await userEvent.upload(
      await screen.findByLabelText('Foto zum Mangel aufnehmen'),
      new File([new Uint8Array(5000).fill(1)], 'stecker.jpg', { type: 'image/jpeg' }),
    )

    await waitFor(() => {
      expect(client.list('attachments')).toEqual([
        expect.objectContaining({
          applianceId: 'a-2',
          jobId: 'j-1',
          siteId: 's-1',
          customerId: 'c-1',
        }),
      ])
    })
  })
})

describe('the photo of a signed test of an appliance (#817)', () => {
  it('is shown as a picture, in the version the protocol was signed with', async () => {
    const preview = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

    vi.stubGlobal('fetch', (path: string) =>
      Promise.resolve(
        // Only the version of the signature has its preview on the server here.
        path === '/attachments/versions/v-1/preview'
          ? new Response(preview, { headers: { 'Content-Type': 'image/jpeg' } })
          : new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }),
      ),
    )

    await mount('/auftraege/j-1/pruefprotokolle/p-5', {
      form_records: [
        ...(rows()['form_records'] ?? []),
        {
          id: 'p-5',
          definitionKey: 'dguv-v3',
          definitionVersion: 2,
          installationId: null,
          applianceId: 'a-2',
          jobId: 'j-1',
          performedOn: '2026-11-02',
          status: 'signed',
          changeSequence: 10,
          values: JSON.stringify({ ...lastYear, photo: 'f-1' }),
        },
      ],
      // Renamed and hung on another appliance after the signature.
      attachments: [{ id: 'f-1', applianceId: 'a-1', title: 'Alles in Ordnung' }],
      attachment_versions: [
        {
          id: 'v-2',
          attachmentId: 'f-1',
          fileName: 'neu.jpg',
          mediaType: 'image/jpeg',
          previewSha256: 'b'.repeat(64),
          changeSequence: 20,
        },
        {
          id: 'v-1',
          attachmentId: 'f-1',
          fileName: 'leitung.jpg',
          mediaType: 'image/jpeg',
          previewSha256: 'a'.repeat(64),
          changeSequence: 5,
        },
      ],
    })

    expect(await screen.findByRole('img', { name: 'leitung.jpg' })).toBeTruthy()
    expect(screen.queryByText('Alles in Ordnung')).toBeNull()
  })
})

describe('a file without a picture in a signed protocol (#817)', () => {
  it('is named by its version, as before, and drawn as no picture', async () => {
    await mount('/auftraege/j-1/pruefprotokolle/p-6', {
      form_records: [
        ...(rows()['form_records'] ?? []),
        {
          id: 'p-6',
          definitionKey: 'dguv-v3',
          definitionVersion: 2,
          installationId: null,
          applianceId: 'a-2',
          jobId: 'j-1',
          performedOn: '2026-11-02',
          status: 'signed',
          changeSequence: 10,
          values: JSON.stringify({ ...lastYear, photo: 'f-9' }),
        },
      ],
      attachments: [{ id: 'f-9', applianceId: 'a-2', title: 'Datenblatt' }],
      attachment_versions: [
        {
          id: 'v-9',
          attachmentId: 'f-9',
          fileName: 'datenblatt.pdf',
          mediaType: 'application/pdf',
          changeSequence: 5,
        },
      ],
    })

    expect(await screen.findByText('datenblatt.pdf')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'datenblatt.pdf' })).toBeNull()
  })
})

describe('a test signed on the device and not sent yet (#817)', () => {
  it('shows the newest version of its photo, the one the server will stamp after it', async () => {
    const preview = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

    vi.stubGlobal('fetch', (path: string) =>
      Promise.resolve(
        path === '/attachments/versions/v-2/preview'
          ? new Response(preview, { headers: { 'Content-Type': 'image/jpeg' } })
          : new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }),
      ),
    )

    const draft = { ...lastYear, photo: 'f-1', tester_signature: undefined }
    const { client } = await mount('/auftraege/j-1/pruefprotokolle/p-7', {
      form_records: [
        ...(rows()['form_records'] ?? []),
        {
          id: 'p-7',
          definitionKey: 'dguv-v3',
          definitionVersion: 2,
          installationId: null,
          applianceId: 'a-2',
          jobId: 'j-1',
          performedOn: today(),
          status: 'draft',
          changeSequence: 10,
          values: JSON.stringify(draft),
        },
      ],
      attachments: [{ id: 'f-1', applianceId: 'a-2', title: 'Anschlussleitung' }],
      attachment_versions: [
        {
          id: 'v-2',
          attachmentId: 'f-1',
          fileName: 'neu.jpg',
          mediaType: 'image/jpeg',
          previewSha256: 'b'.repeat(64),
          changeSequence: 15,
        },
        {
          id: 'v-1',
          attachmentId: 'f-1',
          fileName: 'leitung.jpg',
          mediaType: 'image/jpeg',
          previewSha256: 'a'.repeat(64),
          changeSequence: 5,
        },
      ],
    })

    server.offline = true
    await client.update('form_records', 'p-7', {
      status: 'signed',
      values: JSON.stringify({ ...lastYear, photo: 'f-1' }),
    })

    expect(client.isPending('form_records', 'p-7')).toBe(true)
    expect(await screen.findByRole('img', { name: 'neu.jpg' })).toBeTruthy()
  })
})
