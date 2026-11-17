import { markdownTitle } from '@opengewerk/platform-web'

import { sayings } from './texts.js'

/** Where a hit stands: the text of a page, a quick guide, or the notes on a version. */
export type HitKind = 'page' | 'guide' | 'news'

/** A place in the help where the words stand, with the words around them. */
export interface Hit {
  readonly kind: HitKind
  readonly key: string
  readonly title: string
  readonly before: string
  readonly found: string
  readonly after: string
}

/** The texts the search goes through, each folder by its key. */
export interface HelpSources {
  readonly pages: ReadonlyMap<string, string>
  readonly guides: ReadonlyMap<string, string>
  readonly news: ReadonlyMap<string, string>
}

/** How many characters a hit shows on either side of the words. */
const around = 60

/** Fewer letters than this find too much to read. */
export const shortestQuery = 3

/**
 * The search of the help (#269, the knowledge base with a search of section
 * 8): every text whose title or sayings hold the words, ignoring case, at
 * most one hit for each text, at the first place the words stand. A title
 * that holds them shows its first saying. Pages first, then the quick guides,
 * then the notes on versions, each in the order of their keys.
 */
export function searchHelp(query: string, sources: HelpSources): readonly Hit[] {
  const words = query.trim().toLocaleLowerCase('de')

  if (words.length < shortestQuery) {
    return []
  }

  const folders: readonly (readonly [HitKind, ReadonlyMap<string, string>])[] = [
    ['page', sources.pages],
    ['guide', sources.guides],
    ['news', sources.news],
  ]

  return folders.flatMap(([kind, texts]) =>
    [...texts.entries()]
      .sort(([one], [other]) => one.localeCompare(other, 'de'))
      .flatMap(([key, text]) => {
        const title = markdownTitle(text) ?? key
        const lines = sayings(text)

        for (const line of lines) {
          const at = line.toLocaleLowerCase('de').indexOf(words)

          if (at >= 0) {
            const start = Math.max(0, at - around)
            const end = Math.min(line.length, at + words.length + around)

            return [
              {
                kind,
                key,
                title,
                before: `${start > 0 ? '…' : ''}${line.slice(start, at)}`,
                found: line.slice(at, at + words.length),
                after: `${line.slice(at + words.length, end)}${end < line.length ? '…' : ''}`,
              },
            ]
          }
        }

        if (title.toLocaleLowerCase('de').includes(words)) {
          const first = lines[0] ?? ''

          return [
            {
              kind,
              key,
              title,
              before: '',
              found: '',
              after: first.length > 2 * around ? `${first.slice(0, 2 * around)}…` : first,
            },
          ]
        }

        return []
      }),
  )
}
