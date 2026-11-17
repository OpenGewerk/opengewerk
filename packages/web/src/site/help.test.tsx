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
import { describe, expect, it } from 'vitest'

import { InApplication } from '../app/in-application.js'
import { SyncClient } from '../sync/client.js'
import { SiteGuideScreen, SiteHelpScreen, siteHelpWords, SiteScreenHelpScreen } from './help.js'

/**
 * "Hilfe" on site (#269, the boards "Hilfe auf der Baustelle" and
 * "Kurzanleitung auf der Baustelle"): a text for each screen and the quick
 * guides, from the menu, read without a network.
 */

let counter = 0

async function mount(at: string) {
  const server = new TestServer()
  const client = await SyncClient.start({
    store: await openLocalStore(`hilfe${String((counter += 1))}`),
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
      createRoute({
        getParentRoute: () => root,
        path: '/hilfe/bildschirm/$screen',
        component: SiteScreenHelpScreen,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/hilfe/$guide',
        component: SiteGuideScreen,
      }),
    ]),
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

describe('"Hilfe" on site', () => {
  it('lists a text for each screen and the quick guides, and says it is there without a network', async () => {
    await mount('/hilfe')

    const screens = await screen.findByRole('region', { name: siteHelpWords.screens })

    expect(
      (await within(screens).findAllByRole('link')).map((link) => link.getAttribute('href')),
    ).toEqual([
      '/hilfe/bildschirm/index',
      '/hilfe/bildschirm/auftrag',
      '/hilfe/bildschirm/scannen',
      '/hilfe/bildschirm/zeiten',
      '/hilfe/bildschirm/konflikte',
    ])

    // The quick guides load on their own, beside the texts of the screens.
    const guides = await screen.findByRole('region', { name: siteHelpWords.guides })

    expect(await within(guides).findAllByRole('link')).toHaveLength(4)
    expect(screen.getByText(siteHelpWords.offline)).toBeTruthy()
  })

  it('shows the text of a screen and a quick guide under their titles', async () => {
    await mount('/hilfe/bildschirm/scannen')

    expect(await screen.findByText(/QR-Etikett einer Anlage/)).toBeTruthy()
  })

  it('says so at an address no text has', async () => {
    await mount('/hilfe/gibt-es-nicht')

    expect(await screen.findByText(siteHelpWords.unknown)).toBeTruthy()
  })
})
