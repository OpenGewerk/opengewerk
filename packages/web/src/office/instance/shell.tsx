import { InstanceFrame } from '@opengewerk/platform-web/instance'
import type { InstanceEntry } from '@opengewerk/platform-web/instance'
import {
  BookOpen,
  File as FileIcon,
  History,
  House,
  RefreshCw,
  Settings,
  Shield,
  ShieldCheck,
} from 'lucide-react'

/**
 * The screens of the area of the instance (#188), `INSTANCE_NAV` of the
 * canvas, by this application's words: the businesses on it, part B of the
 * measures, the operators for whoever runs it, the legal texts of the
 * instance (#619) and the update of the instance (#1093).
 */
const navigation: readonly InstanceEntry[] = [
  { to: '/instanz', label: 'Betriebe', icon: House },
  { to: '/instanz/einstellungen', label: 'Einstellungen', icon: Settings },
  // Which version runs, and the update to a newer one (#1093).
  { to: '/instanz/aktualisierung', label: 'Aktualisierung', icon: RefreshCw },
  // Part B of the measures and the subprocessors (#319).
  { to: '/instanz/massnahmen', label: 'Maßnahmen', icon: ShieldCheck },
  { to: '/instanz/betreiber', label: 'Betreiber', icon: Shield },
  { to: '/instanz/rechtstexte', label: 'Rechtstexte', icon: FileIcon },
  { to: '/instanz/protokoll', label: 'Protokoll', icon: History },
  // The manual for running the instance (#269).
  { to: '/instanz/handbuch', label: 'Handbuch', icon: BookOpen },
]

/**
 * The area of the instance in the office. Its frame is the foundation's
 * (ADR 0010); the router mounts this as the route over the screens of the
 * area, which are the foundation's as well, except for the log.
 */
export function InstanceShell() {
  return <InstanceFrame navigation={navigation} />
}
