import type { RecordState } from '@opengewerk/domain'
import { signedContentFingerprint } from '@opengewerk/domain'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { signedContentOf, useSignatureFor } from './signing.js'

/**
 * What the device signs, worked out from the records it holds.
 *
 * The one promise that matters is the first one: whatever the device signs,
 * the server works out to the same fingerprint. Broken, and every signature
 * given on site ends as a refusal nobody there can explain. The arithmetic of
 * the pad itself belongs to the foundation and is tested there (ADR 0010).
 */

describe('what the customer signs', () => {
  const report: RecordState = {
    id: 'd-1',
    subject: 'Sicherungen Keller',
    documentDate: '2026-09-21',
    customerId: 'c-1',
    jobId: 'j-1',
    introText: 'Zwei Leitungsschutzschalter getauscht.',
  }

  it('comes to the fingerprint the server works out from its rows', () => {
    // What the device holds: sent without a kind and without a description,
    // which the server stores as its defaults, `item` and null.
    const held: RecordState[] = [
      {
        id: 'l-2',
        position: 2,
        designation: 'LS-Schalter B16',
        quantityMilli: 2000,
        unit: 'piece',
      },
      { id: 'l-1', position: 1, designation: 'Arbeitszeit', quantityMilli: 2500, unit: 'hour' },
    ]

    const onServer = signedContentFingerprint({
      subject: 'Sicherungen Keller',
      documentDate: '2026-09-21',
      customerId: 'c-1',
      jobId: 'j-1',
      introText: 'Zwei Leitungsschutzschalter getauscht.',
      lines: [
        {
          id: 'l-1',
          position: 1,
          kind: 'item',
          designation: 'Arbeitszeit',
          description: null,
          quantityMilli: 2500,
          unit: 'hour',
        },
        {
          id: 'l-2',
          position: 2,
          kind: 'item',
          designation: 'LS-Schalter B16',
          description: null,
          quantityMilli: 2000,
          unit: 'piece',
        },
      ],
    })

    expect(signedContentFingerprint(signedContentOf(report, held))).toBe(onServer)
  })

  it('reads a report without a text as one whose text is empty, as the server does', () => {
    const blank = signedContentOf({ id: 'd-2' }, [])

    // And without fields of the business, which go into the fingerprint as none (#78).
    expect(blank).toEqual({
      subject: null,
      documentDate: null,
      customerId: null,
      jobId: null,
      introText: null,
      fields: null,
      fieldsVersion: null,
      zeroRateDeclaration: null,
      lines: [],
    })
    expect(signedContentFingerprint(blank)).toBe(
      signedContentFingerprint({ introText: null, lines: [] }),
    )
  })

  it('changes with every line the customer did not see', () => {
    const lines: RecordState[] = [
      { id: 'l-1', position: 1, designation: 'Arbeitszeit', quantityMilli: 2500, unit: 'hour' },
    ]
    const seen = signedContentFingerprint(signedContentOf(report, lines))
    const more = signedContentFingerprint(
      signedContentOf(report, [
        ...lines,
        { id: 'l-9', position: 2, designation: 'Anfahrt', quantityMilli: 1000, unit: 'flat_rate' },
      ]),
    )

    expect(more).not.toBe(seen)
  })
})

/**
 * A signature is held to the page it was drawn under (#1063): it goes when the
 * page changes, and it stays gone when the page changes back, since the pad
 * was mounted again empty by then.
 */
describe('the signature on the pad', () => {
  it('goes when the page changes, also when it changes back, and when the pad is cleared', () => {
    const { result, rerender } = renderHook(
      ({ fingerprint }: { fingerprint: string }) => useSignatureFor(fingerprint),
      { initialProps: { fingerprint: 'fnv1a32:00000001:1' } },
    )

    act(() => {
      result.current.onChange('M10,10L20,20')
    })

    expect(result.current).toMatchObject({ path: 'M10,10L20,20', pad: 0, pageChanged: false })

    act(() => {
      result.current.onChange(null)
    })

    expect(result.current.path).toBeNull()

    act(() => {
      result.current.onChange('M10,10L20,20')
    })
    rerender({ fingerprint: 'fnv1a32:00000002:1' })

    expect(result.current).toMatchObject({ path: null, pad: 1, pageChanged: true })

    rerender({ fingerprint: 'fnv1a32:00000001:1' })

    expect(result.current).toMatchObject({ path: null, pad: 1, pageChanged: true })

    act(() => {
      result.current.onChange('M30,30L40,40')
    })

    expect(result.current).toMatchObject({ path: 'M30,30L40,40', pad: 1, pageChanged: false })
  })

  it('goes when the page changes while its first stroke is still being drawn', () => {
    const { result, rerender } = renderHook(
      ({ fingerprint }: { fingerprint: string }) => useSignatureFor(fingerprint),
      { initialProps: { fingerprint: 'fnv1a32:00000001:1' } },
    )

    // The finger touches the pad, the page changes, and only then the stroke ends.
    act(() => {
      result.current.onPointerDown()
    })
    rerender({ fingerprint: 'fnv1a32:00000002:1' })
    act(() => {
      result.current.onChange('M10,10L20,20')
    })

    expect(result.current).toMatchObject({ path: null, pad: 1, pageChanged: true })

    act(() => {
      result.current.onPointerDown()
    })
    act(() => {
      result.current.onChange('M30,30L40,40')
    })

    expect(result.current).toMatchObject({ path: 'M30,30L40,40', pad: 1, pageChanged: false })
  })
})
