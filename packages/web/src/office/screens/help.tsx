import { cardLink, Markdown, markdownTitle, Panel } from '@opengewerk/platform-web'
import { Empty, NoteBox, PageHead, Screen } from '@opengewerk/platform-web/office'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronRight, Search } from 'lucide-react'
import { useDeferredValue, useState } from 'react'

import { searchHelp, shortestQuery } from '../../help/search.js'
import type { Hit } from '../../help/search.js'
import { firstParagraph, guideOrder, inOrder, newsOrder, sayings } from '../../help/texts.js'
import { useHelpTexts } from '../../help/use-texts.js'
import { helpPlace, newsPlace } from '../help.js'

/** What the pages of the help say around their texts. */
export const helpWords = {
  title: 'Hilfe',
  sub: 'Kurzanleitungen zu den wichtigsten Abläufen, die Texte zu jeder Seite und was neu ist',
  search: 'In der Hilfe suchen',
  guides: 'Kurzanleitungen',
  news: 'Was ist neu',
  newsSub:
    'Was sich mit jeder Fassung für die Arbeit im Betrieb ändert. Die technischen Einzelheiten stehen im CHANGELOG.',
  allNews: 'Alle Versionshinweise',
  version: 'Fassung',
  perPage:
    'Zu jeder Seite gibt es einen eigenen Text. Das Fragezeichen in der Kopfleiste öffnet ihn neben der Seite, auf einem schmalen Bildschirm steht „Hilfe zu dieser Seite“ im Menü. Die Hilfe liegt in der Anwendung und ist auch ohne Netz da; Kurzanleitungen und Handbuch stehen zusätzlich auf opengewerk.de.',
  hits: (count: number, query: string) =>
    count === 1 ? `1 Treffer für „${query}“` : `${count} Treffer für „${query}“`,
  nothing: (query: string) => `Zu „${query}“ steht nichts in der Hilfe.`,
  shortQuery: `Ab ${shortestQuery} Buchstaben wird gesucht.`,
  loading: 'Wird geladen.',
  unknownTitle: 'Nicht gefunden',
  unknown: 'Diese Kurzanleitung gibt es nicht.',
} as const

/** What a hit is, in the small capitals beside its title. */
const kindLabel: Record<Hit['kind'], string> = {
  page: 'Seite',
  guide: 'Kurzanleitung',
  news: 'Versionshinweise',
}

const list = { to: helpPlace, label: helpWords.title } as const

/** Where a hit leads: the page itself, the quick guide, or the notes on versions. */
function hitAddress(hit: Hit): string {
  if (hit.kind === 'guide') {
    return `${helpPlace}/${hit.key}`
  }

  if (hit.kind === 'news') {
    return newsPlace
  }

  return hit.key === 'index' ? '/' : `/${hit.key}`
}

/** The title of a page text in the hits: "Einstellungen, Steuern" for `einstellungen/steuern`. */
function hitTitle(hit: Hit, pages: ReadonlyMap<string, string>): string {
  if (hit.kind === 'news') {
    return `${helpWords.version} ${hit.key}`
  }

  const above = hit.kind === 'page' ? hit.key.slice(0, Math.max(0, hit.key.lastIndexOf('/'))) : ''
  const section = above === '' ? null : markdownTitle(pages.get(above) ?? '')

  return section ? `${section}, ${hit.title}` : hit.title
}

function GuideRows({ texts }: { readonly texts: ReadonlyMap<string, string> }) {
  return (
    <ul className="flex flex-col">
      {inOrder(texts, guideOrder).map(({ key, text }) => (
        <li
          key={key}
          className="relative flex items-center gap-3 border-b border-row py-2.5 last:border-b-0"
        >
          <span className="min-w-0 grow">
            <Link
              to="/hilfe/$guide"
              params={{ guide: key }}
              className={`${cardLink} block text-[14px] font-semibold`}
            >
              {markdownTitle(text) ?? key}
            </Link>
            <span className="mt-0.5 block text-[13px] leading-[1.45] text-ink-muted">
              {firstParagraph(text)}
            </span>
          </span>
          <ChevronRight
            size={18}
            strokeWidth={2}
            aria-hidden="true"
            className="shrink-0 text-ink-faint"
          />
        </li>
      ))}
    </ul>
  )
}

/** What a version brought, in the words of a business: its number, its day and the points. */
function Version({
  version,
  text,
  only,
}: {
  readonly version: string
  readonly text: string
  readonly only?: number
}) {
  const day = markdownTitle(text)
  const points = sayings(text)

  return (
    <div>
      <div className="flex items-baseline gap-2.5">
        <span className="text-[14px] font-semibold">
          {helpWords.version} {version}
        </span>
        {day === null ? null : <span className="text-[13px] text-ink-faint">{day}</span>}
      </div>
      <ul className="mt-1.5 list-disc pl-[18px] text-[13px] leading-[1.5]">
        {(only === undefined ? points : points.slice(0, only)).map((point) => (
          <li key={point} className="mb-1.5">
            {point}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Hits({ query }: { readonly query: string }) {
  const pages = useHelpTexts('office')
  const guides = useHelpTexts('guides')
  const news = useHelpTexts('news')
  const words = query.trim()

  if (pages === undefined || guides === undefined || news === undefined) {
    return <Empty>{helpWords.loading}</Empty>
  }

  if (words.length < shortestQuery) {
    return <Empty>{helpWords.shortQuery}</Empty>
  }

  const hits = searchHelp(words, { pages, guides, news })

  if (hits.length === 0) {
    return <Empty>{helpWords.nothing(words)}</Empty>
  }

  return (
    <Panel title={helpWords.hits(hits.length, words)}>
      <ul className="flex flex-col">
        {hits.map((hit) => (
          <li
            key={`${hit.kind} ${hit.key}`}
            className="relative border-b border-row py-2.5 last:border-b-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <Link to={hitAddress(hit)} className={`${cardLink} text-[14px] font-semibold`}>
                {hitTitle(hit, pages)}
              </Link>
              <span className="font-condensed text-[12px] font-semibold tracking-[1px] text-ink-faint uppercase">
                {kindLabel[hit.kind]}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] leading-[1.5] text-ink-muted">
              {hit.before}
              {hit.found === '' ? null : (
                <mark className="rounded-[2px] bg-sunken px-px font-semibold text-ink">
                  {hit.found}
                </mark>
              )}
              {hit.after}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/**
 * "Hilfe" in the office (#269): a search through every text of the help, the
 * quick guides to the core flows of section 8 of the concept, each a row that
 * opens its text, and what the newest version brought. The help of a single
 * page stands beside that page, behind the question mark of the header, and
 * this screen says so.
 */
export function HelpScreen() {
  const guides = useHelpTexts('guides')
  const news = useHelpTexts('news')
  const [query, setQuery] = useState('')
  const searching = useDeferredValue(query)
  const newest = news === undefined ? undefined : newsOrder(news)[0]

  return (
    <Screen>
      <PageHead title={helpWords.title} sub={helpWords.sub} />
      <div className="relative max-w-[560px]">
        <label className="sr-only" htmlFor="hilfe-suche">
          {helpWords.search}
        </label>
        <Search
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          className="pointer-events-none absolute top-[10px] left-[11px] text-ink-faint max-lg:top-3"
        />
        <input
          id="hilfe-suche"
          type="search"
          value={query}
          placeholder={helpWords.search}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          className="h-9 w-full rounded-control border border-line-strong bg-surface pr-2.5 pl-[34px] text-[14px] text-ink max-lg:h-10"
        />
      </div>
      {searching.trim() === '' ? (
        <div className="flex items-start gap-4 max-lg:flex-col">
          <div className="flex min-w-0 grow flex-col gap-3.5 max-lg:w-full">
            <Panel title={helpWords.guides}>
              {guides === undefined ? (
                <Empty>{helpWords.loading}</Empty>
              ) : (
                <GuideRows texts={guides} />
              )}
            </Panel>
            <NoteBox>{helpWords.perPage}</NoteBox>
          </div>
          {news === undefined || newest === undefined ? null : (
            <div className="w-[360px] shrink-0 max-lg:w-full">
              <Panel title={helpWords.news}>
                <div className="flex flex-col gap-2.5">
                  <Version version={newest} text={news.get(newest) ?? ''} only={3} />
                  <Link to={newsPlace} className={`${cardLink} relative self-start text-[13px]`}>
                    {helpWords.allNews}
                  </Link>
                </div>
              </Panel>
            </div>
          )}
        </div>
      ) : (
        <Hits query={searching} />
      )}
    </Screen>
  )
}

/** A quick guide: its text under its own title, with the way back to the list. */
export function GuideScreen() {
  const { guide } = useParams({ strict: false }) as { guide?: string }
  const texts = useHelpTexts('guides')
  const text = guide === undefined ? undefined : texts?.get(guide)

  if (texts !== undefined && text === undefined) {
    return (
      <Screen>
        <PageHead title={helpWords.unknownTitle} crumbs={[list]} phoneBack={list} />
        <Empty>{helpWords.unknown}</Empty>
      </Screen>
    )
  }

  return (
    <Screen>
      <PageHead
        title={text === undefined ? helpWords.guides : (markdownTitle(text) ?? helpWords.guides)}
        crumbs={[list]}
        phoneBack={list}
      />
      <Panel roomy className="max-w-[760px]">
        {text === undefined ? (
          <Empty>{helpWords.loading}</Empty>
        ) : (
          // The head of the screen is the first heading, the sections of
          // the text follow it as the second.
          <Markdown source={text} withoutTitle level={1} />
        )}
      </Panel>
    </Screen>
  )
}

/** "Was ist neu": what each version brought for the work in a business, newest first. */
export function NewsScreen() {
  const news = useHelpTexts('news')

  return (
    <Screen>
      <PageHead title={helpWords.news} sub={helpWords.newsSub} crumbs={[list]} phoneBack={list} />
      <Panel roomy className="max-w-[760px]">
        {news === undefined ? (
          <Empty>{helpWords.loading}</Empty>
        ) : (
          <div className="flex flex-col gap-[18px]">
            {newsOrder(news).map((version) => (
              <Version key={version} version={version} text={news.get(version) ?? ''} />
            ))}
          </div>
        )}
      </Panel>
    </Screen>
  )
}
