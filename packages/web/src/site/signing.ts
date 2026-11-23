import type { RecordState, SignedContent } from '@opengewerk/domain'
import { count } from '@opengewerk/platform-web/sync'
import { useState } from 'react'

import { lineKindOf, lineUnitOf } from '../app/labels.js'

/**
 * What the customer is shown and signs, read off the records as this device
 * holds them.
 *
 * The fallbacks are the server's own defaults and nothing else. The server
 * works the fingerprint out again from its rows, and a field the device never
 * sent is on the server with its default; reading it here as anything else
 * would make every signature on such a line a conflict. `kind` is the one of
 * these fields with a default in the table, and `lineKindOf` falls back to
 * that same `item`.
 *
 * The declaration for the zero rate (#1046) is the one the page shows above
 * the signature, none where it shows none.
 */
export function signedContentOf(
  report: RecordState,
  lines: readonly RecordState[],
  zeroRateDeclaration: string | null = null,
): SignedContent {
  const introText = report['introText']
  const fields = report['fieldValues']
  const fieldsVersion = report['fieldsVersion']

  const textOf = (field: string) => {
    const value = report[field]

    return typeof value === 'string' ? value : null
  }

  return {
    // What the head of the page names, as the server reads it of the document.
    subject: textOf('subject'),
    documentDate: textOf('documentDate'),
    customerId: textOf('customerId'),
    jobId: textOf('jobId'),
    introText: typeof introText === 'string' ? introText : null,
    // The fields of the business (#78), as the text the report carries, and
    // the version of their definition, which says what a value meant.
    fields: typeof fields === 'string' ? fields : null,
    fieldsVersion: typeof fieldsVersion === 'number' ? fieldsVersion : null,
    zeroRateDeclaration,
    lines: lines.map((line) => {
      const designation = line['designation']
      const description = line['description']

      return {
        id: String(line['id']),
        position: count(line, 'position'),
        kind: lineKindOf(line),
        designation: typeof designation === 'string' ? designation : '',
        description: typeof description === 'string' ? description : null,
        quantityMilli: count(line, 'quantityMilli'),
        unit: lineUnitOf(line),
      }
    }),
  }
}

/**
 * The signature on a pad, held to the page the customer read while drawing it
 * (#1063). The page is noted as the finger first touches the drawing area of
 * an empty pad, so `onPointerDown` belongs on an element around the pad, in
 * the capture phase: the pad itself tells of a stroke only once it ends.
 *
 * Should the page change while anything is drawn or being drawn, through the
 * sync or a new answer of the server, the drawing goes at once: `pad` is the
 * key that mounts the pad again, empty, and `pageChanged` says why it is
 * empty, until the customer draws again. A second finger, or the page changing
 * back, brings nothing back. A signature only ever goes out over the page the
 * customer saw from the first touch to the last stroke.
 */
export function useSignatureFor(fingerprint: string): {
  readonly path: string | null
  readonly pad: number
  readonly pageChanged: boolean
  readonly onChange: (path: string | null) => void
  readonly onPointerDown: (event: { readonly target: EventTarget | null }) => void
} {
  const [drawn, setDrawn] = useState<string | null>(null)
  // The page the pad was first touched under since it was last empty.
  const [under, setUnder] = useState<string | null>(null)
  const [pad, setPad] = useState(0)
  const [pageChanged, setPageChanged] = useState(false)

  // Put right while rendering, as React has it for state that follows a
  // value, and not in an effect.
  if (under !== null && under !== fingerprint) {
    setDrawn(null)
    setUnder(null)
    setPageChanged(true)
    setPad((count) => count + 1)
  }

  return {
    path: drawn,
    pad,
    pageChanged,
    onChange: (path) => {
      if (path === null) {
        setDrawn(null)
        setUnder(null)

        return
      }

      setDrawn(path)
      setUnder(fingerprint)
      setPageChanged(false)
    },
    onPointerDown: (event) => {
      // Only a touch of the drawing area itself, not of the hint or the button
      // beside it: those draw nothing.
      if (event.target instanceof Element && event.target.closest('svg') !== null) {
        setUnder(fingerprint)
      }
    },
  }
}
