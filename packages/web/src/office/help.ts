import type { HelpLink, HelpSource } from '@opengewerk/platform-web/office'
import { accountQuery, instanceAccessQuery } from '@opengewerk/platform-web/session'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, List } from 'lucide-react'
import { useMemo } from 'react'

/**
 * The help of the office (#269): which text belongs to which address, and
 * where the drawer leads beyond the screen. The button, its entry behind
 * "Menü" and the drawer are the foundation's (ADR 0010); the texts are this
 * application's and lie as Markdown under `packages/web/help/office`, each
 * named after the address it belongs to.
 */

/** Where the quick guides stand in the office, the notes on each version, and the manual in the area of the instance. */
export const helpPlace = '/hilfe'
export const newsPlace = '/hilfe/neu'
export const manualPlace = '/instanz/handbuch'

/** The name a text is kept under: the address without its first slash, and `index` for the first screen. */
export function helpKeyOf(address: string): string {
  const path = address.replace(/^\/+|\/+$/g, '')

  return path === '' ? 'index' : path
}

/**
 * Places that keep their records at an address of their own lend them their
 * text, as the customers at `/` do for `/kunden/…`; an entry of the
 * navigation names the same in its `also`. Each names the page whose text it
 * lends by its address.
 */
export const lenders: readonly { readonly root: string; readonly from: string }[] = [
  { root: '/kunden', from: '/' },
  { root: '/geraete', from: '/objekte' },
  { root: '/verteiler', from: '/anlagen' },
  { root: '/stromkreise', from: '/anlagen' },
  { root: '/wechselrichter', from: '/anlagen' },
  { root: '/strings', from: '/anlagen' },
  { root: '/a', from: '/anlagen' },
  { root: '/pruefprotokolle', from: '/anlagen' },
  { root: '/maengel', from: '/auftraege' },
  { root: '/leads', from: '/vertrieb' },
]

/**
 * The text of an address, by its name: the one of the address itself, or of
 * what it lies below, so that a customer reads the text of the customers and
 * "Einstellungen, Steuern" its own. An address none of this finds a text for
 * has none, and the drawer says so.
 */
export function officeHelpKey(pathname: string, has: (key: string) => boolean): string | null {
  const segments = pathname.split('/').filter(Boolean)
  const path = `/${segments.join('/')}`

  if (segments.length === 0) {
    return has('index') ? 'index' : null
  }

  for (let length = segments.length; length > 0; length -= 1) {
    const key = segments.slice(0, length).join('/')

    if (has(key)) {
      return key
    }
  }

  const lender = lenders.find(({ root }) => path === root || path.startsWith(`${root}/`))

  const key = lender === undefined ? null : helpKeyOf(lender.from)

  return key !== null && has(key) ? key : null
}

const guides: HelpLink = { to: helpPlace, label: 'Kurzanleitungen', icon: List }
const manual: HelpLink = { to: manualPlace, label: 'Handbuch öffnen', icon: BookOpen }

/**
 * The help as the frame of the office asks it. The texts are loaded when the
 * drawer is opened for the first time. The manual is about running the
 * instance, so the way to it stands for whoever runs it, as the area of the
 * instance does in the menu of the person.
 */
export function useOfficeHelp(): HelpSource {
  const account = useQuery(accountQuery)
  const access = useQuery({ ...instanceAccessQuery, enabled: Boolean(account.data) })
  const runsInstance = access.data?.operator === true

  return useMemo(
    () => ({
      textAt: async (pathname: string) => {
        const { officeTexts } = await import('../help/office-texts.js')
        const key = officeHelpKey(pathname, (name) => officeTexts.has(name))

        return key === null ? null : (officeTexts.get(key) ?? null)
      },
      more: runsInstance ? [manual, guides] : [guides],
    }),
    [runsInstance],
  )
}
