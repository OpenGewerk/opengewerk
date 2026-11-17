import 'fake-indexeddb/auto'

import { openLocalStore, SyncProvider } from '@opengewerk/platform-web/sync'
import { TestServer } from '@opengewerk/platform-web/testing'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { InApplication } from '../app/in-application.js'
import { ManualChapterScreen } from '../office/instance/manual.js'
import { GuideScreen, HelpScreen, NewsScreen } from '../office/screens/help.js'
import { SiteGuideScreen, SiteHelpScreen, SiteScreenHelpScreen } from '../site/help.js'
import { SyncClient } from '../sync/client.js'
import { helpFailed } from './use-texts.js'

// Every folder of the help fails to load, as on a device without the cache
// of the service worker and without a network, or in a tab that asks after an
// update for a part that is gone. Each screen says so, and none says that a
// text does not exist or stays at loading for good.
const { offline } = vi.hoisted(() => ({
  offline: () => {
    throw new Error('Kein Netz.')
  },
}))

vi.mock('./guide-texts.js', offline)
vi.mock('./site-texts.js', offline)
vi.mock('./manual-texts.js', offline)
vi.mock('./office-texts.js', offline)
vi.mock('./news-texts.js', offline)

let counter = 0

async function mount(path: string, at: string, component: () => ReactNode) {
  const server = new TestServer()
  const client = await SyncClient.start({
    store: await openLocalStore(`hilfe-fehler${String((counter += 1))}`),
    transport: server,
    writer: server,
    deviceId: 'site-phone',
    entities: ['tasks'],
    onSignedOut: () => {},
  })
  const root = createRootRoute({ component: Outlet })
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path, component })]),
    history: createMemoryHistory({ initialEntries: [at] }),
  })

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InApplication>
        <SyncProvider client={client}>
          <RouterProvider router={router} />
        </SyncProvider>
      </InApplication>
    </QueryClientProvider>,
  )
}

describe('the help when its texts cannot be loaded', () => {
  it.each([
    ['the office, "Hilfe"', '/hilfe', '/hilfe', HelpScreen],
    ['the office, a quick guide', '/hilfe/$guide', '/hilfe/angebot', GuideScreen],
    ['the office, the notes on versions', '/hilfe/neu', '/hilfe/neu', NewsScreen],
    ['the manual, a chapter', '/handbuch/$chapter', '/handbuch/update', ManualChapterScreen],
    ['the site, "Hilfe"', '/hilfe', '/hilfe', SiteHelpScreen],
    ['the site, a quick guide', '/hilfe/$guide', '/hilfe/angebot', SiteGuideScreen],
    [
      'the site, the text of a screen',
      '/hilfe/bildschirm/$screen',
      '/hilfe/bildschirm/scannen',
      SiteScreenHelpScreen,
    ],
  ] as const)('says so on %s', async (_, path, at, component) => {
    await mount(path, at, component)

    expect((await screen.findAllByText(helpFailed)).length).toBeGreaterThan(0)
  })
})
