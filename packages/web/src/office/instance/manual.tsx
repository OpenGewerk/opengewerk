import { cardLink, Markdown, markdownTitle, Panel, useButtonLook } from '@opengewerk/platform-web'
import { InstancePage } from '@opengewerk/platform-web/instance'
import { Empty } from '@opengewerk/platform-web/office'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { firstParagraph, inOrder, manualOrder } from '../../help/texts.js'
import { useHelpTexts } from '../../help/use-texts.js'
import { manualPlace } from '../help.js'

/** What the manual says around its chapters. */
export const manualWords = {
  title: 'Handbuch',
  sub: 'Wie diese Instanz eingerichtet, aktualisiert und gesichert wird',
  chapters: 'Kapitel',
  back: 'Zum Handbuch',
  loading: 'Wird geladen.',
  unknown: 'Dieses Kapitel gibt es nicht.',
} as const

/**
 * The manual for whoever runs the instance (#269, section 8 of the
 * concept): installing, updating, backing up and restoring, and adding a
 * tenant. It stands in the area of the instance, which only they reach, and
 * somebody who runs an instance without being a member of a tenant reaches
 * nothing else.
 */
export function ManualScreen() {
  const texts = useHelpTexts('manual')

  return (
    <InstancePage title={manualWords.title} sub={manualWords.sub}>
      <Panel title={manualWords.chapters}>
        {texts === undefined ? (
          <Empty>{manualWords.loading}</Empty>
        ) : (
          <ul className="flex flex-col">
            {inOrder(texts, manualOrder).map(({ key, text }) => (
              <li
                key={key}
                className="relative flex items-center gap-3 border-b border-row py-2.5 last:border-b-0"
              >
                <span className="min-w-0 grow">
                  <Link
                    to="/instanz/handbuch/$chapter"
                    params={{ chapter: key }}
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
        )}
      </Panel>
    </InstancePage>
  )
}

/** The way back to the chapters, a link dressed as a button: a way, not an action. */
function BackToManual() {
  const look = useButtonLook('secondary', 'normal')

  return (
    <Link to={manualPlace} className={look}>
      <ChevronLeft size={15} strokeWidth={2.3} aria-hidden="true" className="shrink-0" />
      {manualWords.back}
    </Link>
  )
}

/** A chapter of the manual, with the way back to its list. */
export function ManualChapterScreen() {
  const { chapter } = useParams({ strict: false }) as { chapter?: string }
  const texts = useHelpTexts('manual')
  const text = chapter === undefined ? undefined : texts?.get(chapter)

  return (
    <InstancePage
      title={text === undefined ? manualWords.title : (markdownTitle(text) ?? manualWords.title)}
      sub={manualWords.sub}
      actions={<BackToManual />}
    >
      <Panel roomy className="max-w-[760px]">
        {texts === undefined ? (
          <Empty>{manualWords.loading}</Empty>
        ) : text === undefined ? (
          <Empty>{manualWords.unknown}</Empty>
        ) : (
          // The head of the page is the first heading, the sections of
          // the chapter follow it as the second.
          <Markdown source={text} withoutTitle level={1} />
        )}
      </Panel>
    </InstancePage>
  )
}
