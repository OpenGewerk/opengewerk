import { useQuery } from '@tanstack/react-query'

/**
 * The texts of a folder of the help, loaded when a screen asks for them
 * (#269, after #131 of OpenGewerk Haustechnik). Each is a module of the build, so it comes from the cache of the
 * service worker where there is no network, and it does not change while a
 * page is open. `networkMode` says so to the query, which would otherwise
 * wait for a network that is not needed.
 */
const loaders = {
  guides: () => import('./guide-texts.js').then((module) => module.guideTexts),
  site: () => import('./site-texts.js').then((module) => module.siteTexts),
  manual: () => import('./manual-texts.js').then((module) => module.manualTexts),
  office: () => import('./office-texts.js').then((module) => module.officeTexts),
  news: () => import('./news-texts.js').then((module) => module.newsTexts),
} as const

export type HelpFolder = keyof typeof loaders

/** The texts of a folder as a screen gets them: there, on their way, or failed. */
export type HelpTexts = ReadonlyMap<string, string> | null | undefined

/** Whether the texts are there. */
export function present(texts: HelpTexts): texts is ReadonlyMap<string, string> {
  return texts !== undefined && texts !== null
}

/** What a screen says while texts are not there: that they are on their way, or that they failed. */
export function absence(loading: string, ...texts: readonly HelpTexts[]): string {
  return texts.includes(null) ? helpFailed : loading
}

/** What a screen says when a text could not be loaded. */
export const helpFailed = 'Die Hilfe ließ sich nicht laden. Lade die Seite neu.'

/**
 * The texts by their key, nothing while they are on their way, and `null`
 * once they could not be loaded, so that a screen says so instead of loading
 * for good.
 */
export function useHelpTexts(folder: HelpFolder): HelpTexts {
  const query = useQuery({
    queryKey: ['help', 'texts', folder],
    queryFn: loaders[folder],
    staleTime: Infinity,
    networkMode: 'always',
    retry: false,
  })

  return query.isError ? null : query.data
}
