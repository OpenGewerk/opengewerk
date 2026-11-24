import {
  type InstanceReleaseNotesSection,
  type InstanceUpdateReason,
  type InstanceUpdateRefusal,
  type InstanceUpdateRun,
  type InstanceUpdateStep,
  instanceUpdateSteps,
  type InstanceUpdateView,
  laterVersion,
} from '@opengewerk/platform-domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp,
  Check,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '../components/button.js'
import { Dialog } from '../components/dialog.js'
import { Panel } from '../components/panel.js'
import { Status } from '../components/status.js'
import { date, moment } from '../format.js'
import { NoteBox } from '../office/kit.js'
import { Reconfirmation } from '../office/passkeys.js'
import { SettingsText } from '../office/settings.js'
import { instanceUpdate, startInstanceUpdate } from '../session/instance.js'
import { RequestRefused } from '../sync/transport.js'
import { InstancePage } from './frame.js'

const sub = 'Welche Fassung auf dieser Instanz läuft, und ob es eine neuere gibt.'

const stepNames: Readonly<Record<InstanceUpdateStep, string>> = {
  backup: 'Sichern',
  download: 'Neue Fassung laden und prüfen',
  images: 'Abbilder holen und prüfen',
  migration: 'Datenbank migrieren',
  restart: 'Neu starten',
  check: 'Fassung prüfen',
}

const betrieb = 'docs/betrieb.md unter „Aktualisieren“'

/** Why the instance cannot be updated from here, and what to do instead. */
const reasonTexts: Readonly<Record<InstanceUpdateReason, string>> = {
  checkout:
    'Diese Instanz läuft aus einem Checkout des Quelltexts. Sie wird mit git pull und sh docker/start.sh aktualisiert, nicht hier; ein Paket aus einem Release passt nicht über einen Checkout.',
  unsigned: `Diese Installation stammt aus einem Paket, das seine Abbilder nicht mit Digest nennt. Sie wird einmal von Hand aktualisiert, wie in ${betrieb} beschrieben; danach geht es hier.`,
  directory:
    'Der Ordner der Installation ist nicht bekannt, etwa unter Docker Desktop auf Windows oder macOS, oder sein Pfad enthält ein Zeichen, das nicht durchgeht. Aktualisiert wird dort von Hand: das neue Paket an dieselbe Stelle entpacken, dann sh docker/start.sh.',
  elsewhere:
    'Der Ordner der Installation in der .env ist nicht der, aus dem die Instanz läuft. Ein Start mit sh docker/start.sh trägt den richtigen ein.',
  docker:
    'Der Dienst für Aktualisierungen kann Docker nicht nach sich selbst fragen. Warum, zeigt auf dem Server: docker compose -f docker/compose.yaml logs updater',
  application:
    'Der Dienst für Aktualisierungen kann die Namen der Installation in docker/application.env nicht lesen.',
}

/** Why the service turned the last request away. */
function refusalText(reason: InstanceUpdateRefusal): string {
  switch (reason) {
    case 'expired':
      return 'Die Anfrage wartete länger als zehn Minuten auf den Dienst für Aktualisierungen und wurde verworfen. Bitte noch einmal.'
    case 'version':
      return 'Der Dienst kennt inzwischen eine andere neueste Fassung. Bitte die Seite neu laden.'
    case 'current':
      return 'Diese Fassung ist schon installiert.'
    case 'running':
      return 'Es lief schon eine Aktualisierung.'
    default:
      return reasonTexts[reason]
  }
}

/** Where a run stopped, as the steps show it, and what that left behind. */
function stoppedIn(run: InstanceUpdateRun): { readonly what: string; readonly left: string } {
  const before = run.from ?? 'die Fassung davor'

  if (run.reason === 'vanished') {
    return {
      what: 'Der Lauf ist verschwunden, ohne zu sagen, wie er endete, etwa weil der Server neu gestartet wurde.',
      left: `Was dort läuft, zeigt auf dem Server: docker compose -f docker/compose.yaml ps`,
    }
  }

  if (run.reason === 'docker') {
    return {
      what: 'Der Lauf ließ sich nicht starten.',
      left: `Es wurde nichts geändert, ${before} läuft weiter.`,
    }
  }

  switch (run.step) {
    case 'backup':
      return {
        what: 'Die Sicherung ist fehlgeschlagen.',
        left: `Es wurde nichts geändert, ${before} läuft weiter. Ohne Sicherung aktualisiert die Instanz nicht.`,
      }
    case 'download':
      return {
        what: 'Das Paket ließ sich nicht laden, oder seine Signatur hält nicht.',
        left: `Es wurde nichts geändert, ${before} läuft weiter.`,
      }
    case 'images':
      return {
        what: 'Die Abbilder ließen sich nicht holen oder prüfen.',
        left: `Die Dateien der neuen Fassung liegen schon im Ordner, die Instanz läuft aber weiter auf ${before}. Ein neuer Versuch setzt dort wieder an.`,
      }
    case 'migration':
      return {
        what: 'Die Migration ist gescheitert.',
        left: `Die Datenbank steht auf dem Stand davor, ${before} läuft weiter.`,
      }
    case 'restart':
      return {
        what: 'Die Dienste der neuen Fassung sind nicht gestartet.',
        left: `Die Datenbank ist schon migriert. Was zu tun ist, steht in ${betrieb}; die Sicherung von vor dem Update ist der Weg zurück.`,
      }
    case 'check':
      return {
        what: 'Die Anwendung meldet nach dem Neustart nicht die neue Fassung.',
        left: 'Was dort läuft, zeigt auf dem Server: docker compose -f docker/compose.yaml ps',
      }
  }
}

function saidWhy(error: unknown, fallback: string): string {
  return error instanceof RequestRefused ? error.message : fallback
}

/**
 * The update of the instance (opengewerk#1093), the boards
 * "Instanz-Aktualisierung" of the canvas: which version runs and the newest,
 * what the newest brings, and the button, which asks for the password and the
 * code before it asks the service for updates. While an update runs, its
 * steps; after one that stopped, where and what that left, with the end of
 * its log.
 *
 * The page asks every few seconds while an update runs and loads itself anew
 * once the instance answers with another version, so that what is on screen
 * is the new version's.
 */
export function InstanceUpdateScreen() {
  const queries = useQueryClient()
  const update = useQuery({
    queryKey: ['instance-update'],
    queryFn: instanceUpdate,
    refetchInterval: (query) => {
      const data = query.state.data

      return data?.run?.state === 'running' || data?.pending ? 3000 : 60_000
    },
  })
  // The version the dialog asks about, fixed when it opened, and the try it
  // belongs to: a confirmation that comes back after the dialog was closed,
  // or for a dialog opened anew since, sends nothing.
  const [confirming, setConfirming] = useState<{
    readonly version: string
    readonly attempt: number
  } | null>(null)
  const attempt = useRef(0)
  const [trouble, setTrouble] = useState<string | null>(null)
  const loadedWith = useRef<string | null | undefined>(undefined)
  const running = update.data?.running

  const start = useMutation({
    mutationFn: startInstanceUpdate,
    onSuccess: async (view) => {
      // A question still under way read the state from before the request
      // and would put the button back.
      await queries.cancelQueries({ queryKey: ['instance-update'] })
      queries.setQueryData(['instance-update'], view)
    },
    onError: (error) => {
      setTrouble(saidWhy(error, 'Die Anfrage kam nicht an. Bitte gleich noch einmal.'))
    },
  })

  // Loaded anew once another version answers: the script on screen is the
  // one of the version before.
  useEffect(() => {
    if (running === undefined) {
      return
    }

    if (loadedWith.current === undefined) {
      loadedWith.current = running
    } else if (running !== null && running !== loadedWith.current) {
      globalThis.location.reload()
    }
  }, [running])

  if (update.data === undefined) {
    return (
      <InstancePage title="Aktualisierung" sub={sub}>
        <SettingsText muted>
          {update.isError
            ? saidWhy(update.error, 'Der Stand der Aktualisierung kam nicht an.')
            : 'Wird geladen.'}
        </SettingsText>
      </InstancePage>
    )
  }

  const view = update.data
  // The notes only beside the button, as the boards draw it: while an update
  // runs, and after one that stopped, the card of the run takes their place.
  const underWay = view.pending !== null || view.run?.state === 'running'
  const stopped = stoppedShort(view) !== null

  return (
    <InstancePage title="Aktualisierung" sub={sub}>
      <Versions view={view} />
      {view.newer && view.notes.length > 0 && view.latest && !underWay && !stopped ? (
        <Notes version={view.latest} notes={view.notes} url={view.url} />
      ) : null}
      <Panel title="Aktualisieren" roomy>
        <div className="flex flex-col gap-2.5">
          {trouble ? (
            <p role="alert" className="text-[13px] font-semibold text-conflict">
              {trouble}
            </p>
          ) : null}
          <Action
            view={view}
            busy={start.isPending || confirming !== null}
            onUpdate={() => {
              if (!view.latest) {
                return
              }

              attempt.current += 1
              setTrouble(null)
              setConfirming({ version: view.latest, attempt: attempt.current })
            }}
          />
        </div>
      </Panel>

      {confirming ? (
        <Dialog
          title={`Auf ${confirming.version} aktualisieren?`}
          width={520}
          onClose={() => {
            attempt.current += 1
            setConfirming(null)
          }}
        >
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[14px] leading-[1.5]">
              Die Instanz sichert zuerst die Datenbank und den Dateispeicher. Dann lädt sie{' '}
              {confirming.version}, prüft die Signatur, holt die neuen Abbilder, migriert die
              Datenbank und startet neu. Für etwa eine Minute ist sie nicht erreichbar.
            </p>
            <Reconfirmation
              narrow={false}
              confirm="Aktualisieren"
              onConfirmed={() => {
                if (attempt.current !== confirming.attempt) {
                  return
                }

                attempt.current += 1
                setConfirming(null)
                start.mutate(confirming.version)
              }}
              onCancel={() => {
                attempt.current += 1
                setConfirming(null)
              }}
            />
          </div>
        </Dialog>
      ) : null}
    </InstancePage>
  )
}

function Line({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[14px]">
      <span className="w-[150px] shrink-0 text-ink-muted max-sm:w-full">{name}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  )
}

/** The card of the versions: the one that runs, the newest, and when the service last looked. */
function Versions({ view }: { readonly view: InstanceUpdateView }) {
  return (
    <Panel title="Fassung" roomy>
      <div className="flex flex-col gap-2">
        <Line name="Läuft">
          {view.running ? <strong>{view.running}</strong> : 'aus dem Quelltext, ohne Fassung'}
        </Line>
        <Line name="Neueste">
          {view.latest ? (
            <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span>
                <strong>{view.latest}</strong>
                {view.publishedAt ? ` vom ${date(view.publishedAt)}` : ''}
              </span>
              {view.newer ? (
                <Status tone="waiting" icon={ArrowUp}>
                  Neuere Fassung
                </Status>
              ) : view.running ? (
                <Status tone="done" icon={Check}>
                  Aktuell
                </Status>
              ) : null}
            </span>
          ) : (
            'noch nicht bekannt'
          )}
        </Line>
        <Line name="Zuletzt nachgesehen">
          {view.checkedAt ? moment(view.checkedAt) : 'noch nie'}
        </Line>
        <SettingsText muted>
          Die Instanz sieht einmal am Tag nach, ob es eine neuere Fassung gibt. Aktualisiert wird
          nur auf Knopfdruck.
        </SettingsText>
        {view.error ? (
          <SettingsText muted>
            {view.error === 'unreachable'
              ? 'Beim letzten Nachsehen war GitHub nicht erreichbar. Der nächste Versuch kommt in einer Stunde.'
              : 'Beim letzten Nachsehen nannte GitHub keine Fassung. Der nächste Versuch kommt in einer Stunde.'}
          </SettingsText>
        ) : null}
      </div>
    </Panel>
  )
}

/** The notes of the newer version, its part of the changelog, `Sicherheit` on top. */
function Notes({
  version,
  notes,
  url,
}: {
  readonly version: string
  readonly notes: readonly InstanceReleaseNotesSection[]
  readonly url: string | null
}) {
  return (
    <Panel title={`Was ${version} bringt`} roomy>
      <div className="flex flex-col gap-3">
        {notes.map((section) => (
          <div key={section.title} className="flex flex-col gap-1">
            <h3
              className={`m-0 flex items-center gap-1.5 text-[14px] font-semibold ${section.security ? 'text-conflict' : 'text-ink'}`}
            >
              {section.security ? (
                <ShieldAlert size={15} strokeWidth={2.1} aria-hidden="true" />
              ) : null}
              {section.title}
            </h3>
            <ul className="m-0 pl-5 text-[13px] leading-[1.5]">
              {section.items.map((item, index) => (
                <li key={index} className="mb-1">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px]"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Alle Hinweise zu {version} auf der Release-Seite
          </a>
        ) : null}
      </div>
    </Panel>
  )
}

type StepState = 'done' | 'running' | 'failed' | 'waiting'

/** The steps of a run, each with its state and a word on it. */
function Steps({
  run,
  waiting = false,
}: {
  readonly run: InstanceUpdateRun | null
  readonly waiting?: boolean
}) {
  const at = run ? instanceUpdateSteps.indexOf(run.step) : -1
  const failure = run?.state === 'failed' ? stoppedIn(run) : null

  return (
    <ol aria-label="Schritte" className="m-0 list-none p-0">
      {instanceUpdateSteps.map((step, index) => {
        let state: StepState = 'waiting'
        let note = ''

        if (run && !waiting) {
          if (index < at || run.state === 'succeeded') {
            state = 'done'
            note = 'Fertig.'
          } else if (index === at) {
            state = run.state === 'failed' ? 'failed' : 'running'
            note = failure ? failure.what : 'Läuft.'
          } else if (run.state === 'failed' && index === at + 1) {
            note = 'Nicht begonnen.'
          }
        }

        const tone =
          state === 'done'
            ? 'text-done'
            : state === 'failed'
              ? 'text-conflict'
              : state === 'running'
                ? 'text-copper-text'
                : 'text-ink-faint'

        return (
          <li
            key={step}
            className="flex items-start gap-2.5 border-b border-line py-2 last:border-b-0"
          >
            <span className={`flex w-[18px] shrink-0 justify-center pt-px ${tone}`}>
              {state === 'done' ? (
                <Check size={15} strokeWidth={2.4} aria-hidden="true" />
              ) : state === 'running' ? (
                <RefreshCw size={15} strokeWidth={2.2} aria-hidden="true" />
              ) : state === 'failed' ? (
                <X size={15} strokeWidth={2.4} aria-hidden="true" />
              ) : (
                <span className="text-[13px]">{index + 1}</span>
              )}
            </span>
            <span className="flex grow flex-col gap-0.5">
              <span
                className={`text-[14px] ${state === 'running' || state === 'failed' ? 'font-semibold' : ''} ${state === 'waiting' ? 'text-ink-muted' : 'text-ink'}`}
              >
                {stepNames[step]}
              </span>
              {note ? (
                <span
                  className={`text-[13px] ${state === 'failed' ? 'text-conflict' : 'text-ink-muted'}`}
                >
                  {note}
                </span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The run that stopped short of a version that is still ahead of what runs:
 * shown until the instance runs that version or a later one, also when a
 * newer one came out meanwhile, since a stop after the migration left the
 * database on the new state.
 */
function stoppedShort(view: InstanceUpdateView): InstanceUpdateRun | null {
  const { run, running } = view

  return run?.state === 'failed' && (running === null || laterVersion(run.version, running))
    ? run
    : null
}

/** Who started a run and when, as one sentence. */
function startedBy(run: InstanceUpdateRun): string {
  return `Gestartet ${moment(run.startedAt)}${run.by ? ` von ${run.by}` : ''}.`
}

/** The card with the button, the run under way, the run that stopped, or why there is no button. */
function Action({
  view,
  busy,
  onUpdate,
}: {
  readonly view: InstanceUpdateView
  readonly busy: boolean
  readonly onUpdate: () => void
}) {
  const { run, pending, refusal } = view

  if (pending || run?.state === 'running') {
    const version = run?.state === 'running' ? run.version : (pending?.version ?? '')

    return (
      <>
        <div role="status" className="flex items-center gap-2 text-[14px] text-ink">
          <RefreshCw size={16} strokeWidth={2.2} aria-hidden="true" />
          <strong>Die Instanz wird auf {version} aktualisiert.</strong>
        </div>
        <SettingsText muted>
          {run?.state === 'running'
            ? startedBy(run)
            : 'Die Anfrage wartet darauf, dass der Dienst für Aktualisierungen sie aufnimmt.'}
        </SettingsText>
        <Steps run={run?.state === 'running' ? run : null} waiting={run?.state !== 'running'} />
        <NoteBox>
          Die Seite kann offen bleiben. Während des Neustarts ist die Anwendung kurz nicht
          erreichbar; danach lädt diese Seite die neue Fassung von selbst.
        </NoteBox>
      </>
    )
  }

  if (view.service !== 'alive') {
    return (
      <NoteBox tone="waiting" icon={TriangleAlert}>
        {view.service === 'missing'
          ? 'Der Dienst für Aktualisierungen hat sich noch nie gemeldet.'
          : 'Der Dienst für Aktualisierungen meldet sich seit einigen Minuten nicht mehr.'}{' '}
        Ohne ihn sieht die Instanz nicht nach neuen Fassungen und lässt sich nicht von hier
        aktualisieren. Wie er läuft, steht in {betrieb}.
      </NoteBox>
    )
  }

  const stopped = stoppedShort(view)
  const failed = stopped ? stoppedIn(stopped) : null
  const asked =
    refusal !== null ? (
      <p role="alert" className="m-0 text-[13px] font-semibold text-conflict">
        Die Anfrage wurde abgelehnt. {refusalText(refusal.reason)}
      </p>
    ) : null

  if (failed && stopped) {
    const again =
      view.mode === 'ready' && view.newer && view.latest
        ? stopped.version === view.latest
          ? 'Erneut versuchen'
          : `Auf ${view.latest} aktualisieren`
        : null

    return (
      <>
        <div role="alert" className="flex items-center gap-2 text-[14px] text-conflict">
          <TriangleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
          <strong>Die Aktualisierung auf {stopped.version} ist abgebrochen.</strong>
        </div>
        <SettingsText muted>
          {startedBy(stopped)} {failed.left}
        </SettingsText>
        <Steps run={stopped} />
        {stopped.log.length > 0 ? (
          <>
            <span className="text-[12px] font-semibold tracking-[0.04em] text-ink-muted uppercase">
              Auszug aus dem Protokoll des Laufs
            </span>
            <pre className="m-0 overflow-x-auto rounded-[4px] border border-line bg-surface-sunken px-3 py-2.5 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap text-ink">
              {stopped.log.slice(-12).join('\n')}
            </pre>
          </>
        ) : null}
        <SettingsText muted>
          Wer die Instanz verwaltet, bekommt dazu eine E-Mail über den Mailserver der Instanz.
        </SettingsText>
        {asked}
        {again ? (
          <div className="flex flex-wrap gap-2">
            <div className="grow" />
            <Button tone="primary" icon={RefreshCw} disabled={busy} onClick={onUpdate}>
              {again}
            </Button>
          </div>
        ) : null}
      </>
    )
  }

  if (view.mode !== 'ready') {
    return (
      <>
        {asked}
        <NoteBox>
          {view.reason
            ? reasonTexts[view.reason]
            : 'Der Dienst für Aktualisierungen hat diese Instanz noch nicht angesehen.'}
        </NoteBox>
      </>
    )
  }

  if (!view.newer || !view.latest) {
    return (
      <>
        {asked}
        <SettingsText muted>
          {view.latest
            ? 'Diese Instanz ist auf dem neuesten Stand.'
            : 'Eine neuere Fassung ist nicht bekannt.'}
          {run?.state === 'succeeded'
            ? ` Zuletzt aktualisiert ${moment(run.finishedAt)} auf ${run.version}${run.by ? `, angestoßen von ${run.by}` : ''}.`
            : ''}
        </SettingsText>
      </>
    )
  }

  return (
    <>
      {asked}
      <SettingsText muted>
        Vorher sichert die Instanz die Datenbank und den Dateispeicher. Schlägt die Sicherung fehl,
        bleibt alles, wie es ist. Während des Neustarts ist die Anwendung etwa eine Minute nicht
        erreichbar; Geräte arbeiten in der Zeit weiter und gleichen danach ab.
      </SettingsText>
      <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <span className="text-[12px] text-ink-muted">
          Mit erneuter Bestätigung durch Passwort und Code.
        </span>
        <div className="grow" />
        <Button tone="primary" icon={RefreshCw} disabled={busy} onClick={onUpdate}>
          Auf {view.latest} aktualisieren
        </Button>
      </div>
    </>
  )
}
