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
 * The tariff of an emergency call (#1024) as the business has it today:
 * whoever takes a call names the surcharge before the order, and calls come
 * in where there is no network, so the device keeps the last answer.
 */
export function emergencyTariff(): Promise<EmergencyTariff> {
  return request<EmergencyTariff>('/on-call-shifts/tariff')
}

/** Per tenant, so that a device signed in to another business never names this one's surcharge. */
function tariffKey(tenantId: string): string {
  return `opengewerk.emergency-tariff.${tenantId}`
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

/** Keeps the tariff on the device; a browser that refuses to keep it asks again with a network. */
export function rememberTariff(tenantId: string, tariff: EmergencyTariff): void {
  try {
    globalThis.localStorage.setItem(tariffKey(tenantId), JSON.stringify(tariff))
  } catch {
    // Not kept. Without a network the screen then says that it lacks it.
  }
}

/** The tariff this device kept for a tenant, or null where it kept none it can read. */
export function rememberedTariff(tenantId: string): EmergencyTariff | null {
  try {
    const raw = globalThis.localStorage.getItem(tariffKey(tenantId))
    const kept: unknown = raw ? JSON.parse(raw) : null

    return isTariff(kept) ? kept : null
  } catch {
    return null
  }
}
