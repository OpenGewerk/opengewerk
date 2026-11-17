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
import { HelpScreen, helpWords } from '../office/screens/help.js'
import { helpFailed } from './use-texts.js'

// Only the notes on versions fail to load, as in a tab that asks after an
// update for a part that is gone; the quick guides are there.
vi.mock('./news-texts.js', () => {
  throw new Error('Kein Netz.')
})

describe('"Hilfe" when only the notes on versions cannot be loaded', () => {
  it('says so in the column of the notes, beside the quick guides', async () => {
    const root = createRootRoute({ component: Outlet })
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: '/hilfe', component: HelpScreen }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/hilfe'] }),
    })

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InApplication>
          <RouterProvider router={router} />
        </InApplication>
      </QueryClientProvider>,
    )

    const notes = await screen.findByRole('region', { name: helpWords.news })

    expect(await within(notes).findByText(helpFailed)).toBeTruthy()
    const guides = await screen.findByRole('region', { name: helpWords.guides })

    expect((await within(guides).findAllByRole('link')).length).toBeGreaterThan(0)
  })
})
