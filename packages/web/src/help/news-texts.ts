import { byKey } from './texts.js'

/** What changed with a version, each under its number. */
export const newsTexts = byKey(
  import.meta.glob<string>('../../help/news/*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  'news',
)
