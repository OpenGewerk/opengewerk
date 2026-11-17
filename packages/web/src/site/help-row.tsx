import { Link } from '@tanstack/react-router'
import { CircleQuestionMark } from 'lucide-react'

/** Where the help stands on site. */
export const siteHelpPlace = '/hilfe'

/**
 * The row of the menu that leads to the help, for everybody who holds a
 * device (#269, the board "Menü mit Hilfe"). A file of its own: the menu
 * comes with every screen, the help only when somebody opens it.
 */
export function HelpMenuRow() {
  return (
    <Link
      to={siteHelpPlace}
      className="flex min-h-14 items-center gap-3 rounded-[6px] px-3.5 text-[17px] text-ink no-underline"
    >
      <CircleQuestionMark size={22} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
      <span className="grow">
        Hilfe
        <span className="block text-[14px] text-ink-muted">Auch ohne Netz</span>
      </span>
    </Link>
  )
}
