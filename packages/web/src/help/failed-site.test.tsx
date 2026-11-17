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
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InApplication } from '../app/in-application.js'
import { SiteHelpScreen, siteHelpWords } from '../site/help.js'
import { SyncClient } from '../sync/client.js'
import { helpFailed } from './use-texts.js'

// Only the texts of the screens on site fail to load; the quick guides are
// there and stay readable beside them.
vi.mock('./site-texts.js', () => {
  throw new Error('Kein Netz.')
})

describe('"Hilfe" on site when only the texts of the screens cannot be loaded', () => {
  it('says so for them and still lists the quick guides', async () => {
    const server = new TestServer()
    const client = await SyncClient.start({
      store: await openLocalStore('hilfe-baustelle-fehler'),
      transport: server,
      writer: server,
      deviceId: 'site-phone',
      entities: ['tasks'],
      onSignedOut: () => {},
    })
    const root = createRootRoute({ component: Outlet })
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: '/hilfe', component: SiteHelpScreen }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/hilfe'] }),
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

    const screens = await screen.findByRole('region', { name: siteHelpWords.screens })
    const guides = await screen.findByRole('region', { name: siteHelpWords.guides })

    expect(await within(screens).findByText(helpFailed)).toBeTruthy()
    expect((await within(guides).findAllByRole('link')).length).toBeGreaterThan(0)
  })
})
