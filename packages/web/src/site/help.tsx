import { Markdown, markdownTitle, Panel } from '@opengewerk/platform-web'
import {
  SiteHeader,
  SiteRow,
  SiteRows,
  SiteScreen,
  SiteText,
  TopTitle,
} from '@opengewerk/platform-web/site'
import { useParams } from '@tanstack/react-router'
import { WifiOff } from 'lucide-react'

import { applicationName } from '../app/name.js'
import { firstParagraph, guideOrder, inOrder, siteHelpOrder } from '../help/texts.js'
import { absence, present, useHelpTexts } from '../help/use-texts.js'
import { siteHelpPlace } from './help-row.js'

/** What the help on site says around its texts. */
export const siteHelpWords = {
  title: 'Hilfe',
  screens: 'Zu den Bildschirmen',
  guides: 'Kurzanleitungen',
  offline: 'Die Hilfe liegt auf dem Gerät und ist ohne Netz lesbar.',
  loading: 'Wird geladen.',
  unknown: 'Diesen Text gibt es nicht.',
} as const

const back = { to: siteHelpPlace, label: siteHelpWords.title } as const

/**
 * "Hilfe" on site (#269): a text for each screen of the tabs and the menu,
 * and the quick guides to the core flows. The texts are part of the build
 * and are read without a network, which is where somebody stands who looks
 * for them in a cellar.
 */
export function SiteHelpScreen() {
  const screens = useHelpTexts('site')
  const guides = useHelpTexts('guides')

  return (
    <SiteScreen>
      <TopTitle over={applicationName} title={siteHelpWords.title} />
      {/* First, as the board has it: who looks for the help may well stand in a cellar. */}
      <p className="flex items-start gap-2.5 text-[15px] leading-[1.45] text-ink-muted">
        <WifiOff size={18} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{siteHelpWords.offline}</span>
      </p>
      {/* Each part on its own: one that fails leaves the other readable. */}
      <Panel title={siteHelpWords.screens}>
        {present(screens) ? (
          <SiteRows label={siteHelpWords.screens}>
            {inOrder(screens, siteHelpOrder).map(({ key, text }) => (
              <SiteRow
                key={key}
                to={`/hilfe/bildschirm/${key}`}
                title={markdownTitle(text) ?? key}
                meta={firstParagraph(text)}
              />
            ))}
          </SiteRows>
        ) : (
          <SiteText muted>{absence(siteHelpWords.loading, screens)}</SiteText>
        )}
      </Panel>
      <Panel title={siteHelpWords.guides}>
        {present(guides) ? (
          <SiteRows label={siteHelpWords.guides}>
            {inOrder(guides, guideOrder).map(({ key, text }) => (
              <SiteRow
                key={key}
                to={`/hilfe/${key}`}
                title={markdownTitle(text) ?? key}
                meta={firstParagraph(text)}
              />
            ))}
          </SiteRows>
        ) : (
          <SiteText muted>{absence(siteHelpWords.loading, guides)}</SiteText>
        )}
      </Panel>
    </SiteScreen>
  )
}

/** A text of the help in the type of the site, under the header with the way back to the list. */
function HelpText({ texts, name }: { readonly texts: 'site' | 'guides'; readonly name?: string }) {
  const found = useHelpTexts(texts)
  const text = name === undefined ? undefined : found?.get(name)

  return (
    <>
      <SiteHeader
        title={
          text === undefined ? siteHelpWords.title : (markdownTitle(text) ?? siteHelpWords.title)
        }
        back={back}
      />
      <SiteScreen>
        {!present(found) ? (
          <SiteText muted>{absence(siteHelpWords.loading, found)}</SiteText>
        ) : text === undefined ? (
          <SiteText muted>{siteHelpWords.unknown}</SiteText>
        ) : (
          <Panel>
            <Markdown source={text} withoutTitle large level={1} />
          </Panel>
        )}
      </SiteScreen>
    </>
  )
}

/** The text of a screen on site. */
export function SiteScreenHelpScreen() {
  const { screen } = useParams({ strict: false }) as { screen?: string }

  return <HelpText texts="site" {...(screen === undefined ? {} : { name: screen })} />
}

/** A quick guide on site. */
export function SiteGuideScreen() {
  const { guide } = useParams({ strict: false }) as { guide?: string }

  return <HelpText texts="guides" {...(guide === undefined ? {} : { name: guide })} />
}
