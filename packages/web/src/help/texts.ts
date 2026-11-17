import { readMarkdown } from '@opengewerk/platform-web'
import type { Inline } from '@opengewerk/platform-web'

/**
 * The texts of the help (#269), as they lie under `packages/web/help`, after
 * the help of OpenGewerk Haustechnik (its #131):
 *
 * - `office/` a text for a page of the office, named after its address
 *   (`objekte.md` for `/objekte`, `index.md` for `/`, the customers),
 * - `site/` a text for a screen on site, named the same way,
 * - `guides/` the quick guides to the core flows of section 8 of the concept,
 * - `manual/` the manual for whoever runs the instance,
 * - `news/` what changed with a version, in the words of a business.
 *
 * They are Markdown in the part the foundation reads (`Markdown` of
 * `@opengewerk/platform-web`) and are built into the application, so that
 * they are read on site without a network. Each folder is a module of its
 * own that is loaded when somebody opens the help, and no part of what a
 * screen loads first. The quick guides and the manual stand on opengewerk.de
 * as well, from the same files.
 *
 * Inside the package and not under `docs/`: the build of the image leaves
 * `docs/` out (`.dockerignore`), and a text the build does not find is
 * missing without a word.
 */

/** The texts of a folder by their key: the path below the folder, without the ending. */
export function byKey(
  found: Readonly<Record<string, string>>,
  folder: string,
): ReadonlyMap<string, string> {
  const marker = `/help/${folder}/`

  return new Map(
    Object.entries(found).map(([path, text]) => [
      path.slice(path.indexOf(marker) + marker.length).replace(/\.md$/, ''),
      text,
    ]),
  )
}

/** The quick guides, in the order section 8 of the concept names the core flows. */
export const guideOrder = [
  'angebot',
  'regiebericht-zur-rechnung',
  'plantafel',
  'pruefprotokoll',
] as const

/** The chapters of the manual, in the order somebody who sets up an instance needs them. */
export const manualOrder = ['installation', 'update', 'sicherung', 'weitere-betriebe'] as const

/** The texts of the screens on site, in the order of its tabs and then the job. */
export const siteHelpOrder = ['index', 'auftrag', 'scannen', 'zeiten', 'konflikte'] as const

/** The versions with notes, newest first: "0.10.0" before "0.9.0". */
export function newsOrder(texts: ReadonlyMap<string, string>): readonly string[] {
  const parts = (version: string) => version.split('.').map((part) => Number(part))

  return [...texts.keys()].sort((one, other) => {
    const [a, b] = [parts(one), parts(other)]

    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (b[index] ?? 0) - (a[index] ?? 0)

      if (difference !== 0) {
        return difference
      }
    }

    return 0
  })
}

/** A line of Markdown in plain words. */
function plain(line: readonly Inline[]): string {
  return line.map((piece) => (piece.kind === 'break' ? ' ' : piece.text)).join('')
}

/** The first paragraph of a text in plain words, for the line under its title in a list. */
export function firstParagraph(source: string): string {
  const paragraph = readMarkdown(source).find((block) => block.kind === 'paragraph')

  return paragraph?.kind === 'paragraph' ? plain(paragraph.line) : ''
}

/** What a text says in plain words, a sentence block each: paragraphs and items of lists. */
export function sayings(source: string): readonly string[] {
  return readMarkdown(source).flatMap((block) =>
    block.kind === 'paragraph'
      ? [plain(block.line)]
      : block.kind === 'list'
        ? block.items.map((item) => plain(item))
        : [],
  )
}

/** The texts of a folder in their order, each with its key; one that is missing is left out. */
export function inOrder(
  texts: ReadonlyMap<string, string>,
  order: readonly string[],
): readonly { readonly key: string; readonly text: string }[] {
  return order.flatMap((key) => {
    const text = texts.get(key)

    return text === undefined ? [] : [{ key, text }]
  })
}
