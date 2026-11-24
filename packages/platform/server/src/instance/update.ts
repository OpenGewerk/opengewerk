import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type InstanceReleaseNotesSection,
  type InstanceUpdateMode,
  type InstanceUpdateReason,
  type InstanceUpdateRefusal,
  type InstanceUpdateRun,
  instanceUpdateSteps,
  type InstanceUpdateView,
  laterVersion,
} from '@opengewerk/platform-domain'

/**
 * The update of the instance from its area (opengewerk#1093), on the side
 * of the application.
 *
 * A service of its own beside the application does the work: it looks once
 * a day for the newest release and updates when asked. The application talks
 * to it through two folders and nothing else. Into the first it writes the
 * request of somebody who runs the instance, and only it may write there; in
 * the second it reads what the service found and how the last update went,
 * and only the service writes there. Everything read from there is held to
 * its shape here before the screen sees it, the notes of a release among
 * them, which come from GitHub.
 */

/** Where the two folders are, as the Compose file of the application mounts them. */
export interface InstanceUpdates {
  /** Where the application writes its request, and the mark that a finished update was told. */
  readonly requestsPath: string
  /** Where the service writes what it found and how the last update went. */
  readonly statusPath: string
}

/** The token the area of the instance is handed the folders by. */
export const INSTANCE_UPDATES = Symbol('InstanceUpdates')

/** How long the service may be silent before the screen says it does not run: it writes every minute. */
const silentAfterMs = 5 * 60_000

/** How long a request waits for the service before it counts as not taken; the service turns older ones away. */
export const requestLifetimeMs = 10 * 60_000

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const versionPattern = /^\d+\.\d+\.\d+$/
/**
 * The version the application runs, as the configuration takes it: with a
 * pre-release, which the service never updates to but which may run.
 */
const runningPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const modes: readonly InstanceUpdateMode[] = ['ready', 'checkout', 'unsupported']
const reasons: readonly InstanceUpdateReason[] = [
  'checkout',
  'unsigned',
  'directory',
  'elsewhere',
  'docker',
  'application',
]
const refusals: readonly InstanceUpdateRefusal[] = [
  'expired',
  'version',
  'current',
  'running',
  ...reasons,
]

type Json = Record<string, unknown>

/** A file of one of the folders as JSON, or null when it is not there or not JSON. */
async function readJson(path: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : null
  } catch {
    return null
  }
}

function text(value: unknown, longest = 200): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, longest) : null
}

function version(value: unknown): string | null {
  return typeof value === 'string' && versionPattern.test(value) ? value : null
}

function moment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const at = new Date(value)

  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/**
 * A line of Markdown with its links as their words, an image as its
 * description.
 *
 * Read by hand, once from left to right, and not with a pattern: the notes
 * come from a page on GitHub, and a pattern of brackets and parentheses took
 * time that grew with the square of a line made of nothing but `[`
 * (CodeQL, js/polynomial-redos).
 */
function linkWords(line: string): string {
  let words = ''
  let at = 0

  for (;;) {
    const open = line.indexOf('[', at)
    const close = open < 0 ? -1 : line.indexOf(']', open + 1)

    if (close < 0) {
      break
    }

    if (line[close + 1] !== '(') {
      // No bracket between the two opens a link either: the first `]` after
      // each of them is this one.
      words += line.slice(at, close + 1)
      at = close + 1
      continue
    }

    const end = line.indexOf(')', close + 2)

    if (end < 0) {
      break
    }

    const start = open - 1 >= at && line[open - 1] === '!' ? open - 1 : open

    words += line.slice(at, start) + line.slice(open + 1, close)
    at = end + 1
  }

  return words + line.slice(at)
}

/** A line of Markdown as text: links as their words, without marks for bold, code or emphasis. */
function plain(line: string): string {
  return linkWords(line)
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether a character is white space, as `\s` takes it. */
function blank(character: string | undefined): boolean {
  return character !== undefined && character.trim() === ''
}

/**
 * The notes of a release, from its page on GitHub: the parts of its changelog
 * under their headings, `Sicherheit` first. What stands before the first
 * heading, a hint, and from the first heading of the second level on, how to
 * install, is left out. At most twelve parts of fifty points each.
 */
export function releaseNotes(markdown: string): InstanceReleaseNotesSection[] {
  // Each point as its lines, read once it is complete: read again with each
  // line that goes on with it, a point of many lines took time that grew
  // with the square of them.
  const sections: { title: string; points: string[][] }[] = []
  let current: { title: string; points: string[][] } | null = null

  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()

    if (/^##\s/.test(line)) {
      break
    }

    // By hand rather than with a pattern, for the same reason as `linkWords`.
    if (line.startsWith('###') && blank(line[3])) {
      current = { title: plain(line.slice(3)), points: [] }
      sections.push(current)
      continue
    }

    if (!current) {
      continue
    }

    const point = line.trimStart()

    if (point.length > 1 && '-*+'.includes(point[0] ?? '') && blank(point[1])) {
      current.points.push([point.slice(1)])
    } else if (line.trim() !== '') {
      // A line that goes on with the point above it.
      current.points.at(-1)?.push(line)
    }
  }

  const kept = sections
    .filter((section) => section.title !== '' && section.points.length > 0)
    .map((section) => ({
      title: section.title.slice(0, 80),
      security: section.title.toLowerCase() === 'sicherheit',
      items: section.points.slice(0, 50).map((lines) => plain(lines.join(' ')).slice(0, 1000)),
    }))

  // Sicherheit first and then cut, so that it is never the part cut off.
  return [...kept.filter((section) => section.security), ...kept.filter((s) => !s.security)].slice(
    0,
    12,
  )
}

function runOf(json: Json | null): InstanceUpdateRun | null {
  if (!json) {
    return null
  }

  const id = typeof json['id'] === 'string' && uuid.test(json['id']) ? json['id'] : null
  const target = version(json['version'])
  const state = oneOf(json['state'], ['running', 'succeeded', 'failed'] as const)
  const startedAt = moment(json['started_at'])
  const step = typeof json['step'] === 'number' ? instanceUpdateSteps[json['step']] : undefined

  if (!id || !target || !state || !startedAt || !step) {
    return null
  }

  const log = Array.isArray(json['log'])
    ? json['log']
        .filter((line): line is string => typeof line === 'string')
        .slice(-60)
        .map((line) => line.slice(0, 500))
    : []

  return {
    id,
    version: target,
    from: version(json['from']),
    by: text(json['by']) ?? '',
    state,
    reason: oneOf(json['reason'], ['vanished', 'docker'] as const),
    step,
    startedAt,
    finishedAt: moment(json['finished_at']),
    log,
  }
}

/** The request written last, as the application wrote it. */
interface Request {
  readonly id: string
  readonly version: string
  readonly at: string
}

async function lastRequest(updates: InstanceUpdates): Promise<Request | null> {
  const json = await readJson(join(updates.requestsPath, 'request.json'))
  const id = json && typeof json['id'] === 'string' && uuid.test(json['id']) ? json['id'] : null
  const target = json ? version(json['version']) : null
  const at = json ? moment(json['at']) : null

  return id && target && at ? { id, version: target, at } : null
}

/** What the service last wrote, held to its shape, with the version that runs. */
export async function readInstanceUpdate(
  updates: InstanceUpdates,
  running: string | null,
  now: Date = new Date(),
): Promise<InstanceUpdateView> {
  const [available, runJson, refusalJson, request, alive] = await Promise.all([
    readJson(join(updates.statusPath, 'available.json')),
    readJson(join(updates.statusPath, 'run.json')),
    readJson(join(updates.statusPath, 'refusal.json')),
    lastRequest(updates),
    readFile(join(updates.statusPath, 'alive'), 'utf8').then(
      (written) => moment(written.trim()),
      () => null,
    ),
  ])

  const run = runOf(runJson)
  const latest = available ? version(available['latest']) : null
  const runningVersion = running !== null && runningPattern.test(running) ? running : null
  const url = available ? text(available['url'], 500) : null
  const refusal =
    refusalJson && request && refusalJson['id'] === request.id
      ? {
          id: request.id,
          version: version(refusalJson['version']) ?? request.version,
          reason: oneOf(refusalJson['reason'], refusals) ?? 'version',
          at: moment(refusalJson['at']) ?? request.at,
        }
      : null
  const pending =
    request &&
    run?.id !== request.id &&
    refusal === null &&
    now.getTime() - new Date(request.at).getTime() < requestLifetimeMs
      ? request
      : null

  return {
    running: runningVersion,
    service:
      alive === null
        ? 'missing'
        : now.getTime() - new Date(alive).getTime() < silentAfterMs
          ? 'alive'
          : 'silent',
    checkedAt: available ? moment(available['checked_at']) : null,
    mode: available ? oneOf(available['mode'], modes) : null,
    reason: available ? oneOf(available['reason'], reasons) : null,
    latest,
    publishedAt: available ? moment(available['published_at']) : null,
    url: url?.startsWith('https://github.com/') ? url : null,
    error: available ? oneOf(available['error'], ['unreachable', 'invalid'] as const) : null,
    newer: latest !== null && runningVersion !== null && laterVersion(latest, runningVersion),
    notes:
      available && typeof available['notes'] === 'string'
        ? releaseNotes(available['notes'].slice(0, 60_000))
        : [],
    run,
    pending,
    refusal,
  }
}

/**
 * Why an update cannot be asked for now, as the sentence the screen shows,
 * or null when it can. The service checks all of it again, and more; this is
 * so that nobody confirms with password and code for a request that would be
 * turned away.
 */
export function updateRefusedNow(view: InstanceUpdateView, wanted: string): string | null {
  if (view.service !== 'alive') {
    return 'Der Dienst für Aktualisierungen läuft nicht. Wie er gestartet wird, steht in docs/betrieb.md unter "Aktualisieren".'
  }

  if (view.mode !== 'ready') {
    return 'Diese Instanz lässt sich nicht aus ihrem Bereich aktualisieren. Warum, steht auf der Seite.'
  }

  if (view.run?.state === 'running' || view.pending !== null) {
    return 'Eine Aktualisierung läuft schon.'
  }

  if (view.latest === null || wanted !== view.latest) {
    return 'Aktualisiert wird nur auf die neueste Fassung, und das ist eine andere. Bitte die Seite neu laden.'
  }

  if (!view.newer) {
    return 'Diese Fassung läuft schon.'
  }

  return null
}

/**
 * How long after an update ended a new one waits for the mail about it: the
 * reports look every minute, the first time 20 seconds after a start.
 */
const tellingMs = 2 * 60_000

/**
 * Why a new update waits for the mail about the last one, as the sentence the
 * screen shows, or null when it does not. A new run takes the place of the
 * last in run.json, and an update that ended a moment ago would then be told
 * of by nobody. Only for two minutes: without a mail server nothing is ever
 * told, and nothing should wait for it.
 */
export async function stillTelling(
  updates: InstanceUpdates,
  view: InstanceUpdateView,
  now: Date = new Date(),
): Promise<string | null> {
  const run = view.run

  if (
    run === null ||
    run.state === 'running' ||
    run.finishedAt === null ||
    now.getTime() - new Date(run.finishedAt).getTime() >= tellingMs
  ) {
    return null
  }

  return (await updateTold(updates, run.id)).done
    ? null
    : 'Die Nachricht über die letzte Aktualisierung geht gerade noch hinaus. Bitte in zwei Minuten noch einmal.'
}

/**
 * Writes the request for an update to `wanted`, whole or not at all: first
 * under a name of its own, then under the one the service reads.
 */
export async function requestInstanceUpdate(
  updates: InstanceUpdates,
  wanted: string,
  by: string,
  now: Date = new Date(),
): Promise<string> {
  const id = randomUUID()
  const draft = join(updates.requestsPath, `.request-${id}.json`)
  const body = JSON.stringify({ id, version: wanted, by: by.slice(0, 200), at: now.toISOString() })

  await placed(draft, join(updates.requestsPath, 'request.json'), body, 0o644)

  return id
}

/**
 * Writes `body` under `draft` and gives it the name `path`. A draft that could
 * not take its place is taken away again (CodeRabbit on #1101): on a disk that
 * ran full, a mark tried every minute would leave one each time.
 */
async function placed(draft: string, path: string, body: string, mode?: number): Promise<void> {
  try {
    await writeFile(draft, body, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode === undefined ? {} : { mode }),
    })
    await rename(draft, path)
  } catch (error) {
    await rm(draft, { force: true }).catch(() => undefined)

    throw error
  }
}

/**
 * Whether the folder holds a last run that cannot be read: a file that is
 * there and no run of its form (CodeRabbit on #1101). How it ended would then
 * stay out of the logs, and a new request would take its place unwritten.
 */
export async function lastRunUnreadable(updates: InstanceUpdates): Promise<boolean> {
  const path = join(updates.statusPath, 'run.json')

  try {
    await stat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }

  return runOf(await readJson(path)) === null
}

/**
 * Who was told of the end of an update: the addresses, lower case, and
 * whether everybody was, or given up on for good.
 */
export interface UpdateTold {
  readonly done: boolean
  readonly to: readonly string[]
}

/** Who was told of the end of the update with this ID. */
export async function updateTold(updates: InstanceUpdates, id: string): Promise<UpdateTold> {
  if (!uuid.test(id)) {
    return { done: true, to: [] }
  }

  const json = await readJson(join(updates.requestsPath, `told-${id}`))

  return {
    done: json?.['done'] === true,
    to: Array.isArray(json?.['to'])
      ? (json['to'] as unknown[]).filter(
          (address): address is string => typeof address === 'string',
        )
      : [],
  }
}

/** Keeps who was told of the end of this update, whole or not at all. The records of earlier updates go. */
export async function markUpdateTold(
  updates: InstanceUpdates,
  id: string,
  told: UpdateTold,
): Promise<void> {
  if (!uuid.test(id)) {
    return
  }

  const draft = join(updates.requestsPath, `.told-${id}-${randomUUID()}`)

  await placed(draft, join(updates.requestsPath, `told-${id}`), JSON.stringify(told))

  for (const name of await readdir(updates.requestsPath)) {
    if (name.startsWith('told-') && name !== `told-${id}`) {
      await rm(join(updates.requestsPath, name), { force: true })
    }
  }
}
