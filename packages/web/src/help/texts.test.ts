import { markdownProblems, markdownTitle, readMarkdown } from '@opengewerk/platform-web'
import { describe, expect, it } from 'vitest'

import { helpKeyOf, lenders, officeHelpKey } from '../office/help.js'
import { guideTexts } from './guide-texts.js'
import { manualTexts } from './manual-texts.js'
import { newsTexts } from './news-texts.js'
import { officeTexts } from './office-texts.js'
import { searchHelp } from './search.js'
import { siteTexts } from './site-texts.js'
import { guideOrder, manualOrder, newsOrder, siteHelpOrder } from './texts.js'

/**
 * The texts of the help (#269). What these hold is the acceptance of the
 * issue: every page of the office has a text, its own or one it is lent, and
 * a new page without one turns a test red; a text keeps to the part of
 * Markdown the application reads, so that nothing shows up on a screen as the
 * signs it was typed with; and a link of a text leads to a page there is.
 */

const folders = {
  office: officeTexts,
  site: siteTexts,
  guides: guideTexts,
  manual: manualTexts,
  news: newsTexts,
} as const

/** The source of a router, read as text: which pages it has is what a test asks of it. */
function source(found: Readonly<Record<string, string>>): string {
  return Object.values(found).join('\n')
}

const officeRouter = source(
  import.meta.glob<string>('../office/router.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)

/** The addresses of the office, as its router names them: every route whose parent is the office. */
function officePaths(): readonly string[] {
  return routesIn(officeRouter, 'office')
}

/**
 * The paths of the routes below a parent, each read from its own call of
 * `createRoute`, whatever order its properties stand in.
 */
function routesIn(router: string, parent: string): readonly string[] {
  return router
    .split('createRoute(')
    .slice(1)
    .filter((call) => new RegExp(String.raw`getParentRoute:\s*\(\)\s*=>\s*${parent}\b`).test(call))
    .flatMap((call) => {
      const path = /\bpath:\s*'([^']+)'/.exec(call)?.[1]

      return path === undefined ? [] : [path]
    })
}

/** An address with a value for each of its parameters, as a person would open it. */
function opened(path: string): string {
  return path.replace(/\$[A-Za-z]+/g, 'x')
}

/** Whether an address of a link is a page of the office: the same segments, a parameter taking any. */
function isOfficePage(address: string): boolean {
  const wanted = address.split('/').filter(Boolean)

  return officePaths().some((path) => {
    const segments = path.split('/').filter(Boolean)

    return (
      segments.length === wanted.length &&
      segments.every((segment, index) => segment.startsWith('$') || segment === wanted[index])
    )
  })
}

/** Where the links of a text lead, in the order they stand. */
function linksOf(text: string): string[] {
  return readMarkdown(text).flatMap((block) =>
    (block.kind === 'paragraph'
      ? block.line
      : block.kind === 'list'
        ? block.items.flat()
        : []
    ).flatMap((piece) => (piece.kind === 'link' ? [piece.to] : [])),
  )
}

describe('the texts of the help', () => {
  it('give every page of the office a text, its own, of what it lies below, or lent', () => {
    const paths = officePaths()
    const has = (key: string) => officeTexts.has(key)

    // The router is read: a page it has is found here.
    expect(paths.length).toBeGreaterThan(60)
    expect(paths).toContain('/einstellungen/steuern')

    expect(paths.filter((path) => officeHelpKey(opened(path), has) === null)).toEqual([])
  })

  it('read a route of the office whatever order its properties stand in', () => {
    const router = [
      "createRoute({ getParentRoute: () => office, path: '/eins', component: One }),",
      "createRoute({ getParentRoute: () => office, component: Two, path: '/zwei' }),",
      "createRoute({\n  component: Three,\n  getParentRoute: () => office,\n  path: '/drei',\n}),",
      "createRoute({ getParentRoute: () => officeOther, path: '/fremd' }),",
      "createRoute({ getParentRoute: () => instance, path: '/instanz' }),",
    ].join('\n')

    expect(routesIn(router, 'office')).toEqual(['/eins', '/zwei', '/drei'])
  })

  it('lend only texts there are, to addresses the office has', () => {
    for (const { root, from } of lenders) {
      expect(officeTexts.has(helpKeyOf(from)), from).toBe(true)
      expect(
        officePaths().some((path) => path === root || path.startsWith(`${root}/`)),
        root,
      ).toBe(true)
    }
  })

  it('keep to the Markdown the application reads, each under a title', () => {
    for (const [folder, texts] of Object.entries(folders)) {
      expect(texts.size, folder).toBeGreaterThan(0)

      for (const [key, text] of texts) {
        expect(markdownProblems(text), `${folder}/${key}`).toEqual([])
        expect(markdownTitle(text), `${folder}/${key}`).not.toBeNull()
      }
    }
  })

  it('link only to pages of the office there are', () => {
    for (const folder of [officeTexts, guideTexts] as const) {
      for (const [key, text] of folder) {
        for (const to of linksOf(text)) {
          expect(isOfficePage(to), `${key}: ${to}`).toBe(true)
        }
      }
    }
  })

  it('list every quick guide, chapter and screen on site in their order, and nothing else', () => {
    expect([...guideTexts.keys()].sort()).toEqual([...guideOrder].sort())
    expect([...manualTexts.keys()].sort()).toEqual([...manualOrder].sort())
    expect([...siteTexts.keys()].sort()).toEqual([...siteHelpOrder].sort())
  })

  it('name each note after its version and title it with its day, newest first', () => {
    for (const [version, text] of newsTexts) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(markdownTitle(text)).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
    }

    expect(
      newsOrder(
        new Map([
          ['0.9.0', ''],
          ['0.10.0', ''],
          ['0.9.1', ''],
          ['1.0.0', ''],
        ]),
      ),
    ).toEqual(['1.0.0', '0.10.0', '0.9.1', '0.9.0'])
  })
})

describe('the search of the help', () => {
  const sources = {
    pages: new Map([
      ['lager', '# Lager\n\nHier stehen die Lagerorte, jeder mit Bestand.\n\n- Bestand zählen.'],
      ['einstellungen/fristen', '# Fristen\n\nWie lange vorher erinnert wird.'],
    ]),
    guides: new Map([['plantafel', '# Termine auf der Plantafel\n\nWer Urlaub hat.']]),
    news: new Map([['0.8.0', '# 17.11.2026\n\n- Der Bestand im Lager zählt mit.']]),
  }

  it('finds words in pages, quick guides and notes, whatever their case, once in each text', () => {
    const hits = searchHelp('bestand', sources)

    expect(hits.map((hit) => [hit.kind, hit.key])).toEqual([
      ['page', 'lager'],
      ['news', '0.8.0'],
    ])
    expect(hits[0]).toMatchObject({
      before: 'Hier stehen die Lagerorte, jeder mit ',
      found: 'Bestand',
    })
  })

  it('finds a text by its title and then shows its first saying', () => {
    expect(searchHelp('plantafel', sources)).toEqual([
      {
        kind: 'guide',
        key: 'plantafel',
        title: 'Termine auf der Plantafel',
        before: '',
        found: '',
        after: 'Wer Urlaub hat.',
      },
    ])
  })

  it('looks for nothing shorter than three letters', () => {
    expect(searchHelp('  la ', sources)).toEqual([])
    expect(searchHelp('lag', sources).map((hit) => hit.key)).toEqual(['lager', '0.8.0'])
  })
})
