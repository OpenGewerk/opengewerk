import {
  type IsoDate,
  type RecordState,
  type RecurringChange,
  type TaxTreatment,
  taxTreatmentLabel,
} from '@opengewerk/domain'
import { Button } from '@opengewerk/platform-web'
import { date, euros, percent } from '@opengewerk/platform-web/format'
import { NoteBox } from '@opengewerk/platform-web/office'
import { maybeText, useSync, useSyncStatus } from '@opengewerk/platform-web/sync'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, RotateCcw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { documentStatusOf } from '../../app/labels.js'
import { useMay } from '../../app/queries.js'
import { recurringCheck, refreshRecurring, renewRecurring } from '../../session/documents.js'
import { StepPanel, StepText } from './document-frame.js'
import { reasonOf } from './document-steps.js'

function treatment(value: string): string {
  return taxTreatmentLabel[value as TaxTreatment] ?? value
}

function rateDayText(day: IsoDate | null): string {
  return day === null ? 'vom Ende des Zeitraums' : `vom Tag der Wartung am ${date(day)}`
}

/** One sentence per value that differs, in the words of the board "Dauerrechnung im Entwurf". */
function draftSentence(changes: readonly RecurringChange[]): string {
  const fromContract = changes.some(
    (change) => change.field === 'flatCents' || change.field === 'supplyOn',
  )
  const fromTreatment = changes.some((change) => change.field === 'taxTreatment')
  const subject =
    fromContract && fromTreatment
      ? 'haben sich der Vertrag und der Steuerfall geändert'
      : fromContract
        ? 'hat sich der Vertrag geändert'
        : 'hat sich der Steuerfall geändert'
  const parts = changes.flatMap((change): string[] => {
    switch (change.field) {
      case 'flatCents':
        return change.now === null
          ? []
          : [`Pauschale: ${euros(change.now)} statt ${euros(change.was ?? 0)}.`]
      case 'supplyOn':
        return [`Steuersatz: ${rateDayText(change.now)} statt ${rateDayText(change.was)}.`]
      case 'taxTreatment':
        return [`Steuerfall: ${treatment(change.now)} statt ${treatment(change.was)}.`]
      default:
        return []
    }
  })

  return [`Seit dieser Entwurf angelegt wurde, ${subject}.`, ...parts].join(' ')
}

/** The sentence of the board "Dauerrechnung festgeschrieben, ihr Steuersatz hat sich geändert". */
function issuedSentence(changes: readonly RecurringChange[]): string {
  const rates = changes.flatMap((change) => (change.field === 'rate' ? [change] : []))
  const first = rates[0]

  if (first === undefined) {
    return ''
  }

  const stated = rates.map((change) => percent(change.was)).join(' und ')
  const now = rates.map((change) => percent(change.now)).join(' und ')

  return (
    `Diese Rechnung weist ${stated} Umsatzsteuer aus. Für ihren Tag der Leistung, den ` +
    `${date(first.supplyOn)}, gelten nach dieser Fassung ${now}. Bis sie berichtigt ist, ` +
    'stimmt die ausgewiesene Steuer nicht.'
  )
}

/**
 * What has changed for a recurring invoice since it was made (#1037,
 * Feature-Gliederung 3.5), above its frame: in a draft the values it took
 * from its contract and customer, with the button that takes over today's;
 * at an issued invoice a rate the running version knows otherwise for its
 * day of supply, with the step that cancels it and lays its period out
 * again. Asked of the server, which knows the contract; without a
 * connection there is nothing to say.
 */
export function RecurringNotice({ document }: { readonly document: RecordState }) {
  const documentId = String(document['id'])
  const status = documentStatusOf(document)
  const { online } = useSyncStatus()
  const client = useSync()
  const queries = useQueryClient()
  const navigate = useNavigate()
  const writes = useMay('document.write')
  const issues = useMay('document.issue')
  const [working, setWorking] = useState(false)
  const [renewing, setRenewing] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const asked = status === 'draft' || status === 'issued'
  const check = useQuery({
    queryKey: ['recurring-check', documentId, document['version']],
    queryFn: () => recurringCheck(documentId),
    enabled: online && asked,
  })
  const changes = check.data?.changes ?? []

  if (!asked || changes.length === 0) {
    return null
  }

  async function takeOver() {
    setWorking(true)
    setTrouble(null)

    try {
      await refreshRecurring(documentId)
      await client.synchronise()
      await queries.invalidateQueries({ queryKey: ['recurring-check', documentId] })
    } catch (error) {
      setTrouble(
        reasonOf(error, 'Keine Verbindung. Neue Werte übernimmt der Entwurf mit Verbindung.'),
      )
    } finally {
      setWorking(false)
    }
  }

  async function renew() {
    setWorking(true)
    setTrouble(null)

    try {
      const { renewed } = await renewRecurring(documentId)

      await client.synchronise()
      await navigate({ to: `/belege/${String(renewed['id'])}` })
    } catch (error) {
      setTrouble(
        reasonOf(
          error,
          'Keine Verbindung. Storniert wird mit Verbindung, weil der Server dabei die nächste ' +
            'Rechnungsnummer vergibt.',
        ),
      )
    } finally {
      setWorking(false)
    }
  }

  const alert = trouble ? (
    <p role="alert" className="text-body font-semibold text-conflict">
      {trouble}
    </p>
  ) : null

  if (status === 'draft') {
    return (
      <div className="flex flex-col gap-2">
        <div role="status">
          <NoteBox
            tone="waiting"
            action={
              writes ? (
                <Button
                  tone="primary"
                  icon={Check}
                  disabled={working}
                  onClick={() => void takeOver()}
                >
                  {working ? 'Wird übernommen' : 'Neue Werte übernehmen'}
                </Button>
              ) : null
            }
          >
            {draftSentence(changes)}
          </NoteBox>
        </div>
        {alert}
      </div>
    )
  }

  const sentence = issuedSentence(changes)

  if (sentence === '') {
    return null
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="status">
        <NoteBox
          tone="conflict"
          icon={TriangleAlert}
          action={
            // Laid out again only out of its contract; one made by hand is
            // cancelled at the top of the page like any invoice.
            issues && !renewing && maybeText(document, 'maintenanceContractId') !== null ? (
              <Button
                tone="danger"
                onClick={() => {
                  setRenewing(true)
                }}
              >
                Stornieren und neu anlegen
              </Button>
            ) : null
          }
        >
          {sentence}
        </NoteBox>
      </div>
      {renewing ? (
        <StepPanel
          title="Stornieren und neu anlegen"
          icon={RotateCcw}
          tone="danger"
          actions={
            <>
              <Button tone="danger" disabled={working} onClick={() => void renew()}>
                {working ? 'Wird storniert' : 'Jetzt stornieren und neu anlegen'}
              </Button>
              <Button
                disabled={working}
                onClick={() => {
                  setRenewing(false)
                }}
              >
                Abbrechen
              </Button>
            </>
          }
          after={alert}
        >
          <StepText>
            Stornieren schreibt eine Stornorechnung mit der nächsten Rechnungsnummer, die jeden
            Betrag dieser Rechnung mit umgekehrtem Vorzeichen wiederholt. Danach entsteht die
            Dauerrechnung für denselben Zeitraum neu als Entwurf, mit denselben Positionen und den
            Werten von heute. Prüfe sie und schreibe sie fest; der Kunde bekommt sie wie jede
            Rechnung.
          </StepText>
        </StepPanel>
      ) : (
        alert
      )}
    </div>
  )
}
