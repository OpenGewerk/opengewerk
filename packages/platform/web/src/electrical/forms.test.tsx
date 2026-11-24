import type { RecordState } from '@opengewerk/platform-domain'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Shell } from '../components/surface.js'
import type { Draft, EditResult } from '../sync/client.js'
import { CircuitForm } from './electrical.js'
import { PvForm } from './photovoltaic.js'

/**
 * What the forms of the structure hand along besides their values: what they
 * would have handed when they were opened, and after a save that was taken
 * what they handed then. `update` writes only what changed against it, so
 * that a field another device changed while the form was open stays
 * (opengewerk#1057).
 */

const queued = (): Promise<EditResult> => Promise.resolve({ outcome: 'queued', id: 'x' })

const taking = () => vi.fn<(values: Draft, opened: Draft) => Promise<EditResult>>(queued)

/** The values and what the form opened with, of the last save. */
function lastSave(submitted: ReturnType<typeof taking>) {
  const [values, opened] = submitted.mock.calls.at(-1) ?? []

  return { values, opened }
}

describe('what a form of the structure hands along (opengewerk#1057)', () => {
  it('hands a circuit along as it was opened, and after a save that was taken as it was saved', async () => {
    const circuit: RecordState = {
      id: 'sk-1',
      designation: 'F3',
      consumer: 'Herd',
      voltageClass: 'up_to_500',
      overcurrentDevice: 'circuit_breaker',
      tripCharacteristic: 'b',
      ratedCurrentMilli: 16_000,
      rcdType: 'a',
      rcdSelective: false,
      ratedResidualCurrentMilli: 30,
      cableType: 'NYM-J',
      cableCores: 3,
      cableCrossSectionMilli: 1500,
      cableLengthMilli: 12_000,
      cableInstallationMethod: null,
      version: 4,
    }
    const submitted = taking()

    render(
      <Shell entry="office">
        <CircuitForm record={circuit} sections={[]} submitLabel="Speichern" onSubmit={submitted} />
      </Shell>,
    )

    await userEvent.type(screen.getByLabelText('Verbraucher'), ' links')
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    const first = lastSave(submitted)

    expect(first.values).toMatchObject({ consumer: 'Herd links', designation: 'F3' })
    expect(first.opened).toEqual({ ...first.values, consumer: 'Herd' })

    await userEvent.type(screen.getByLabelText('Bezeichnung'), 'a')
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    const second = lastSave(submitted)

    expect(second.values).toEqual({ ...first.values, designation: 'F3a' })
    expect(second.opened).toEqual(first.values)
  })

  it('hands a part of the PV structure along as it was opened, and after a save that was taken as it was saved', async () => {
    const submitted = taking()

    render(
      <Shell entry="office">
        <PvForm
          fields={[
            { name: 'designation', label: 'Bezeichnung', required: true },
            { name: 'powerWatts', label: 'Leistung', unit: 'kW', places: 3 },
          ]}
          record={{ id: 'wr-1', designation: 'WR 1', powerWatts: 10_000, version: 2 }}
          submitLabel="Speichern"
          onSubmit={submitted}
        />
      </Shell>,
    )

    await userEvent.type(screen.getByLabelText('Bezeichnung'), ' Dach')
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    expect(lastSave(submitted)).toEqual({
      values: { designation: 'WR 1 Dach', powerWatts: 10_000 },
      opened: { designation: 'WR 1', powerWatts: 10_000 },
    })

    await userEvent.clear(screen.getByLabelText(/Leistung/))
    await userEvent.type(screen.getByLabelText(/Leistung/), '12')
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    expect(lastSave(submitted)).toEqual({
      values: { designation: 'WR 1 Dach', powerWatts: 12_000 },
      opened: { designation: 'WR 1 Dach', powerWatts: 10_000 },
    })
  })
})
