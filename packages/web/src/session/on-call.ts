import { type EmergencyTariff, emergencyKinds } from '@opengewerk/domain'
import { request } from '@opengewerk/platform-web/sync'

/**
 * The on-call plan (#293) as the office keeps it, at the routes of the
 * server: a device reads the times of its person through the sync and writes
 * none.
 */

export interface OnCallShift {
  readonly id: string
  readonly userId: string
  readonly startsAt: string
  readonly endsAt: string
  readonly note: string | null
}

export interface OnCallValues {
  readonly userId: string
  readonly startsAt: string
  readonly endsAt: string
  readonly note: string | null
}

export const onCallKey = ['on-call-shifts'] as const

export function onCallShifts(from: string, to: string): Promise<readonly OnCallShift[]> {
  return request<readonly OnCallShift[]>(
    `/on-call-shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  )
}

export function createOnCallShift(values: OnCallValues): Promise<OnCallShift> {
  return request<OnCallShift>('/on-call-shifts', { method: 'POST', body: JSON.stringify(values) })
}

export function changeOnCallShift(id: string, values: OnCallValues): Promise<OnCallShift> {
  return request<OnCallShift>(`/on-call-shifts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(values),
  })
}

export function removeOnCallShift(id: string): Promise<unknown> {
  return request(`/on-call-shifts/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function swapOnCallShifts(id: string, other: string): Promise<unknown> {
  return request(`/on-call-shifts/${encodeURIComponent(id)}/swap`, {
    method: 'POST',
    body: JSON.stringify({ with: other }),
  })
}

/**
 * The tariffs of an emergency call (#1024) from today on, as far as a time on
 * call reaches, one for each span of the same values: whoever takes a call
 * names the surcharge before the order, and calls come in where there is no
 * network, so the device keeps the last answer.
 */
export function emergencyTariffs(): Promise<readonly EmergencyTariff[]> {
  return request<readonly EmergencyTariff[]>('/on-call-shifts/tariffs')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Whether a kept value is a tariff in the shape the server answers with. */
function isTariff(value: unknown): value is EmergencyTariff {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const tariff = value as Partial<Record<keyof EmergencyTariff, unknown>>
  const night = tariff.night as { fromMinute?: unknown; untilMinute?: unknown } | null | undefined
  const surcharges = tariff.surcharges as Record<string, unknown> | null | undefined

  return (
    typeof tariff.on === 'string' &&
    typeof tariff.until === 'string' &&
    isCount(night?.fromMinute) &&
    isCount(night?.untilMinute) &&
    typeof surcharges === 'object' &&
    surcharges !== null &&
    emergencyKinds.every((kind) => {
      const one = surcharges[kind] as { flatCents?: unknown; basisPoints?: unknown } | undefined

      return isCount(one?.flatCents) && isCount(one?.basisPoints)
    }) &&
    (tariff.vatBasisPoints === null || isCount(tariff.vatBasisPoints)) &&
    Array.isArray(tariff.holidays) &&
    tariff.holidays.every((day) => typeof day === 'string')
  )
}

/**
 * The tariffs as the device keeps them (`tariffsName` in the store of the
 * tenant), or null where it keeps none it can read.
 */
export function keptTariffs(raw: string | null): readonly EmergencyTariff[] | null {
  try {
    const kept: unknown = raw ? JSON.parse(raw) : null

    return Array.isArray(kept) && kept.every(isTariff) ? (kept as EmergencyTariff[]) : null
  } catch {
    return null
  }
}
