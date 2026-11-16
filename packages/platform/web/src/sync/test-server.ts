import {
  inOutboxOrder,
  type Operation,
  type OperationReceipt,
  type RecordState,
} from '@opengewerk/platform-domain'

import type { DirectWriter } from './client.js'
import type { PullResult, SyncTransport } from './transport.js'

type Row = Record<string, unknown>

/**
 * A stand in for the server, for the screen tests that write through the
 * outbox: it keeps what it is sent, hands it back on the next pull, and can be
 * taken off the network.
 *
 * It applies every operation as the real one does when nothing stands in the
 * way, a record created with what it carries and changed field by field, and
 * it does nothing the real one decides on its own. A test that needs a
 * refusal or a trigger builds that into its own stand in.
 */
export class TestServer implements SyncTransport, DirectWriter {
  readonly sent: Operation[][] = []
  /** The files that came up, by hash, in the order they came (#77). */
  readonly uploaded = new Map<string, { readonly bytes: ArrayBuffer; readonly mediaType: string }>()
  /** What happened, uploads and transmissions, in order. */
  readonly log: string[] = []
  /** Set to answer every upload with this refusal instead of taking it. */
  refuseUploads: Error | null = null
  offline = false
  /**
   * What the answer says the rows were narrowed to (#76, #140). Unset, it says
   * nothing, as an older server did; `{ notes: 'all' }` is a device that holds
   * every note of the tenant.
   */
  narrowed: Readonly<Record<string, string>> | undefined = undefined
  private readonly tables = new Map<string, Map<string, Row>>()
  private changed = new Map<string, Set<string>>()
  private cursor = 1
  /**
   * Every operation applied, as the server keeps its receipts, with the
   * transmission it was taken in: one number for each, rising, as the start of
   * a transaction is on the server.
   */
  private readonly taken = new Map<string, number>()
  private transmissions = 0

  put(entity: string, row: Row): void {
    const table = this.tables.get(entity) ?? new Map<string, Row>()
    const id = String(row['id'])

    table.set(id, { version: 1, deletedAt: null, ...row })
    this.tables.set(entity, table)
    this.changed.set(entity, (this.changed.get(entity) ?? new Set()).add(id))
  }

  row(entity: string, id: string): Row | undefined {
    return this.tables.get(entity)?.get(id)
  }

  all(entity: string): Row[] {
    return [...(this.tables.get(entity)?.values() ?? [])]
  }

  /** Everything sent, in the order it was sent. */
  operations(): Operation[] {
    return this.sent.flat()
  }

  private apply(operation: Operation): void {
    const id = operation.recordId
    const current = this.row(operation.entity, id) ?? { id, deletedAt: null, version: 0 }
    const values = Object.fromEntries(operation.patches.map((patch) => [patch.field, patch.to]))

    this.put(operation.entity, {
      ...current,
      ...values,
      version: Number(current['version'] ?? 0) + 1,
      deletedAt: operation.kind === 'delete' ? '2026-09-22T08:00:00.000Z' : current['deletedAt'],
    })
  }

  push(_deviceId: string, operations: readonly Operation[]) {
    if (this.offline) {
      return Promise.reject(new TypeError('Failed to fetch'))
    }

    this.sent.push([...operations])
    this.log.push(`push ${operations.map((operation) => operation.entity).join(',')}`)

    // As the server does: what it has taken once it does not apply again, and
    // answers with the receipt it gave. It applies a transmission in the order
    // of the outbox, whatever order it came in.
    const seen = new Set(this.taken.keys())

    this.transmissions += 1

    for (const operation of inOutboxOrder(operations)) {
      if (!seen.has(operation.id)) {
        this.apply(operation)
        this.taken.set(operation.id, this.transmissions)
      }
    }

    return Promise.resolve(
      operations.map((operation): OperationReceipt => ({
        operationId: operation.id,
        outcome: 'applied',
        reason: seen.has(operation.id) ? 'already_seen' : null,
        fields: [],
        takenAt: this.taken.get(operation.id) ?? this.transmissions,
      })),
    )
  }

  pull(): Promise<PullResult> {
    if (this.offline) {
      return Promise.reject(new TypeError('Failed to fetch'))
    }

    const changes = [...this.changed].map(([entity, ids]) => ({
      entity,
      rows: [...ids].map((id) => this.row(entity, id) as RecordState),
    }))

    this.changed = new Map()
    this.cursor += 1

    return Promise.resolve({
      changes,
      cursor: this.cursor,
      hasMore: false,
      ...(this.narrowed ? { narrowed: this.narrowed } : {}),
    })
  }

  conflicts() {
    return this.offline ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve([])
  }

  resolve() {
    return Promise.resolve()
  }

  upload(sha256: string, bytes: ArrayBuffer, mediaType: string) {
    if (this.offline) {
      return Promise.reject(new TypeError('Failed to fetch'))
    }

    if (this.refuseUploads) {
      return Promise.reject(this.refuseUploads)
    }

    this.uploaded.set(sha256, { bytes, mediaType })
    this.log.push(`upload ${sha256.slice(0, 8)}`)

    return Promise.resolve()
  }

  /** A change at the route never arrives here; a test that needs one overrides this. */
  patch(_entity: string, _id: string, _values: Readonly<Row>): Promise<unknown> {
    return Promise.reject(new TypeError('Failed to fetch'))
  }

  remove(_entity: string, _id: string): Promise<unknown> {
    return Promise.reject(new TypeError('Failed to fetch'))
  }
}
