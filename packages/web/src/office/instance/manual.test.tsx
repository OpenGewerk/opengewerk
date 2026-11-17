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

import { InApplication } from '../../app/in-application.js'
import { ManualChapterScreen, ManualScreen, manualWords } from './manual.js'

/**
 * The manual in the area of the instance (#269, the boards "Instanz:
 * Handbuch" and "Instanz: Handbuch, Update"): its four chapters in the order
 * somebody who sets up an instance needs them, and a chapter with its
 * commands as they are typed.
 */

function mount(at: string) {
  const root = createRootRoute({ component: Outlet })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/instanz/handbuch',
        component: ManualScreen,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/instanz/handbuch/$chapter',
        component: ManualChapterScreen,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
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
}

describe('the manual of the instance', () => {
  it('lists its four chapters in their order', async () => {
    mount('/instanz/handbuch')

    const chapters = await screen.findByRole('region', { name: manualWords.chapters })

    expect((await within(chapters).findAllByRole('link')).map((link) => link.textContent)).toEqual([
      'Installation',
      'Update',
      'Sicherung und Rückspielen',
      'Weitere Betriebe',
    ])
  })

  it('shows a chapter with its commands as they are typed, and the way back', async () => {
    mount('/instanz/handbuch/update')

    expect(await screen.findByText('sh docker/start.sh')).toBeTruthy()
    expect(screen.getByRole('link', { name: manualWords.back }).getAttribute('href')).toBe(
      '/instanz/handbuch',
    )
  })

  it('says so at an address no chapter has', async () => {
    mount('/instanz/handbuch/gibt-es-nicht')

    expect(await screen.findByText(manualWords.unknown)).toBeTruthy()
  })
})
