/**
 * The update of the instance from its area (opengewerk#1093), as its screen
 * reads it.
 *
 * A service of its own beside the application looks once a day for the
 * newest release and updates the instance when somebody who runs it asks for
 * it: a backup first, then the kit of the new version with its signature
 * checked, then the start of that version. The application only reads what
 * that service writes and hands it a request; it never talks to Docker.
 */

/**
 * Whether the instance can be updated from its area: `ready`, or `checkout`
 * for an instance run from the source, which is updated with git, or
 * `unsupported`, with the reason.
 */
export type InstanceUpdateMode = 'ready' | 'checkout' | 'unsupported'

/**
 * Why the instance cannot be updated from its area. `unsigned` is a kit
 * whose images are not named by their digest, `directory` an installation
 * whose path on the machine is not known (Docker Desktop on Windows or macOS,
 * or a path with a blank in it), `elsewhere` a path that names another folder
 * than the one the service was started from, `docker` a service that cannot
 * ask Docker about itself, `application` an installation whose names cannot
 * be read.
 */
export type InstanceUpdateReason =
  'checkout' | 'unsigned' | 'directory' | 'elsewhere' | 'docker' | 'application'

/**
 * Why the service turned a request away: `expired` for one older than ten
 * minutes when it was taken, `version` for another version than the newest,
 * `current` for a version that is installed already, `running` for an
 * update under way, or one of the reasons above.
 */
export type InstanceUpdateRefusal =
  'expired' | 'version' | 'current' | 'running' | InstanceUpdateReason

/** The steps of an update, in their order; a run names the one it is in by its number. */
export const instanceUpdateSteps = [
  'backup',
  'download',
  'images',
  'migration',
  'restart',
  'check',
] as const

export type InstanceUpdateStep = (typeof instanceUpdateSteps)[number]

/** The steps by the names the screen and the logs give them. */
export const instanceUpdateStepNames: Readonly<Record<InstanceUpdateStep, string>> = {
  backup: 'Sichern',
  download: 'Neue Fassung laden und prüfen',
  images: 'Abbilder holen und prüfen',
  migration: 'Datenbank migrieren',
  restart: 'Neu starten',
  check: 'Fassung prüfen',
}

/** Whether version `a` comes after version `b`, both of the form 1.2.3, by number and not as text. */
export function laterVersion(a: string, b: string): boolean {
  const [leftCore, leftPre] = withPreRelease(a)
  const [rightCore, rightPre] = withPreRelease(b)
  const left = leftCore.split('.').map(Number)
  const right = rightCore.split('.').map(Number)

  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)

    if (difference !== 0) {
      return difference > 0
    }
  }

  // The same numbers: a release comes after a pre-release of it, 1.0.0 after
  // 1.0.0-rc.1, as Semantic Versioning orders them. Two pre-releases of the
  // same numbers count as none later; a release never names one.
  return leftPre === null && rightPre !== null
}

/** A version as its numbers and what follows a hyphen, or null where nothing does. */
function withPreRelease(version: string): readonly [string, string | null] {
  const hyphen = version.indexOf('-')

  return hyphen < 0 ? [version, null] : [version.slice(0, hyphen), version.slice(hyphen + 1)]
}

/** One part of the notes of a release, as its changelog heads it. */
export interface InstanceReleaseNotesSection {
  readonly title: string
  /** The section `Sicherheit`, which the screen shows first and marks. */
  readonly security: boolean
  readonly items: readonly string[]
}

/** The last update that ran, or runs. */
export interface InstanceUpdateRun {
  readonly id: string
  readonly version: string
  /** The version before, as the service found it installed. */
  readonly from: string | null
  /** Who asked for it, by name or address. */
  readonly by: string
  readonly state: 'running' | 'succeeded' | 'failed'
  /**
   * Why it ended without a step to blame: `vanished` for a run whose
   * container went away without saying how it ended, `docker` for one that
   * could not even be started.
   */
  readonly reason: 'vanished' | 'docker' | null
  /** The step it is in, or ended in, as an index into `instanceUpdateSteps`. */
  readonly step: InstanceUpdateStep
  readonly startedAt: string
  readonly finishedAt: string | null
  /** The last lines of what the run said, for an update that failed. */
  readonly log: readonly string[]
}

/** The update of the instance as its screen reads it. */
export interface InstanceUpdateView {
  /** The version the application runs, or null for one built from the source. */
  readonly running: string | null
  /**
   * Whether the service for updates goes round: `alive`, `silent` when it
   * has not for a few minutes, `missing` when it never wrote anything.
   */
  readonly service: 'alive' | 'silent' | 'missing'
  /** When the service last asked GitHub, ISO 8601, or null. */
  readonly checkedAt: string | null
  readonly mode: InstanceUpdateMode | null
  readonly reason: InstanceUpdateReason | null
  /** The newest release, its day and its page, or null while none is known. */
  readonly latest: string | null
  readonly publishedAt: string | null
  readonly url: string | null
  /** Why the last question to GitHub went unanswered: no answer, or one without a version. */
  readonly error: 'unreachable' | 'invalid' | null
  /** Whether the newest release is newer than the version that runs. */
  readonly newer: boolean
  /** The notes of the newest release, `Sicherheit` first. */
  readonly notes: readonly InstanceReleaseNotesSection[]
  readonly run: InstanceUpdateRun | null
  /** A request the service has not taken yet. */
  readonly pending: { readonly id: string; readonly version: string; readonly at: string } | null
  /** The last request the service turned away, if it is the last one asked for. */
  readonly refusal: {
    readonly id: string
    readonly version: string
    readonly reason: InstanceUpdateRefusal
    readonly at: string
  } | null
}
