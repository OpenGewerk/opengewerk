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
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { InApplication } from '../../app/in-application.js'
import { GuideScreen, HelpScreen, helpWords, NewsScreen } from './help.js'

/**
 * "Hilfe" in the office (#269, the boards "Hilfe", "Hilfe, Suche",
 * "Kurzanleitung" and "Was ist neu"): the quick guides, a search through the
 * texts of the office, the quick guides and the notes on versions, and what each version brought, newest first. The texts
 * are the ones the application ships; what each holds is tested where they
 * are (`help/texts.test.ts`).
 */

function mount(at: string) {
  const root = createRootRoute({ component: Outlet })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/hilfe', component: HelpScreen }),
      createRoute({ getParentRoute: () => root, path: '/hilfe/neu', component: NewsScreen }),
      createRoute({ getParentRoute: () => root, path: '/hilfe/$guide', component: GuideScreen }),
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

describe('"Hilfe" in the office', () => {
  it('lists the quick guides in their order and what the newest version brought', async () => {
    mount('/hilfe')

    const guides = await screen.findByRole('region', { name: helpWords.guides })

    // The texts are a part of their own and arrive a moment after the screen.
    const rows = await within(guides).findAllByRole('link')

    expect(rows.map((link) => link.textContent)).toEqual([
      'Angebot schreiben und verschicken',
      'Vom Regiebericht zur Rechnung',
      'Termine auf der Plantafel',
      'Prüfprotokoll der Erstprüfung',
    ])

    const news = await screen.findByRole('region', { name: helpWords.news })

    expect(within(news).getByText('Fassung 0.8.0')).toBeTruthy()
    expect(within(news).getAllByRole('listitem')).toHaveLength(3)
    expect(within(news).getByRole('link', { name: helpWords.allNews }).getAttribute('href')).toBe(
      '/hilfe/neu',
    )
  })

  it('searches the texts of the office, the quick guides and the notes once there are three letters, and leads to where a hit stands', async () => {
    const user = userEvent.setup()
    mount('/hilfe')

    const field = await screen.findByRole('searchbox', { name: helpWords.search })

    await user.type(field, 'Wa')

    expect(await screen.findByText(helpWords.shortQuery)).toBeTruthy()

    await user.type(field, 'rtungsvertrag')

    const hits = await screen.findByRole('region', { name: /Treffer für „Wartungsvertrag“/ })
    const links = within(hits).getAllByRole('link')

    expect(links.map((link) => link.getAttribute('href'))).toContain('/wartungsvertraege')
    expect(within(hits).getAllByText('Wartungsvertrag').length).toBeGreaterThan(0)

    // A page below a section carries the title of the section, so that two
    // pages of the same name stay apart.
    await user.clear(field)
    await user.type(field, 'Fristen')

    const deadlines = await screen.findByRole('region', { name: /Treffer für „Fristen“/ })
    const titles = within(deadlines)
      .getAllByRole('link')
      .map((link) => link.textContent)

    expect(titles).toContain('Einstellungen, Fristen')
    expect(titles).toContain('Fristen')

    await user.clear(field)
    await user.type(field, 'Quargelbrot')

    expect(await screen.findByText(helpWords.nothing('Quargelbrot'))).toBeTruthy()
  })

  it('shows a guide under its own title, with the way back to the list', async () => {
    mount('/hilfe/regiebericht-zur-rechnung')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vom Regiebericht zur Rechnung' }),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Schritt für Schritt' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: helpWords.title })[0]?.getAttribute('href')).toBe(
      '/hilfe',
    )
  })

  it('says so at an address no guide has', async () => {
    mount('/hilfe/gibt-es-nicht')

    expect(await screen.findByText(helpWords.unknown)).toBeTruthy()
  })

  it('lists what each version brought, newest first', async () => {
    mount('/hilfe/neu')

    await screen.findByRole('heading', { level: 1, name: helpWords.news })

    const versions = await screen.findAllByText(/^Fassung \d+\.\d+\.\d+$/)

    expect(versions.map((version) => version.textContent)).toEqual([
      'Fassung 0.8.0',
      'Fassung 0.7.0',
    ])
  })
})
