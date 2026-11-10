import 'fake-indexeddb/auto'

import type {
  Operation,
  OperationId,
  OperationReceipt,
  RecordState,
  SyncConflict,
} from '@opengewerk/platform-domain'
import { syncRules } from '@opengewerk/platform-domain'
import { probePolicies } from '@opengewerk/platform-domain/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectWriter, SyncClient } from './client.js'
import {
  SyncClient as Client,
  exchangeRefusal,
  inTransmissions,
  largestTransmission,
  mostTransmittedOperations,
  noConnection,
  refusalFor,
  refusalText,
} from './client.js'
import { byRecord, project } from './projection.js'
import { type LocalStore, openLocalStore, StoreTakenOver, waitingIn } from './store.js'
import { updatesHeld } from '../shell/updates.js'
import type { ChangedRows, PullResult, SyncTransport } from './transport.js'
import { RequestRefused } from './transport.js'

// The client with the rules of an application that belongs to nobody: shelves
// are master data, notes and parcels are what work produces, a letter is
// written while it is a draft, its lines and its seal follow it, and a visit
// is whoever's it is. A test that ran green with the records of a real
// application would not show that the client knows none of them.
const rules = syncRules(probePolicies)

const entities = ['shelves', 'notes', 'parcels', 'letters', 'letter_lines', 'letter_seals']

const operationId = (value: string) => value as unknown as OperationId

/**
 * A server that answers whatever the test tells it to, and writes down what it
 * was asked. The point of the whole layer is what it does without a server, so
 * a test that needed one would be testing the wrong half.
 */
class Recorded implements SyncTransport {
  readonly sent: Operation[][] = []

  receipts: (operations: readonly Operation[]) => readonly OperationReceipt[] = (operations) =>
    operations.map((operation) => ({
      operationId: operation.id,
      outcome: 'applied' as const,
      reason: null,
      fields: [],
    }))

  pulls: PullResult[] = []
  open: SyncConflict[] = []
  readonly resolved: string[] = []
  /** The cursor of every pull, in order. */
  readonly asked: number[] = []
  refuse: Error | null = null
  /**
   * Refuses a push alone, the way the server refuses a transmission over one
   * operation in it, while pulling goes on as usual.
   */
  refusing: ((operations: readonly Operation[]) => Error | null) | null = null

  push(_deviceId: string, operations: readonly Operation[]) {
    if (this.refuse) {
      return Promise.reject(this.refuse)
    }

    const refusal = this.refusing?.(operations) ?? null

    if (refusal) {
      return Promise.reject(refusal)
    }

    this.sent.push([...operations])

    return Promise.resolve(this.receipts(operations))
  }

  pull(since: number) {
    if (this.refuse) {
      return Promise.reject(this.refuse)
    }

    this.asked.push(since)

    return Promise.resolve(this.pulls.shift() ?? { changes: [], cursor: since, hasMore: false })
  }

  conflicts() {
    return this.refuse ? Promise.reject(this.refuse) : Promise.resolve(this.open)
  }

  resolve(id: string) {
    this.resolved.push(id)

    return Promise.resolve()
  }
}

/**
 * The second way a change reaches the server, for the records that may not
 * wait in an outbox. It says yes or throws, and both are worth a test.
 */
class Writing implements DirectWriter {
  readonly patched: { entity: string; id: string; values: unknown }[] = []
  readonly removed: string[] = []
  /** The account each write named, in the order they came. */
  readonly accounts: (string | undefined)[] = []
  refuse: Error | null = null

  /** Records the change and the account it named, or refuses it with `refuse`. */
  patch(entity: string, id: string, values: Readonly<Record<string, unknown>>, account?: string) {
    this.accounts.push(account)

    if (this.refuse) {
      return Promise.reject(this.refuse)
    }

    this.patched.push({ entity, id, values })

    return Promise.resolve(undefined)
  }

  /** Records the removal and the account it named. */
  remove(entity: string, id: string, account?: string) {
    this.accounts.push(account)
    this.removed.push(`${entity}/${id}`)

    return Promise.resolve(undefined)
  }
}

let counter = 0
let writer = new Writing()

async function start(transport: SyncTransport, name?: string) {
  const store = await openLocalStore(name ?? `t${String((counter += 1))}`)

  writer = new Writing()

  return await Client.start({
    store,
    transport,
    writer,
    rules,
    deviceId: name ? `device-${name}` : 'device',
    entities,
    onSignedOut: () => {},
  })
}

function row(values: Partial<RecordState> & { id: string }): RecordState {
  return { version: 1, deletedAt: null, changeSequence: 1, ...values }
}

/**
 * Puts records into the client the way they really arrive, through a pull.
 * A back door that wrote straight into its memory would be a back door the
 * production code has to keep open for the tests.
 */
async function holding(
  client: SyncClient,
  transport: Recorded,
  ...changes: readonly ChangedRows[]
): Promise<void> {
  transport.pulls = [{ changes, cursor: 1, hasMore: false }]

  await client.synchronise()
}

describe('the projection', () => {
  const at = new Date('2026-10-02T08:00:00Z')

  function operation(part: Partial<Operation>): Operation {
    return {
      id: operationId('op-1'),
      entity: 'shelves',
      recordId: 's-1',
      kind: 'update',
      baseVersion: 1,
      patches: [],
      recordedAt: at,
      deviceId: 'device',
      ...part,
    }
  }

  it('gives a record that has never been sent the id it was minted with', () => {
    const created = project(
      null,
      [operation({ kind: 'create', patches: [{ field: 'name', from: null, to: 'Hall' }] })],
      's-1',
      rules.policyFor,
    )

    // The id is not in the patches and must not be: the server keeps that
    // column and refuses a patch naming it. It travels as `recordId`.
    expect(created).toEqual({ name: 'Hall', id: 's-1' })
  })

  it('starts a record made here in the state its policy names', () => {
    const created = project(
      null,
      [
        operation({
          entity: 'letters',
          recordId: 'letter-1',
          kind: 'create',
          patches: [{ field: 'subject', from: null, to: 'About the hall' }],
        }),
      ],
      'letter-1',
      rules.policyFor,
    )

    // The state is the server's to write and travels in no patch. The policy
    // says what it will be, so the gates that ask for it get an answer.
    expect(created).toEqual({ status: 'draft', subject: 'About the hall', id: 'letter-1' })
  })

  it('lays a change over what the server said without losing the rest', () => {
    const shown = project(
      row({ id: 's-1', name: 'Hall', place: 'ground floor' }),
      [operation({ patches: [{ field: 'name', from: 'Hall', to: 'Hall, left' }] })],
      's-1',
      rules.policyFor,
    )

    expect(shown?.['name']).toBe('Hall, left')
    expect(shown?.['place']).toBe('ground floor')
  })

  it('applies two queued changes in the order they were recorded', () => {
    const shown = project(
      row({ id: 's-1', name: 'Hall' }),
      [
        operation({
          id: operationId('op-2'),
          recordedAt: new Date('2026-10-02T09:00:00Z'),
          patches: [{ field: 'name', from: 'A', to: 'B' }],
        }),
        operation({ patches: [{ field: 'name', from: 'Hall', to: 'A' }] }),
      ],
      's-1',
      rules.policyFor,
    )

    expect(shown?.['name']).toBe('B')
  })

  it('shows nothing for a record the outbox deletes', () => {
    expect(
      project(row({ id: 's-1' }), [operation({ kind: 'delete' })], 's-1', rules.policyFor),
    ).toBeNull()
  })

  it('groups an outbox by the record each operation belongs to', () => {
    const grouped = byRecord([
      operation({}),
      operation({ id: operationId('op-2') }),
      operation({ id: operationId('op-3'), entity: 'notes', recordId: 'n-1' }),
    ])

    expect(grouped.get('shelves::s-1')).toHaveLength(2)
    expect(grouped.get('notes::n-1')).toHaveLength(1)
  })
})

describe('a device without a network', () => {
  let transport: Recorded

  beforeEach(() => {
    transport = new Recorded()
  })

  it('shows what somebody entered, although nothing has been sent', async () => {
    const client = await start(transport)

    transport.refuse = new TypeError('Failed to fetch')

    const made = await client.create('shelves', { name: 'Hall', kind: 'wood' })

    expect(made.outcome).toBe('queued')
    expect(client.list('shelves').map((entry) => entry['name'])).toEqual(['Hall'])
    expect(client.status().pending).toBe(1)
    expect(client.status().state).toBe('offline')
  })

  it('keeps the outbox over a restart, which is the whole point of it', async () => {
    const name = 'restart'
    const first = await start(transport, name)

    transport.refuse = new TypeError('Failed to fetch')
    await first.create('shelves', { name: 'Hall', kind: 'wood' })
    first.stop()

    const again = await start(transport, name)

    expect(again.status().pending).toBe(1)
    expect(again.list('shelves').map((entry) => entry['name'])).toEqual(['Hall'])
  })

  it('refuses a change to master data instead of queueing one it cannot keep', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'shelves',
      rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
    })

    transport.refuse = new TypeError('Failed to fetch')
    writer.refuse = new TypeError('Failed to fetch')

    const tried = await client.update('shelves', 's-1', { name: 'Hall, left' })

    // ADR 0005 lets somebody on the road add master data and not correct it.
    // Refusing here, with the form still open, beats an outbox entry that can
    // never land and a person who finds out two hours later.
    expect(tried).toEqual({ outcome: 'refused', reason: 'online_only', fields: [] })
    expect(client.status().pending).toBe(0)
    expect(client.needsConnection('shelves')).toBe(true)
    expect(client.needsConnection('notes')).toBe(false)
  })

  it('refuses a line whose parent has left the state its gate names', async () => {
    const client = await start(transport)

    await holding(
      client,
      transport,
      {
        entity: 'letters',
        rows: [row({ id: 'letter-1', status: 'sent', number: 'L-2026-0001' })],
      },
      { entity: 'letter_lines', rows: [row({ id: 'line-1', letterId: 'letter-1', words: 10 })] },
    )

    const tried = await client.update('letter_lines', 'line-1', { words: 20 })

    // The rule sits on the letter, not on the line, and the device works out
    // the same answer the server would, because the decision lives where both
    // can ask it and the device already holds the letter.
    expect(tried).toEqual({ outcome: 'refused', reason: 'record_is_fixed', fields: ['status'] })
  })

  it('lets a line be written while its parent is still in that state', async () => {
    const client = await start(transport)

    await holding(
      client,
      transport,
      { entity: 'letters', rows: [row({ id: 'letter-1', status: 'draft', number: null })] },
      { entity: 'letter_lines', rows: [row({ id: 'line-1', letterId: 'letter-1', words: 10 })] },
    )

    expect((await client.update('letter_lines', 'line-1', { words: 20 })).outcome).toBe('queued')
  })

  /**
   * A new line exists only in the operation that creates it, so the letter
   * it belongs to has to be read from there. Read from the stored record, as
   * it once was, every new line looked like one without a parent and was
   * refused before it left the device.
   */
  it('finds the parent of a new line in what the line is created with', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'letters',
      rows: [
        row({ id: 'letter-1', status: 'draft', number: null }),
        row({ id: 'letter-2', status: 'sent', number: 'L-2026-0001' }),
      ],
    })

    const line = { text: 'One more line', words: 3 }

    expect((await client.create('letter_lines', { ...line, letterId: 'letter-1' })).outcome).toBe(
      'queued',
    )
    expect(await client.create('letter_lines', { ...line, letterId: 'letter-2' })).toEqual({
      outcome: 'refused',
      reason: 'record_is_fixed',
      fields: ['status'],
    })
  })

  /**
   * A letter made on this device has no state until the server answers. The
   * gates that ask for one found nothing there and refused, and a record
   * written in a cellar turned down its own first line as already fixed.
   */
  it('lets a record made on the device take lines and changes before the server has it', async () => {
    const client = await start(transport)

    transport.refuse = new TypeError('Failed to fetch')

    const letter = await client.create('letters', {
      subject: 'About the hall',
      shelfId: 's-1',
      writtenOn: '2026-10-02',
    })

    if (letter.outcome !== 'queued') {
      throw new Error('The letter itself was refused')
    }

    expect(client.get('letters', letter.id)?.['status']).toBe('draft')

    const results = [
      await client.update('letters', letter.id, { opening: 'As agreed on the phone.' }),
      await client.create('letter_lines', {
        letterId: letter.id,
        position: 1,
        text: 'The shelf is full.',
        words: 4,
      }),
      await client.create('letter_seals', {
        letterId: letter.id,
        sealedBy: 'Erika Berg',
        sealedAt: '2026-10-02T12:32:00.000Z',
        shape: 'M100,300L200,120',
      }),
    ]

    expect(results.map((result) => result.outcome)).toEqual(['queued', 'queued', 'queued'])

    // The state is what the device assumes, not what it sends: the field is
    // the server's, and naming it in a patch is refused. The first exchange
    // is the failing one still under way; after a failure the client waits to
    // be asked again, so the network coming back is a second call.
    await client.synchronise()
    transport.refuse = null
    await client.synchronise()

    const created = transport.sent
      .flat()
      .find((operation) => operation.entity === 'letters' && operation.kind === 'create')

    expect(created?.patches.map((patch) => patch.field)).not.toContain('status')
  })

  it('never sends a field the server keeps, whatever a form hands it', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'parcels',
      rows: [row({ id: 'p-1', title: 'For the hall', number: 'P-0001' })],
    })

    await client.update('parcels', 'p-1', {
      title: 'For the hall, second floor',
      // What a form carrying the whole record would send back. The server
      // refuses the entire transmission over one of the columns it keeps
      // everywhere, so an outbox that let them through would stop working
      // altogether.
      id: 'p-1',
      version: 1,
      tenantId: 'tenant',
      updatedAt: '2026-10-02T00:00:00.000Z',
      // And what the policy of this entity reserves: sent, it would come back
      // as a conflict about a field nobody here meant to change.
      number: 'P-0002',
    })

    expect(transport.sent.at(-1)?.[0]?.patches.map((patch) => patch.field)).toEqual(['title'])
  })
})

describe('the rules a client is started with', () => {
  it('are the ones it decides by, and no others', async () => {
    // The same record under two lists: master data in one, ordinary work in
    // the other. A client that asked anything but what it was handed would
    // answer the same for both.
    const transport = new Recorded()
    const lenient = await Client.start({
      store: await openLocalStore('lenient'),
      transport,
      writer: new Writing(),
      rules: syncRules({ shelves: { create: true, change: 'merge' } }),
      deviceId: 'device',
      entities: ['shelves'],
      onSignedOut: () => {},
    })
    const strict = await start(new Recorded(), 'strict')

    expect(lenient.needsConnection('shelves')).toBe(false)
    expect(strict.needsConnection('shelves')).toBe(true)

    await holding(lenient, transport, {
      entity: 'shelves',
      rows: [row({ id: 's-1', name: 'Hall' })],
    })
    await lenient.update('shelves', 's-1', { name: 'Hall, left' })

    expect(transport.sent.at(-1)?.[0]?.patches).toEqual([
      { field: 'name', from: 'Hall', to: 'Hall, left' },
    ])
  })

  it('refuse a kind of record they do not name, before anything is queued', async () => {
    const client = await start(new Recorded())

    expect(await client.create('ledgers', { name: 'Nobody knows these' })).toEqual({
      outcome: 'refused',
      reason: 'unknown_entity',
      fields: [],
    })
    expect(client.status().pending).toBe(0)
  })
})

/**
 * A device that already holds data and gets a new build. The cursor it kept
 * was moved by the old build, past every row of a kind the old build did not
 * know, and the new build must not trust it for those.
 */
describe('a new build on a device that already has data', () => {
  let transport: Recorded

  beforeEach(() => {
    transport = new Recorded()
  })

  async function startWith(known: readonly string[], name: string) {
    return await Client.start({
      store: await openLocalStore(name),
      transport,
      writer: new Writing(),
      rules,
      deviceId: 'device',
      entities: known,
      onSignedOut: () => {},
    })
  }

  const seal = row({ id: 'seal-1', letterId: 'letter-1', sealedBy: 'Erika Berg' })

  it('asks from the beginning once when it knows a kind of record the last build did not', async () => {
    const older = await startWith(['shelves'], 'upgrade')

    transport.pulls = [
      {
        changes: [
          { entity: 'shelves', rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })] },
          { entity: 'letter_seals', rows: [seal] },
        ],
        cursor: 7,
        hasMore: false,
      },
    ]
    await older.synchronise()
    older.stop()

    const newer = await startWith(['shelves', 'letter_seals'], 'upgrade')

    transport.pulls = [
      {
        changes: [{ entity: 'letter_seals', rows: [seal] }],
        cursor: 7,
        hasMore: false,
      },
    ]
    await newer.synchronise()

    expect(transport.asked).toEqual([0, 0])
    expect(newer.list('letter_seals').map((entry) => entry['sealedBy'])).toEqual(['Erika Berg'])
  })

  it('keeps its place when it knows nothing the last build did not', async () => {
    const first = await startWith(['shelves'], 'same-build')

    transport.pulls = [{ changes: [], cursor: 7, hasMore: false }]
    await first.synchronise()
    first.stop()

    await (await startWith(['shelves'], 'same-build')).synchronise()

    expect(transport.asked).toEqual([0, 7])
  })

  it('asks from the beginning after a build that kept no list, and only the once', async () => {
    const store = await openLocalStore('before-the-list')

    await store.writeMeta('cursor', 7)
    store.close()

    const first = await startWith(['shelves'], 'before-the-list')

    transport.pulls = [{ changes: [], cursor: 9, hasMore: false }]
    await first.synchronise()
    first.stop()

    await (await startWith(['shelves'], 'before-the-list')).synchronise()

    expect(transport.asked).toEqual([0, 9])
  })

  it('starts again after going back to a build that knew less and forward once more', async () => {
    const both = ['shelves', 'letter_seals']

    const first = await startWith(both, 'back-and-forth')

    transport.pulls = [{ changes: [], cursor: 5, hasMore: false }]
    await first.synchronise()
    first.stop()

    const back = await startWith(['shelves'], 'back-and-forth')

    transport.pulls = [{ changes: [], cursor: 8, hasMore: false }]
    await back.synchronise()
    back.stop()

    await (await startWith(both, 'back-and-forth')).synchronise()

    // The build in the middle dropped whatever seals arrived between 5 and 8,
    // so the third asks from the beginning and not from 8.
    expect(transport.asked).toEqual([0, 5, 0])
  })
})

describe('a device handed to somebody who sees less, or more', () => {
  let transport: Recorded

  beforeEach(() => {
    transport = new Recorded()
  })

  async function startOn(name: string, held: readonly string[] = ['shelves', 'visits']) {
    return await Client.start({
      store: await openLocalStore(name),
      transport,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: held,
      onSignedOut: () => {},
    })
  }

  const theirs = row({ id: 'v-1', userId: 'u-desk' })
  const mine = row({ id: 'v-2', userId: 'u-road' })

  it('lets go of what it pulled before any narrowing was kept, at the first narrowing it is told', async () => {
    // A device that pulled from a server that named no narrowing yet.
    const before = await startOn('old-tablet')

    transport.pulls = [
      { changes: [{ entity: 'visits', rows: [theirs, mine] }], cursor: 9, hasMore: false },
    ]
    await before.synchronise()
    before.stop()

    const after = await startOn('old-tablet')

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: { visits: 'user:u-road' } },
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
    ]
    await after.synchronise()

    expect(transport.asked.slice(-2)).toEqual([9, 0])
    expect(after.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    after.stop()
  })

  it('lets go of them too when a newer build that knows more entities starts from the start', async () => {
    // A build that knew visits alone, from before any narrowing.
    const before = await startOn('older-tablet', ['visits'])

    transport.pulls = [
      { changes: [{ entity: 'visits', rows: [theirs, mine] }], cursor: 9, hasMore: false },
    ]
    await before.synchronise()
    before.stop()

    // This build knows shelves as well, and asks from 0 with the rows kept.
    const after = await startOn('older-tablet')

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: { visits: 'user:u-road' } },
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
    ]
    await after.synchronise()

    expect(transport.asked.slice(-2)).toEqual([0, 0])
    expect(after.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    after.stop()
  })

  it('lets go of the rows a build that knew fewer entities kept and never loaded', async () => {
    // Pulled visits from before any narrowing with a build that knew visits
    // alone, then started by one that knows shelves alone: it starts from 0
    // and holds no rows it loads, and is told the first narrowing.
    const before = await startOn('mixed-tablet', ['visits'])

    transport.pulls = [
      { changes: [{ entity: 'visits', rows: [theirs, mine] }], cursor: 9, hasMore: false },
    ]
    await before.synchronise()
    before.stop()

    const fewer = await startOn('mixed-tablet', ['shelves'])

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: { visits: 'user:u-road' } },
    ]
    await fewer.synchronise()
    fewer.stop()

    // A build that knows visits again finds none of the rows from before.
    const again = await startOn('mixed-tablet')

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: { visits: 'user:u-road' } },
    ]
    await again.synchronise()

    expect(again.list('visits')).toEqual([])
    again.stop()
  })

  it('asks from the start when its rows went and its cursor did not, before any narrowing was kept', async () => {
    const before = await startOn('half-tablet')

    transport.pulls = [
      { changes: [{ entity: 'visits', rows: [theirs, mine] }], cursor: 9, hasMore: false },
    ]
    await before.synchronise()
    before.stop()

    // A page closed after the rows went and before anything else was written.
    const store = await openLocalStore('half-tablet')

    await store.drop('visits')
    store.close()

    const after = await startOn('half-tablet')

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: { visits: 'user:u-road' } },
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
    ]
    await after.synchronise()

    expect(transport.asked.slice(-2)).toEqual([9, 0])
    expect(after.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    after.stop()
  })

  it('lets go of the rows of the others, and asks again from the start', async () => {
    // Somebody who reads every visit pulled first, and with it everybody's.
    const desk = await startOn('shared-tablet')

    transport.pulls = [
      {
        changes: [
          { entity: 'shelves', rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })] },
          { entity: 'visits', rows: [theirs, mine] },
        ],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'all' },
      },
    ]
    await desk.synchronise()
    desk.stop()

    // Then somebody who reads only their own, on the same tablet and in the
    // same tenant.
    const road = await startOn('shared-tablet')

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: { visits: 'user:u-road' } },
      {
        changes: [
          { entity: 'shelves', rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })] },
          { entity: 'visits', rows: [mine] },
        ],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
    ]
    await road.synchronise()

    expect(transport.asked).toEqual([0, 9, 0])
    expect(road.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    expect(road.list('shelves').map((entry) => entry['id'])).toEqual(['s-1'])

    // What the store holds went too, not only what is in memory.
    road.stop()

    const again = await startOn('shared-tablet')

    expect(again.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
  })

  /**
   * The page is closed, or the phone locks, while letting go
   * (opengewerk-haustechnik#31). Letting go is one transaction of the store
   * (opengewerk#899), so none of it is written, and the next start does the
   * whole of it again.
   */
  it('lets go of everything at the next start, when the page closed while letting go', async () => {
    const desk = await startOn('cut-tablet')

    transport.pulls = [
      {
        changes: [
          { entity: 'shelves', rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })] },
          { entity: 'visits', rows: [theirs, mine] },
        ],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'all', shelves: 'all' },
      },
    ]
    await desk.synchronise()
    desk.stop()

    // Letting go is where the page closes: the transaction never commits.
    const store = await openLocalStore('cut-tablet')
    const closing: LocalStore = {
      ...store,
      restartPull: () => Promise.reject(new Error('Die Seite ist zu.')),
    }
    const road = await Client.start({
      store: closing,
      transport,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: ['shelves', 'visits'],
      onSignedOut: () => {},
    })
    const narrower = { visits: 'user:u-road', shelves: 'part:hall' }

    transport.pulls = [{ changes: [], cursor: 9, hasMore: false, narrowed: narrower }]
    await road.synchronise()
    road.stop()

    const again = await startOn('cut-tablet')

    transport.asked.length = 0
    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: narrower },
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: narrower,
      },
    ]
    await again.synchronise()

    // Nothing of it was written: the next start asks from where it stood,
    // hears the new narrowing and lets go of the whole of it then.
    expect(transport.asked).toEqual([9, 0])
    expect(again.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    expect(again.list('shelves')).toEqual([])
  })

  /**
   * Two tabs of one browser share the store (opengewerk#899). The first hears
   * a new narrowing, goes back to the start and is closed after its first
   * page; the second still stands at its own cursor from before. It asked
   * from there and wrote a later cursor over the rows the first never
   * reached, and the device went on without them.
   */
  it('loses no row when another tab went back to the start and was closed halfway', async () => {
    const narrower = { visits: 'user:u-road' }
    const later = row({ id: 'v-3', userId: 'u-road' })
    const first = await startOn('two-tabs')

    transport.pulls = [
      {
        changes: [{ entity: 'visits', rows: [theirs, mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'all' },
      },
    ]
    await first.synchronise()

    const second = new Recorded()
    const other = await Client.start({
      store: await openLocalStore('two-tabs'),
      transport: second,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: ['shelves', 'visits'],
      onSignedOut: () => {},
    })

    // The first tab: the new narrowing, the first page from the start, and
    // then the page is closed before the next answer comes.
    const pull = transport.pull.bind(transport)
    let pages = 0

    transport.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: narrower },
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 4,
        hasMore: true,
        narrowed: narrower,
      },
    ]
    transport.pull = (since: number) => {
      pages += 1

      return pages > 2 ? new Promise<never>(() => {}) : pull(since)
    }
    void first.synchronise()
    await vi.waitFor(() => {
      expect(pages).toBe(3)
    })
    first.stop()

    // The second tab asks from its own cursor; the server has the row the
    // first never reached behind 4.
    second.pulls = [
      { changes: [], cursor: 12, hasMore: false, narrowed: narrower },
      {
        changes: [{ entity: 'visits', rows: [later] }],
        cursor: 12,
        hasMore: false,
        narrowed: narrower,
      },
    ]
    await other.synchronise()

    expect(second.asked).toEqual([9, 4])
    // What the second shows is what the store holds now, without the row the
    // first let go of.
    expect(
      other
        .list('visits')
        .map((entry) => entry['id'])
        .sort(),
    ).toEqual(['v-2', 'v-3'])
    other.stop()

    const again = await startOn('two-tabs')

    expect(
      again
        .list('visits')
        .map((entry) => entry['id'])
        .sort(),
    ).toEqual(['v-2', 'v-3'])
    again.stop()
  })

  /**
   * A tab that holds nothing yet keeps the first narrowing it is told; the
   * store it shares may stand further on by then, pulled by another tab from
   * a server that named no narrowing (opengewerk#899). It starts the store
   * from the beginning too, rather than keeping a cursor with rows gone
   * behind it.
   */
  it('starts the store from the beginning when it keeps the first narrowing, whatever another tab pulled', async () => {
    const empty = await startOn('fresh-and-other')
    const second = new Recorded()
    const other = await Client.start({
      store: await openLocalStore('fresh-and-other'),
      transport: second,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: ['shelves', 'visits'],
      onSignedOut: () => {},
    })

    second.pulls = [
      { changes: [{ entity: 'visits', rows: [theirs, mine] }], cursor: 9, hasMore: false },
    ]
    await other.synchronise()
    other.stop()

    transport.pulls = [
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
    ]
    await empty.synchronise()

    expect(transport.asked).toEqual([0])
    expect(empty.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    empty.stop()
  })

  /** A server that answers every pull from before 12 with what it holds, and from 12 on with nothing. */
  function holdingUpTo12(changes: readonly ChangedRows[]): Recorded {
    const answering = new Recorded()

    answering.pull = (since: number) => {
      answering.asked.push(since)

      return Promise.resolve(
        since < 12
          ? { changes, cursor: 12, hasMore: false }
          : { changes: [], cursor: 12, hasMore: false },
      )
    }

    return answering
  }

  /** A tab of a build that knows `held`, on the store `name`, asking `server`. */
  async function aTabOf(name: string, held: readonly string[], server: Recorded) {
    return await Client.start({
      store: await openLocalStore(name),
      transport: server,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: held,
      onSignedOut: () => {},
    })
  }

  const shelf = row({ id: 's-1', name: 'Hall', kind: 'wood' })

  /**
   * Two tabs of two builds after an update, the newer knowing shelves as well
   * (opengewerk#899). The older moved the one cursor past the shelves, and the
   * newer took that cursor over when its own page was refused: the shelves
   * never came. A build that knows fewer kinds than the store is kept for
   * writes nothing to it and keeps what it pulls in its memory.
   */
  it('lets the tab of the build that knows more kinds pull, when it opened last', async () => {
    const olderServer = holdingUpTo12([{ entity: 'visits', rows: [mine] }])
    const older = await aTabOf('builds-newer-last', ['visits'], olderServer)

    await older.synchronise()
    olderServer.asked.length = 0

    const newerServer = holdingUpTo12([
      { entity: 'visits', rows: [mine] },
      { entity: 'shelves', rows: [shelf] },
    ])
    const newer = await aTabOf('builds-newer-last', ['shelves', 'visits'], newerServer)

    const syncedBefore = older.status().lastSyncedAt

    await older.synchronise()
    await newer.synchronise()

    // The older says it is out of date, not that it is up to date: what it
    // pulls is in its memory alone until it is loaded as the newer build.
    expect(older.status().troubleKind).toBe('outdated')
    expect(older.status().state).not.toBe('synced')
    expect(older.status().lastSyncedAt).toBe(syncedBefore)
    expect(newer.status().troubleKind).toBeNull()
    expect(olderServer.asked).toEqual([12])
    expect(newerServer.asked).toEqual([0])
    expect(newer.list('shelves').map((entry) => entry['id'])).toEqual(['s-1'])
    expect(older.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    older.stop()
    newer.stop()
  })

  /**
   * A role that sees less, heard by the first of two tabs (opengewerk#899).
   * It goes back to the start and pulls up to the cursor the second still
   * stands at. The second finds the store at its cursor and with the new
   * narrowing, and held the rows of the other person in its memory until it
   * was loaded again.
   */
  it('lets go of the rows another tab let go of for a narrower role, at the same cursor', async () => {
    const all = { visits: 'all' }
    const own = { visits: 'user:u-road' }
    const firstServer = new Recorded()
    const secondServer = new Recorded()
    const first = await aTabOf('narrower-two-tabs', ['shelves', 'visits'], firstServer)

    firstServer.pulls = [
      {
        changes: [{ entity: 'visits', rows: [theirs, mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: all,
      },
    ]
    await first.synchronise()

    const second = await aTabOf('narrower-two-tabs', ['shelves', 'visits'], secondServer)

    expect(second.list('visits')).toHaveLength(2)

    firstServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
      { changes: [{ entity: 'visits', rows: [mine] }], cursor: 9, hasMore: false, narrowed: own },
    ]
    await first.synchronise()

    secondServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
    ]
    await second.synchronise()

    expect(second.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    first.stop()
    second.stop()
  })

  /**
   * The narrowing changes twice before the second tab asks again: first the
   * role, then another kind (opengewerk#899). The second tab held what it
   * let go of against the store and not against what its memory was pulled
   * for, and kept the visits of the other person.
   */
  it('lets go of them too when the narrowing changed twice before it asked again', async () => {
    const first = { shelves: 'a', visits: 'all' }
    const role = { shelves: 'a', visits: 'user:u-road' }
    const both = { shelves: 'b', visits: 'user:u-road' }
    const firstServer = new Recorded()
    const secondServer = new Recorded()
    const one = await aTabOf('narrowed-twice', ['shelves', 'visits'], firstServer)

    firstServer.pulls = [
      {
        changes: [{ entity: 'visits', rows: [theirs, mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: first,
      },
    ]
    await one.synchronise()

    const two = await aTabOf('narrowed-twice', ['shelves', 'visits'], secondServer)

    // The first tab hears the narrower role and starts again; the store keeps it.
    firstServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: role },
      { changes: [{ entity: 'visits', rows: [mine] }], cursor: 9, hasMore: false, narrowed: role },
    ]
    await one.synchronise()

    // The second hears the change after that one first, which differs from
    // what the store keeps in the shelves alone.
    secondServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: both },
      { changes: [], cursor: 9, hasMore: false, narrowed: both },
      { changes: [{ entity: 'visits', rows: [mine] }], cursor: 9, hasMore: false, narrowed: both },
    ]
    await two.synchronise()

    expect(two.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    one.stop()
    two.stop()
  })

  /**
   * A tab is opened while another goes back to the start for a narrower role
   * and pulls up to the same cursor again (opengewerk#899). The new tab takes
   * cursor, narrowing and rows in one step; whatever the other does right
   * after, its first exchange finds the store kept for another narrowing than
   * its rows and takes the store again.
   */
  it('holds no old rows for a new narrowing when it opens while another tab starts again', async () => {
    const all = { visits: 'all' }
    const own = { visits: 'user:u-road' }
    const firstServer = new Recorded()
    const one = await aTabOf('opened-while-restarting', ['shelves', 'visits'], firstServer)

    firstServer.pulls = [
      {
        changes: [{ entity: 'visits', rows: [theirs, mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: all,
      },
    ]
    await one.synchronise()

    const store = await openLocalStore('opened-while-restarting')
    let raced = false
    // The other tab goes back to the start the moment this one has read the store.
    const racing: LocalStore = {
      ...store,
      readPulled: async (entities) => {
        const read = await store.readPulled(entities)

        if (!raced) {
          raced = true
          firstServer.pulls = [
            { changes: [], cursor: 9, hasMore: false, narrowed: own },
            {
              changes: [{ entity: 'visits', rows: [mine] }],
              cursor: 9,
              hasMore: false,
              narrowed: own,
            },
          ]
          await one.synchronise()
        }

        return read
      },
    }
    const secondServer = new Recorded()
    const two = await Client.start({
      store: racing,
      transport: secondServer,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: ['shelves', 'visits'],
      onSignedOut: () => {},
    })

    secondServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
    ]
    await two.synchronise()

    expect(raced).toBe(true)
    expect(two.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    one.stop()
    two.stop()
  })

  /**
   * A tab hears a new narrowing and chooses the kinds to let go of by what the
   * store keeps; before it lets go, another tab starts again for a third and
   * writes a page (opengewerk#899). Letting go by the narrowing read before
   * left rows of a kind the other wrote under a narrowing that excludes them.
   */
  it('lets go of nothing by a narrowing another tab replaced since it was read', async () => {
    const first = { shelves: 'a', visits: 'user:u-road' }
    const said = { shelves: 'b', visits: 'user:u-road' }
    const between = { shelves: 'a', visits: 'all' }
    const oneServer = new Recorded()
    const store = await openLocalStore('restart-by-old-narrowing')
    let armed = false
    const otherServer = new Recorded()
    const other = await aTabOf('restart-by-old-narrowing', ['shelves', 'visits'], otherServer)
    const racing: LocalStore = {
      ...store,
      readMeta: async (key) => {
        const read = await store.readMeta(key)

        if (key === 'narrowed' && armed) {
          armed = false
          otherServer.pulls = [
            { changes: [], cursor: 9, hasMore: false, narrowed: between },
            {
              changes: [{ entity: 'visits', rows: [theirs, mine] }],
              cursor: 9,
              hasMore: false,
              narrowed: between,
            },
          ]
          await other.synchronise()
        }

        return read
      },
    }
    const one = await Client.start({
      store: racing,
      transport: oneServer,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: ['shelves', 'visits'],
      onSignedOut: () => {},
    })

    oneServer.pulls = [
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: first,
      },
    ]
    await one.synchronise()
    // The other tab took the store as it stands now, before the race.
    otherServer.pulls = [{ changes: [], cursor: 9, hasMore: false, narrowed: first }]
    await other.synchronise()

    armed = true
    oneServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: said },
      { changes: [], cursor: 9, hasMore: false, narrowed: said },
      { changes: [{ entity: 'visits', rows: [mine] }], cursor: 9, hasMore: false, narrowed: said },
    ]
    await one.synchronise()
    one.stop()
    other.stop()

    const again = await startOn('restart-by-old-narrowing')

    expect(again.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    again.stop()
  })

  it('lets go of them too when the rows in its memory were pulled before any narrowing', async () => {
    const own = { visits: 'user:u-road' }
    const firstServer = new Recorded()
    const secondServer = new Recorded()
    const first = await aTabOf('first-narrowing-two-tabs', ['shelves', 'visits'], firstServer)

    // Pulled from a server that named no narrowing yet.
    firstServer.pulls = [
      { changes: [{ entity: 'visits', rows: [theirs, mine] }], cursor: 9, hasMore: false },
    ]
    await first.synchronise()

    const second = await aTabOf('first-narrowing-two-tabs', ['shelves', 'visits'], secondServer)

    firstServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
      { changes: [{ entity: 'visits', rows: [mine] }], cursor: 9, hasMore: false, narrowed: own },
    ]
    await first.synchronise()

    secondServer.pulls = [
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
      { changes: [], cursor: 9, hasMore: false, narrowed: own },
    ]
    await second.synchronise()

    expect(second.list('visits').map((entry) => entry['id'])).toEqual(['v-2'])
    first.stop()
    second.stop()
  })

  /**
   * The newer tab pulled once and is closed, or stays idle; the older goes on
   * working. It shows what it writes itself and what others write, as every
   * tab did before the store took turns, while the store is left to the newer
   * build.
   */
  it('lets the tab of the older build go on showing what it and others write', async () => {
    const theirs9 = row({ id: 's-9', name: 'Keller', kind: 'metal' })
    const olderServer = new Recorded()

    olderServer.pull = (since: number) => {
      olderServer.asked.push(since)

      const created = olderServer.sent
        .flat()
        .filter((operation) => operation.entity === 'shelves' && operation.kind === 'create')
        .map((operation) => row({ id: operation.recordId, name: 'Neu', kind: 'wood' }))

      return Promise.resolve(
        since < 12
          ? { changes: [{ entity: 'shelves', rows: [shelf] }], cursor: 12, hasMore: false }
          : since < 15
            ? {
                changes: [{ entity: 'shelves', rows: [theirs9, ...created] }],
                cursor: 15,
                hasMore: false,
              }
            : { changes: [], cursor: 15, hasMore: false },
      )
    }

    const older = await aTabOf('builds-older-goes-on', ['shelves'], olderServer)

    await older.synchronise()

    const newer = await aTabOf(
      'builds-older-goes-on',
      ['shelves', 'visits'],
      holdingUpTo12([
        { entity: 'visits', rows: [mine] },
        { entity: 'shelves', rows: [shelf] },
      ]),
    )

    await newer.synchronise()
    newer.stop()

    const made = await older.create('shelves', { name: 'Neu', kind: 'wood' })

    if (made.outcome !== 'queued') {
      throw new Error('The shelf was not queued.')
    }

    await older.synchronise()

    expect(older.list('shelves').map((entry) => entry['id'])).toEqual(
      expect.arrayContaining(['s-1', 's-9', made.id]),
    )
    expect(older.list('shelves')).toHaveLength(3)
    expect(older.status().pending).toBe(0)
    expect(older.status().troubleKind).toBe('outdated')

    // The store is the newer build's: nothing of the older's pulls went in.
    const again = await startOn('builds-older-goes-on')

    expect(again.list('shelves').map((entry) => entry['id'])).toEqual(['s-1'])
    again.stop()
    older.stop()
  })

  /**
   * A tab of a build from before checked writes knows visits alone, and sets
   * the cursor itself past the shelves (opengewerk#899). The tab of this build
   * found the cursor moved, took it over and never got the shelves; it starts
   * the store again instead.
   */
  it('takes the store back from a tab of a build that checks nothing and moved the cursor', async () => {
    const newerServer = holdingUpTo12([
      { entity: 'visits', rows: [mine] },
      { entity: 'shelves', rows: [shelf] },
    ])
    const newer = await aTabOf('build-from-before', ['shelves', 'visits'], newerServer)
    // The tab from before: its rows and its cursor, written without a check.
    const before = await openLocalStore('build-from-before')

    await before.write('visits', [mine])
    await before.writeMeta('cursor', 12)
    before.close()

    await newer.synchronise()

    expect(newerServer.asked).toEqual([0, 0])
    expect(newer.list('shelves').map((entry) => entry['id'])).toEqual(['s-1'])
    newer.stop()
  })

  /**
   * A store an earlier version kept, opened by this one (opengewerk#899). Its
   * cursor is taken as checked once, so that no device pulls everything again
   * after the update.
   */
  it('goes on from the cursor of a store kept before writes were checked', async () => {
    const server = holdingUpTo12([{ entity: 'visits', rows: [mine] }])
    const store = await openLocalStore('kept-before-checks')

    await store.writeMeta('entities', 'shelves,visits')
    await store.writeMeta('cursor', 12)
    store.close()

    const device = await aTabOf('kept-before-checks', ['shelves', 'visits'], server)

    await device.synchronise()

    expect(server.asked).toEqual([12])
    device.stop()
  })

  /**
   * A build that knows a kind more opens a store an older build kept, with
   * the answer of its last pull settled (#444). Until it has pulled from the
   * start, it does not say it holds every shelf (opengewerk#899).
   */
  it('says it holds no kind as a whole when it starts a store from the start for its kinds', async () => {
    const store = await openLocalStore('settled-by-older')

    await store.writeMeta('entities', 'visits')
    await store.writeMeta('cursor', 9)
    await store.writeMeta('narrowed-settled', JSON.stringify({ shelves: 'all', visits: 'all' }))
    store.close()

    const device = await aTabOf('settled-by-older', ['shelves', 'visits'], new Recorded())

    expect(device.holdsAll('shelves')).toBe(false)

    const again = await openLocalStore('settled-by-older')

    expect(await again.readMeta('narrowed-settled')).toBe('')
    expect(await again.readMeta('cursor')).toBe(0)
    again.close()
    device.stop()
  })

  it('takes the store back for its kinds when a tab of an older build pulled since', async () => {
    const newerServer = holdingUpTo12([
      { entity: 'visits', rows: [mine] },
      { entity: 'shelves', rows: [shelf] },
    ])
    const newer = await aTabOf('builds-older-last', ['shelves', 'visits'], newerServer)
    // The older opens after it, and keeps the store for its own kinds.
    const olderServer = holdingUpTo12([{ entity: 'visits', rows: [mine] }])
    const older = await aTabOf('builds-older-last', ['visits'], olderServer)

    await older.synchronise()
    await newer.synchronise()

    expect(newerServer.asked).toEqual([0, 0])
    expect(newer.list('shelves').map((entry) => entry['id'])).toEqual(['s-1'])

    // From then on the older reads and asks nothing more.
    olderServer.asked.length = 0
    await older.synchronise()

    expect(olderServer.asked).toEqual([12])
    older.stop()
    newer.stop()

    const again = await startOn('builds-older-last')

    expect(again.list('shelves').map((entry) => entry['id'])).toEqual(['s-1'])
    again.stop()
  })

  /**
   * Another tab goes back to the start right after the last page of this one
   * is in (opengewerk#899). What the rows add up to goes with that page, so the
   * start from the beginning leaves nothing settled behind, and no screen
   * counts rows as all there that the other tab let go of.
   */
  it('reports no pull as run through over rows another tab let go of since', async () => {
    const store = await openLocalStore('settled-two-tabs')
    const other = await openLocalStore('settled-two-tabs')
    const racing: LocalStore = {
      ...store,
      writePulled: async (page) => {
        const written = await store.writePulled(page)

        if (written === 'written' && page.settled !== null) {
          await other.restartPull(['visits'], JSON.stringify({ visits: 'user:u-road' }))
        }

        return written
      },
    }
    const device = await Client.start({
      store: racing,
      transport,
      writer: new Writing(),
      rules,
      deviceId: 'tablet',
      entities: ['shelves', 'visits'],
      onSignedOut: () => {},
    })

    transport.pulls = [
      {
        changes: [{ entity: 'visits', rows: [theirs, mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'all' },
      },
    ]
    await device.synchronise()

    expect(await other.readMeta('narrowed-settled')).toBe('')
    device.stop()
    other.close()
  })

  it('keeps everything while the server narrows the same way, or says nothing', async () => {
    const first = await startOn('same-person')

    transport.pulls = [
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 4,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
      { changes: [], cursor: 4, hasMore: false, narrowed: { visits: 'user:u-road' } },
      { changes: [], cursor: 4, hasMore: false },
    ]
    await first.synchronise()
    await first.synchronise()
    await first.synchronise()

    expect(transport.asked).toEqual([0, 4, 4])
    expect(first.list('visits')).toHaveLength(1)
  })

  /**
   * Whether the device holds every row, for what the rows add up to (#314):
   * from the answer of the server, kept across a start, and never assumed
   * before one said so.
   */
  it('knows whether it holds every row of an entity from the last answer', async () => {
    const device = await startOn('holds-all')

    expect(device.holdsAll('visits')).toBe(false)

    transport.pulls = [{ changes: [], cursor: 2, hasMore: false, narrowed: { visits: 'all' } }]
    await device.synchronise()

    expect(device.holdsAll('visits')).toBe(true)
    device.stop()

    const again = await startOn('holds-all')

    expect(again.holdsAll('visits')).toBe(true)

    transport.pulls = [
      { changes: [], cursor: 2, hasMore: false, narrowed: { visits: 'user:u-road' } },
      { changes: [], cursor: 2, hasMore: false, narrowed: { visits: 'user:u-road' } },
    ]
    await again.synchronise()

    expect(again.holdsAll('visits')).toBe(false)
  })

  /**
   * Not before the pull after a change has run through (#444): the device
   * dropped what it held and asks from the start, and until the last page is
   * in, the rows it counts are a part.
   */
  it('says it holds every row only once the pull after a change has run through', async () => {
    const device = await startOn('holds-all-later')

    transport.pulls = [
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 4,
        hasMore: false,
        narrowed: { visits: 'user:u-road' },
      },
    ]
    await device.synchronise()

    // Given a role that sees all: the answer says so, and the pull from the
    // start that follows breaks off.
    const pull = transport.pull.bind(transport)
    let calls = 0

    transport.pull = (since: number) => {
      calls += 1

      return calls === 2 ? Promise.reject(new TypeError('Failed to fetch')) : pull(since)
    }
    transport.pulls = [{ changes: [], cursor: 4, hasMore: false, narrowed: { visits: 'all' } }]
    await device.synchronise()

    expect(transport.asked).toEqual([0, 4])
    expect(device.holdsAll('visits')).toBe(false)
    device.stop()

    // Not after a start either, and not between two pages of the next pull.
    const again = await startOn('holds-all-later')
    const seen: boolean[] = []

    expect(again.holdsAll('visits')).toBe(false)

    transport.pull = (since: number) => {
      seen.push(again.holdsAll('visits'))

      return pull(since)
    }
    transport.pulls = [
      {
        changes: [{ entity: 'visits', rows: [theirs] }],
        cursor: 7,
        hasMore: true,
        narrowed: { visits: 'all' },
      },
      {
        changes: [{ entity: 'visits', rows: [mine] }],
        cursor: 9,
        hasMore: false,
        narrowed: { visits: 'all' },
      },
    ]
    await again.synchronise()

    expect(seen).toEqual([false, false])
    expect(again.holdsAll('visits')).toBe(true)
    expect(again.list('visits').map((entry) => entry['id'])).toEqual(['v-1', 'v-2'])
  })
})

describe('an exchange with the server', () => {
  let transport: Recorded

  beforeEach(() => {
    transport = new Recorded()
  })

  /**
   * Between sending and fetching back (#181). The outbox lets go of an
   * operation when the server answers, and the row arrives only with the pull
   * after that; a pull held up here is a slow mobile network.
   */
  describe('between sending and the pull that brings the rows back', () => {
    function holdThePull(): () => void {
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const pull = transport.pull.bind(transport)

      transport.pull = async (since: number) => {
        await held

        return pull(since)
      }

      return release
    }

    it('keeps a record made here in view, and no longer as waiting', async () => {
      const client = await start(transport)
      const release = holdThePull()
      const made = await client.create('shelves', { name: 'Hall', kind: 'wood' })

      if (made.outcome !== 'queued') {
        throw new Error('The shelf was refused on the device.')
      }

      // Answered and out of the outbox, with the pull still on its way.
      await vi.waitFor(() => {
        expect(client.status().pending).toBe(0)
      })

      expect(client.isPending('shelves', made.id)).toBe(false)
      expect(client.get('shelves', made.id)?.['name']).toBe('Hall')
      expect(client.list('shelves').map((record) => record['id'])).toEqual([made.id])

      transport.pulls = [
        {
          changes: [
            { entity: 'shelves', rows: [row({ id: made.id, name: 'Hall', kind: 'wood' })] },
          ],
          cursor: 2,
          hasMore: false,
        },
      ]
      release()
      await client.synchronise()

      expect(client.list('shelves').map((record) => record['name'])).toEqual(['Hall'])
    })

    it('keeps a changed value, instead of showing the old one until the pull', async () => {
      const client = await start(transport)

      await holding(client, transport, {
        entity: 'parcels',
        rows: [row({ id: 'p-1', title: 'For the hall' })],
      })

      holdThePull()
      await client.update('parcels', 'p-1', { title: 'For the hall, left' })

      // Answered and out of the outbox, with the pull still on its way.
      await vi.waitFor(() => {
        expect(client.status().pending).toBe(0)
      })

      expect(client.get('parcels', 'p-1')?.['title']).toBe('For the hall, left')
    })

    it('shows nothing of an operation the server did not apply', async () => {
      const client = await start(transport)

      await holding(client, transport, {
        entity: 'parcels',
        rows: [row({ id: 'p-1', title: 'For the hall' })],
      })

      transport.receipts = (operations) =>
        operations.map((operation) => ({
          operationId: operation.id,
          outcome: 'conflict' as const,
          reason: 'changed_elsewhere' as const,
          fields: ['title'],
        }))
      holdThePull()
      await client.update('parcels', 'p-1', { title: 'For the hall, left' })

      // Answered and out of the outbox, with the pull still on its way.
      await vi.waitFor(() => {
        expect(client.status().pending).toBe(0)
      })

      expect(client.get('parcels', 'p-1')?.['title']).toBe('For the hall')
    })
  })

  it('empties the outbox for every operation it got a receipt for', async () => {
    const client = await start(transport)

    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    await client.synchronise()

    expect(client.status().pending).toBe(0)
    expect(client.status().state).toBe('synced')
  })

  it('takes a refused operation off the outbox and goes back to what the server holds', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'parcels',
      rows: [row({ id: 'p-1', title: 'For the hall', state: 'open' })],
    })

    transport.receipts = (operations) =>
      operations.map((operation) => ({
        operationId: operation.id,
        outcome: 'conflict' as const,
        reason: 'changed_elsewhere',
        fields: ['title'],
      }))
    transport.open = [{ id: 'k-1', entity: 'parcels', recordId: 'p-1' } as unknown as SyncConflict]

    await client.update('parcels', 'p-1', { title: 'For the hall, left' })

    expect(client.get('parcels', 'p-1')?.['title']).toBe('For the hall, left')

    await client.synchronise()

    // This is why the outbox is laid over the server state instead of written
    // into it. The server refused, so nothing about the record changed there
    // and the next delta brings nothing down. Written into the local copy, the
    // change would sit on the screen as a value that exists nowhere else, for
    // ever, and no synchronisation would ever correct it.
    expect(client.get('parcels', 'p-1')?.['title']).toBe('For the hall')
    expect(client.status().pending).toBe(0)
    expect(client.status().state).toBe('conflict')
    expect(client.status().conflicts).toHaveLength(1)
  })

  it('corrects master data at its own route, not through the outbox', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'shelves',
      rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
    })

    const saved = await client.update('shelves', 's-1', { name: 'Hall, left' })

    // `change: 'never'` in the policy means "not without a connection", not
    // "never". Reading it the other way leaves nobody able to correct an
    // address at all, which is what it did until this test existed.
    expect(saved.outcome).toBe('queued')
    expect(writer.patched).toEqual([
      { entity: 'shelves', id: 's-1', values: { name: 'Hall, left' } },
    ])
    expect(client.status().pending).toBe(0)
  })

  /**
   * A form hands back every field, and the route writes what it is sent
   * without a version to compare (opengewerk-haustechnik#31). Sent whole, a
   * change to one field put back what somebody else had changed in another
   * since the form was opened.
   */
  it('sends a route only the fields that differ from what the device holds', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'shelves',
      rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
    })

    // The whole form, with the kind as the device holds it.
    await client.update('shelves', 's-1', { name: 'Hall, left', kind: 'wood' })

    expect(writer.patched).toEqual([
      { entity: 'shelves', id: 's-1', values: { name: 'Hall, left' } },
    ])

    // Nothing that differs is nothing to send.
    const unchanged = await client.update('shelves', 's-1', { name: 'Hall', kind: 'wood' })

    expect(unchanged.outcome).toBe('queued')
    expect(writer.patched).toHaveLength(1)
  })

  it('removes master data at its own route as well', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'shelves',
      rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
    })

    expect((await client.remove('shelves', 's-1')).outcome).toBe('queued')
    expect(writer.removed).toEqual(['shelves/s-1'])
    expect(transport.sent).toEqual([])
  })

  it('writes what the work produced through the outbox, not at a route', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'notes',
      rows: [row({ id: 'n-1', title: 'Shelf by the door', kind: 'remark' })],
    })

    await client.update('notes', 'n-1', { title: 'Shelf by the window' })

    expect(writer.patched).toEqual([])
    expect(transport.sent.at(-1)?.[0]?.entity).toBe('notes')
  })

  it('keeps asking as long as the server says there is more', async () => {
    const client = await start(transport)

    transport.pulls = [
      {
        changes: [{ entity: 'shelves', rows: [row({ id: 's-1', name: 'A' })] }],
        cursor: 1,
        hasMore: true,
      },
      {
        changes: [{ entity: 'shelves', rows: [row({ id: 's-2', name: 'B' })] }],
        cursor: 2,
        hasMore: false,
      },
    ]

    await client.synchronise()

    expect(client.list('shelves')).toHaveLength(2)
  })

  it('ignores a kind of record this build has no screen for', async () => {
    const client = await start(transport)

    // An older client talking to a newer server is the ordinary case during an
    // update, not a fault. It has nothing to show those rows on.
    await holding(client, transport, { entity: 'ledgers', rows: [row({ id: 'z-1' })] })

    expect(client.status().trouble).toBeNull()
    expect(client.status().state).toBe('synced')
  })

  describe('a round asked for while an exchange is under way (#572)', () => {
    /** A push that hangs until the test lets it fail, then pushes as usual. */
    function hangTheFirstPush(): { fail: () => void; pushes: () => number } {
      let fail: () => void = () => undefined
      const hanging = new Promise<never>((_resolve, reject) => {
        fail = () => {
          reject(new TypeError('Failed to fetch'))
        }
      })
      const push = transport.push.bind(transport)
      let pushes = 0

      transport.push = (deviceId: string, operations: readonly Operation[]) => {
        pushes += 1

        return pushes === 1 ? hanging : push(deviceId, operations)
      }

      return { fail, pushes: () => pushes }
    }

    it('takes place after that exchange failed, when the network came back meanwhile', async () => {
      const client = await start(transport)
      const first = hangTheFirstPush()

      await client.create('shelves', { name: 'Hall', kind: 'wood' })
      await vi.waitFor(() => {
        expect(first.pushes()).toBe(1)
      })

      // The network comes back while the push still hangs, and the push
      // fails only afterwards.
      globalThis.dispatchEvent(new Event('online'))
      first.fail()

      await vi.waitFor(() => {
        expect(client.status().pending).toBe(0)
      })
      expect(first.pushes()).toBe(2)
      expect(client.status().trouble).toBeNull()
    })

    it('is one more round after a refusal and no more, so a refusal is no loop', async () => {
      // The entry starts an exchange, and the button asks again while it runs.
      // Both rounds are refused; nothing asks for a third.
      const client = await start(transport)
      let pushes = 0
      const push = transport.push.bind(transport)

      transport.push = (deviceId: string, operations: readonly Operation[]) => {
        pushes += 1

        return push(deviceId, operations)
      }
      transport.refuse = new RequestRefused(400, 'Unbekanntes Feld: quatsch')

      await client.create('shelves', { name: 'Hall', kind: 'wood' })
      await client.synchronise()

      expect(pushes).toBe(2)
      expect(client.status().pending).toBe(1)
      expect(client.status().trouble).toBe('Unbekanntes Feld: quatsch')
    })
  })

  it('holds a new version of the application back while the outbox is on its way, and no longer (opengewerk-haustechnik#465)', async () => {
    const client = await start(transport)
    const push = transport.push.bind(transport)
    let send: () => void = () => undefined

    transport.push = (deviceId: string, operations: readonly Operation[]) =>
      new Promise((resolve, reject) => {
        send = () => {
          push(deviceId, operations).then(resolve, reject)
        }
      })

    expect(updatesHeld()).toBe(false)

    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    await vi.waitFor(() => {
      expect(updatesHeld()).toBe(true)
    })

    send()

    await vi.waitFor(() => {
      expect(client.status().pending).toBe(0)
    })
    expect(updatesHeld()).toBe(false)

    // A round that fails lets go as well.
    transport.push = push
    transport.refuse = new TypeError('Failed to fetch')
    await client.create('shelves', { name: 'Hof', kind: 'wood' })
    await client.synchronise()

    expect(client.status().pending).toBe(1)
    expect(updatesHeld()).toBe(false)
  })

  it('says what went wrong rather than looking synchronised', async () => {
    const client = await start(transport)

    transport.refuse = new RequestRefused(400, 'Unbekanntes Feld: quatsch')
    await client.synchronise()

    expect(client.status().trouble).toBe('Unbekanntes Feld: quatsch')
    expect(client.status().state).toBe('offline')
  })

  describe('refused with a session that is still good (#254)', () => {
    const untrusted =
      'Diese Anfrage kommt von einer fremden Adresse. Sie wird nur von der Adresse ' +
      'angenommen, unter der die Instanz erreichbar ist (TRUSTED_ORIGINS).'

    async function watched() {
      const signedOut = vi.fn()
      const client = await Client.start({
        store: await openLocalStore(`t${String((counter += 1))}`),
        transport,
        writer,
        rules,
        deviceId: 'device',
        entities,
        onSignedOut: signedOut,
      })

      return { client, signedOut }
    }

    it('stays open over a 403 and shows the sentence it came with', async () => {
      const { client, signedOut } = await watched()

      transport.refuse = new RequestRefused(403, untrusted)
      await client.synchronise()

      expect(signedOut).not.toHaveBeenCalled()
      expect(client.status().trouble).toBe(untrusted)
    })

    it('takes a 401 for the end of the session', async () => {
      const { client, signedOut } = await watched()

      transport.refuse = new RequestRefused(401, 'Keine gültige Anmeldung.')
      await client.synchronise()

      expect(signedOut).toHaveBeenCalledOnce()
      expect(client.status().trouble).toBe('Die Anmeldung ist abgelaufen.')
    })

    it('gives a refused direct write the reason the server gave, not a missing network', async () => {
      const { client, signedOut } = await watched()
      const missing = 'Regale ändern darf dieser Zugang nicht.'

      await holding(client, transport, {
        entity: 'shelves',
        rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
      })
      writer.refuse = new RequestRefused(403, missing)

      const tried = await client.update('shelves', 's-1', { name: 'Hall, left' })

      expect(signedOut).not.toHaveBeenCalled()
      expect(tried.outcome === 'refused' ? refusalFor(tried) : null).toBe(missing)

      writer.refuse = new TypeError('Failed to fetch')

      const offline = await client.update('shelves', 's-1', { name: 'Hall, left' })

      expect(offline.outcome === 'refused' ? refusalFor(offline) : null).toBe(
        refusalText.online_only,
      )
    })

    it('takes a 401 at a direct write for the end of the session as well', async () => {
      const { client, signedOut } = await watched()

      await holding(client, transport, {
        entity: 'shelves',
        rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
      })
      writer.refuse = new RequestRefused(401, 'Keine gültige Anmeldung.')

      await client.update('shelves', 's-1', { name: 'Hall, left' })

      expect(signedOut).toHaveBeenCalledOnce()
    })
  })

  describe('the kind of what went wrong (#545)', () => {
    // The sentence is for people. The places that say something of their own,
    // "Keine Verbindung" under the exchange and "Offline" on site, ask the
    // kind: waiting for a network cures only one of the three.
    const noRight = 'Abgleichen darf dieser Zugang nicht.'

    it('is that nobody answered when the exchange finds no server', async () => {
      const client = await start(transport)

      transport.refuse = new TypeError('Failed to fetch')
      await client.synchronise()

      expect(client.status().troubleKind).toBe('unreachable')
      expect(noConnection(client.status())).toBe(true)
      expect(exchangeRefusal(client.status())).toBeNull()
    })

    it('is that the server refused the exchange when it answered so, with its sentence', async () => {
      const client = await start(transport)

      transport.refuse = new RequestRefused(403, noRight)
      await client.synchronise()

      expect(client.status().troubleKind).toBe('exchange_refused')
      // A connection there is, and "sobald wieder Netz da ist" would be wrong.
      expect(noConnection(client.status())).toBe(false)
      expect(exchangeRefusal(client.status())).toBe(noRight)
    })

    it('counts a session that ran out as an answer as well', async () => {
      const client = await start(transport)

      transport.refuse = new RequestRefused(401, 'Keine gültige Anmeldung.')
      await client.synchronise()

      expect(client.status().troubleKind).toBe('exchange_refused')
      expect(noConnection(client.status())).toBe(false)
    })

    it('keeps a change refused at its route apart from the exchange', async () => {
      const client = await start(transport)

      await holding(client, transport, {
        entity: 'shelves',
        rows: [row({ id: 's-1', name: 'Hall', kind: 'wood' })],
      })
      writer.refuse = new RequestRefused(403, 'Regale ändern darf dieser Zugang nicht.')
      await client.update('shelves', 's-1', { name: 'Hall, left' })

      // The exchange went through a moment ago and is not what was refused.
      expect(client.status().troubleKind).toBe('change_refused')
      expect(noConnection(client.status())).toBe(false)
      expect(exchangeRefusal(client.status())).toBeNull()

      writer.refuse = new TypeError('Failed to fetch')
      await client.update('shelves', 's-1', { name: 'Hall, left' })

      expect(client.status().troubleKind).toBe('unreachable')
    })

    it('is none while nothing went wrong, and none again once an exchange goes through', async () => {
      const client = await start(transport)

      expect(client.status().troubleKind).toBeNull()

      transport.refuse = new RequestRefused(403, noRight)
      await client.synchronise()
      transport.refuse = null
      await client.synchronise()

      expect(client.status().trouble).toBeNull()
      expect(client.status().troubleKind).toBeNull()
      expect(exchangeRefusal(client.status())).toBeNull()
    })
  })

  it('hides a record the server has marked as deleted', async () => {
    const client = await start(transport)

    await holding(client, transport, {
      entity: 'shelves',
      rows: [row({ id: 's-1', name: 'Hall', deletedAt: '2026-10-02T10:00:00.000Z' })],
    })

    expect(client.list('shelves')).toEqual([])
    expect(client.get('shelves', 's-1')).toBeNull()
  })

  it('takes a decided conflict off the list', async () => {
    const client = await start(transport)

    transport.open = [{ id: 'k-1', entity: 'parcels', recordId: 'p-1' } as unknown as SyncConflict]
    await client.synchronise()

    expect(client.status().state).toBe('conflict')

    await client.resolveConflict('k-1')

    expect(transport.resolved).toEqual(['k-1'])
    expect(client.status().conflicts).toEqual([])
    expect(client.status().state).toBe('synced')
  })
})

describe('a large outbox (#202)', () => {
  let transport: Recorded

  beforeEach(() => {
    transport = new Recorded()
  })

  /** Four hundred thousand characters: two fit in a transmission, three do not. */
  const long = 'x'.repeat(400_000)

  function operation(name: string, recordedAt: string): Operation {
    return {
      id: operationId(`op-${name}`),
      entity: 'shelves',
      recordId: `s-${name}`,
      kind: 'create',
      baseVersion: null,
      patches: [{ field: 'name', from: null, to: name }],
      recordedAt: new Date(recordedAt),
      deviceId: 'device' as Operation['deviceId'],
    }
  }

  /** Three new shelves written without a network, each longer than most transmissions. */
  async function writtenInTheCellar(client: SyncClient): Promise<void> {
    transport.refuse = new TypeError('Failed to fetch')

    for (const name of ['Erste', 'Zweite', 'Dritte']) {
      await client.create('shelves', { name: `${name} ${long}`, kind: 'wood' })
    }

    // Until the round the last entry started has failed, without a network.
    // A failed round asks for no other, so an exchange asked for while it
    // runs would end with it.
    await client.synchronise()
    transport.refuse = null
  }

  it('is cut where the next operation would not fit, and never reordered', () => {
    const first = operation('a', '2026-10-02T08:00:00Z')
    const second = operation('b', '2026-10-02T08:01:00Z')
    const third = operation('c', '2026-10-02T08:02:00Z')
    const size = JSON.stringify(first).length

    expect(inTransmissions([first, second, third], size * 2)).toEqual([[first, second], [third]])
    // One larger than a part goes alone rather than not at all.
    expect(inTransmissions([first, second], size - 1)).toEqual([[first], [second]])
    expect(inTransmissions([])).toEqual([])
  })

  /**
   * The server takes a number of operations per transmission, however small
   * they are, and refuses more with 413; an outbox of many small changes would
   * otherwise stay on the device for good.
   */
  it('is cut after the most operations a transmission carries, as well', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      operation(String(index), '2026-10-02T08:00:00Z'),
    )

    expect(inTransmissions(many, largestTransmission, 2).map((part) => part.length)).toEqual([
      2, 2, 1,
    ])
    expect(inTransmissions(many).map((part) => part.length)).toEqual([5])
    expect(mostTransmittedOperations).toBe(1000)
  })

  it('goes out in parts, in the order it was written', async () => {
    const client = await start(transport)

    await writtenInTheCellar(client)
    await client.synchronise()

    expect(transport.sent.map((part) => part.length)).toEqual([2, 1])
    expect(transport.sent.flat().map((sent) => String(sent.patches[0]?.to).split(' ')[0])).toEqual([
      'Erste',
      'Zweite',
      'Dritte',
    ])
    expect(client.status().pending).toBe(0)
  })

  it('keeps what a part brought in when a later part is refused over one operation', async () => {
    const client = await start(transport)

    await writtenInTheCellar(client)
    transport.refusing = (operations) => {
      const named = operations.find((sent) => String(sent.patches[0]?.to).startsWith('Dritte'))

      return named
        ? new RequestRefused(400, 'Unbekanntes Feld: quatsch', {
            statusCode: 400,
            message: 'Unbekanntes Feld: quatsch',
            operationId: named.id,
          })
        : null
    }
    await client.synchronise()

    // The first part is in and out of the outbox; the third waits with its sentence.
    expect(transport.sent.map((part) => part.length)).toEqual([2])
    expect(client.status().pending).toBe(1)
    expect(String(client.status().refused?.operation.patches[0]?.to)).toMatch(/^Dritte /)
  })
})

/**
 * An operation the server refuses outright, over which it refuses the whole
 * transmission and names it (#120). Before, the device sent the same stack
 * again at every exchange, got the same answer and pulled nothing, and there
 * was no way to let the one entry go.
 */
describe('an operation the server refuses outright', () => {
  let transport: Recorded

  beforeEach(() => {
    transport = new Recorded()
  })

  /** The answer the server gives, naming the first operation that writes this. */
  function refusingWhat(field: string, value: string) {
    return (operations: readonly Operation[]) => {
      const named = operations.find((operation) =>
        operation.patches.some((patch) => patch.field === field && patch.to === value),
      )

      return named
        ? new RequestRefused(400, 'Unbekanntes Feld: quatsch', {
            statusCode: 400,
            message: 'Unbekanntes Feld: quatsch',
            operationId: named.id,
          })
        : null
    }
  }

  it('is held with its sentence, and the device goes on pulling', async () => {
    const client = await start(transport)

    transport.refusing = refusingWhat('name', 'Kaputt')
    transport.pulls = [
      {
        changes: [{ entity: 'parcels', rows: [row({ id: 'p-1', title: 'For tomorrow' })] }],
        cursor: 5,
        hasMore: false,
      },
    ]

    await client.create('shelves', { name: 'Kaputt', kind: 'wood' })
    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    await client.synchronise()

    const { refused } = client.status()

    expect(client.status().state).toBe('refused')
    expect(refused?.message).toBe('Unbekanntes Feld: quatsch')
    expect(refused?.operation.patches).toContainEqual({ field: 'name', from: null, to: 'Kaputt' })

    // Nothing behind it got out, and nothing was lost: both entries wait.
    expect(transport.sent).toEqual([])
    expect(client.status().pending).toBe(2)

    // The work of the next day still arrives. Before, a refused push ended the
    // exchange, and the pull behind it never ran.
    expect(client.get('parcels', 'p-1')?.['title']).toBe('For tomorrow')
  })

  it('lets a person let it go, and then sends what waited behind it', async () => {
    const client = await start(transport)

    transport.refusing = refusingWhat('name', 'Kaputt')

    await client.create('shelves', { name: 'Kaputt', kind: 'wood' })
    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    await client.synchronise()

    const refused = client.status().refused

    expect(refused).not.toBeNull()

    await client.discard(refused?.operation.id ?? operationId('none'))

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.map((operation) => operation.patches)).toEqual([
      [
        { field: 'name', from: null, to: 'Hall' },
        { field: 'kind', from: null, to: 'wood' },
      ],
    ])
    expect(client.status().state).toBe('synced')
    expect(client.status().refused).toBeNull()
    expect(client.status().pending).toBe(0)
  })

  it('takes the later changes of a record with it when it let go of its create', async () => {
    const client = await start(transport)

    transport.refusing = refusingWhat('title', 'Shelf')

    const made = await client.create('notes', { title: 'Shelf' })

    expect(made.outcome).toBe('queued')

    await client.update('notes', made.outcome === 'queued' ? made.id : '', {
      title: 'Shelf by the door',
    })
    await client.create('notes', { title: 'Rack' })
    await client.synchronise()

    await client.discard(client.status().refused?.operation.id ?? operationId('none'))

    // The change to a record that never reached the server can land nowhere.
    // Sent, it would only have come back as a conflict about nothing.
    expect(transport.sent.flat().map((operation) => operation.patches[0]?.to)).toEqual(['Rack'])
    expect(client.status().pending).toBe(0)
  })

  it('keeps an answer that names nothing this device holds as trouble, as before', async () => {
    const client = await start(transport)

    transport.refusing = () =>
      new RequestRefused(400, 'Die Liste der Vorgänge fehlt.', { statusCode: 400 })

    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    await client.synchronise()

    // A refusal without a name comes from a client speaking the wrong protocol,
    // which the next build fixes. There is no entry to let go of.
    expect(client.status().refused).toBeNull()
    expect(client.status().trouble).toBe('Die Liste der Vorgänge fehlt.')
    expect(client.status().state).toBe('offline')
  })
})

/**
 * State that belongs to a device alone: a stretch of time that is still
 * running is the case it exists for. It becomes a record when it ends, and
 * until then it must survive a locked phone and never travel.
 */
describe('what a device keeps for itself', () => {
  async function keeping(name: string, keeps: readonly string[] = ['timer']) {
    const transport = new Recorded()
    const client = await Client.start({
      store: await openLocalStore(name),
      transport,
      writer: new Writing(),
      rules,
      deviceId: 'device',
      entities,
      keeps,
      onSignedOut: () => {},
    })

    return { client, transport }
  }

  it('is there after a restart, and gone once it was let go', async () => {
    const { client } = await keeping('kept')

    expect(client.kept('timer')).toBeNull()

    await client.keep('timer', '{"since":"08:00"}')

    expect(client.kept('timer')).toBe('{"since":"08:00"}')
    client.stop()

    const { client: again } = await keeping('kept')

    expect(again.kept('timer')).toBe('{"since":"08:00"}')

    await again.keep('timer', null)
    again.stop()

    expect((await keeping('kept')).client.kept('timer')).toBeNull()
  })

  it('is found where a build before this one stored it', async () => {
    // Stored under the name itself, among the bookkeeping of the local store.
    // A device that was updated while something was kept finds it again.
    const store = await openLocalStore('kept-before')

    await store.writeMeta('timer', '{"since":"07:30"}')
    store.close()

    expect((await keeping('kept-before')).client.kept('timer')).toBe('{"since":"07:30"}')
  })

  it('tells whoever watches the client that it changed', async () => {
    const { client } = await keeping('kept-watched')
    const before = client.version()
    let told = 0

    client.subscribe(() => {
      told += 1
    })
    await client.keep('timer', 'running')

    expect(told).toBe(1)
    expect(client.version()).toBeGreaterThan(before)
  })

  it('never travels', async () => {
    const { client, transport } = await keeping('kept-here')

    await client.keep('timer', 'running')
    await client.synchronise()

    expect(transport.sent).toEqual([])
    expect(client.status().pending).toBe(0)
  })

  it('is refused under a name the client was not started with', async () => {
    // Written, it would be there until the page is loaded again and then
    // gone: the start reads back what it was told to.
    const { client } = await keeping('kept-unnamed')

    expect(() => client.kept('clock')).toThrow(/not started to keep this: clock/)
    await expect(client.keep('clock', 'x')).rejects.toThrow(/not started to keep this: clock/)
  })

  it('cannot take a name the client keeps its own bookkeeping under', async () => {
    for (const name of ['cursor', 'entities', 'narrowed', 'narrowed-settled']) {
      await expect(keeping(`kept-${name}`, [name]), name).rejects.toThrow(
        /keeps its own bookkeeping under this name/,
      )
    }
  })
})

describe('the account of a transmission', () => {
  it('signs a tab out with changes waiting, over the 409 of the server once another account took its store over', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    let signedOut = 0
    let ben: Awaited<ReturnType<typeof openLocalStore>> | null = null

    writer = new Writing()

    const client = await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })

    transport.refuse = new TypeError('Failed to fetch')
    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    transport.refuse = null
    // Ben takes the store over, and the server answers the change waiting for
    // Anna that another account is signed in.
    transport.push = async () => {
      ben = await openLocalStore(tenant, 'ben')

      throw new RequestRefused(409, 'Diese Änderungen gehören zu einem anderen Konto.', {
        code: 'other_account',
      })
    }

    await client.synchronise()

    expect(signedOut).toBe(1)
    expect(client.status().pending).toBe(1)
    ;(ben as { close(): void } | null)?.close()
  })

  it('writes nothing at a route for a tab whose store another account took over', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    let signedOut = 0

    writer = new Writing()

    const client = await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })
    const ben = await openLocalStore(tenant, 'ben')

    // A shelf changes with a connection only, straight at its route.
    await client.update('shelves', 's-1', { name: 'Keller' }).catch(() => undefined)

    expect(writer.patched).toEqual([])
    expect(signedOut).toBe(1)
    ben.close()
  })

  /**
   * Before another tab takes the store over (opengewerk#882): the write at a
   * route names the person of the store, and the server's answer that another
   * account is signed in ends the client as the exchange does.
   */
  it('names the person of its store at a route, and signs out when the server says another is signed in', async () => {
    const tenant = `t${String((counter += 1))}`
    let signedOut = 0

    writer = new Writing()

    const client = await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport: new Recorded(),
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })

    await client.update('shelves', 's-1', { name: 'Keller' })
    await client.remove('shelves', 's-1')

    expect(writer.accounts).toEqual(['anna', 'anna'])
    expect(signedOut).toBe(0)

    writer.refuse = new RequestRefused(
      409,
      'Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet.',
      {
        code: 'other_account',
      },
    )

    const refused = await client.update('shelves', 's-1', { name: 'Dachboden' })

    expect(refused.outcome).toBe('refused')
    expect(signedOut).toBe(1)
  })

  it('stays signed in over any other refusal at a route', async () => {
    const tenant = `t${String((counter += 1))}`
    let signedOut = 0

    writer = new Writing()

    const client = await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport: new Recorded(),
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })

    writer.refuse = new RequestRefused(409, 'Der Name ist schon vergeben.', { code: 'in_use' })
    await client.update('shelves', 's-1', { name: 'Keller' })

    expect(signedOut).toBe(0)
  })

  it('pulls for the person the store was opened for, and keeps nothing a pull for another brings', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    const accounts: (string | undefined)[] = []
    let signedOut = 0
    let other = false

    transport.pull = (since: number, account?: string) => {
      accounts.push(account)

      // Ben signed in in another tab, and his cookie goes with every request
      // of this one, before his tab has opened the store.
      return other
        ? Promise.reject(
            new RequestRefused(
              409,
              'Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet.',
              {
                code: 'other_account',
              },
            ),
          )
        : Promise.resolve({ changes: [], cursor: since, hasMore: false })
    }
    writer = new Writing()

    const client = await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })

    await client.synchronise()
    other = true
    await client.synchronise()

    expect(new Set(accounts)).toEqual(new Set(['anna']))
    expect(signedOut).toBe(1)
    expect(client.status().trouble).toBe(
      'Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet.',
    )
  })

  it('signs a tab out once another account has taken its store over', async () => {
    const tenant = `t${String((counter += 1))}`
    let signedOut = 0

    writer = new Writing()

    const client = await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport: new Recorded(),
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })
    const ben = await openLocalStore(tenant, 'ben')

    await client.synchronise()

    expect(signedOut).toBe(1)
    expect(client.status().trouble).toBe(
      'Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet.',
    )
    ben.close()
  })

  it('is the person the store was opened for, which the server holds against the session', async () => {
    const transport = new Recorded()
    const store = await openLocalStore(`t${String((counter += 1))}`, 'anna')
    const accounts: (string | undefined)[] = []
    const push = transport.push.bind(transport)

    transport.push = (deviceId: string, operations: readonly Operation[], account?: string) => {
      accounts.push(account)

      return push(deviceId, operations)
    }
    writer = new Writing()

    const client = await Client.start({
      store,
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {},
    })

    await client.create('shelves', { name: 'Hall', kind: 'wood' })
    await client.synchronise()

    expect(accounts.length).toBeGreaterThan(0)
    expect(new Set(accounts)).toEqual(new Set(['anna']))
  })
})

describe('what waits on a device for nobody', () => {
  /** A change queued by a version that did not yet say whose it is. */
  async function queuedForNobody(tenant: string): Promise<void> {
    const before = await openLocalStore(tenant)

    await before.queue({
      id: operationId('op-before'),
      entity: 'notes',
      recordId: 'n-before',
      kind: 'create',
      baseVersion: null,
      patches: [{ field: 'text', from: null, to: 'Leiter im Flur' }],
      recordedAt: new Date('2026-10-12T07:52:00Z'),
      deviceId: 'device',
    })
    before.close()
  }

  async function startFor(tenant: string, transport: SyncTransport, onSignedOut = () => {}) {
    writer = new Writing()

    return await Client.start({
      store: await openLocalStore(tenant, 'anna'),
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut,
    })
  }

  it('goes out only once the person signed in says they made it, and then under their account', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    const accounts: (string | undefined)[] = []
    const push = transport.push.bind(transport)

    transport.push = (deviceId: string, operations: readonly Operation[], account?: string) => {
      accounts.push(account)

      return push(deviceId, operations)
    }

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport)

    await client.synchronise()

    expect(transport.sent.flat()).toEqual([])
    expect(client.status().unowned.operations.map((operation) => operation.id)).toEqual([
      'op-before',
    ])

    await client.adoptUnowned()

    expect(transport.sent.flat().map((operation) => operation.id)).toEqual(['op-before'])
    expect(accounts).toEqual(['anna'])
    expect(client.status().unowned).toEqual({ operations: [], files: [] })
    expect(client.status().pending).toBe(0)
  })

  it('leaves the device when let go, and none of it goes out', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport)

    await client.discardUnowned()
    await client.synchronise()

    expect(client.status().unowned).toEqual({ operations: [], files: [] })
    expect(transport.sent.flat()).toEqual([])
    expect(await waitingIn(tenant)).toBe(0)
  })

  it('is taken on by nobody from a tab whose store another account took over', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    let signedOut = 0

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport, () => {
      signedOut += 1
    })
    const ben = await openLocalStore(tenant, 'ben')

    await client.adoptUnowned()

    expect(signedOut).toBe(1)
    expect(transport.sent.flat()).toEqual([])
    expect((await ben.readUnowned()).operations.map((operation) => operation.id)).toEqual([
      'op-before',
    ])
    ben.close()
  })

  /** A change a tab of a version before queues for nobody after the list was shown. */
  async function queuedLate(tenant: string): Promise<void> {
    const late = await openLocalStore(tenant)

    await late.queue({
      id: operationId('op-unseen'),
      entity: 'notes',
      recordId: 'n-unseen',
      kind: 'create',
      baseVersion: null,
      patches: [{ field: 'text', from: null, to: 'Nicht gezeigt' }],
      recordedAt: new Date('2026-10-12T07:53:00Z'),
      deviceId: 'device',
    })
    late.close()
  }

  it('goes out as far as the list showed, and not with what was queued for nobody since', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport)

    await queuedLate(tenant)
    await client.adoptUnowned()

    expect(transport.sent.flat().map((operation) => operation.id)).toEqual(['op-before'])
    expect(client.status().unowned.operations.map((operation) => operation.id)).toEqual([
      'op-unseen',
    ])
  })

  it('is let go as far as the list showed, and keeps what was queued for nobody since', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport)

    await queuedLate(tenant)
    await client.discardUnowned()

    expect(client.status().unowned.operations.map((operation) => operation.id)).toEqual([
      'op-unseen',
    ])
  })

  it('is let go by nobody from a tab whose store another account took over', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    let signedOut = 0

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport, () => {
      signedOut += 1
    })
    const ben = await openLocalStore(tenant, 'ben')

    await client.discardUnowned()

    expect(signedOut).toBe(1)
    expect((await ben.readUnowned()).operations.map((operation) => operation.id)).toEqual([
      'op-before',
    ])
    ben.close()
  })

  it('signs a tab out whose store another account takes over right after it took the list on', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    const store = await openLocalStore(tenant, 'anna')
    let reads = 0
    let signedOut = 0

    await queuedForNobody(tenant)
    writer = new Writing()

    // The second read of the list comes after another account took the store over.
    const client = await Client.start({
      store: {
        ...store,
        readUnowned: () =>
          (reads += 1) > 1 ? Promise.reject(new StoreTakenOver()) : store.readUnowned(),
      },
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {
        signedOut += 1
      },
    })

    await client.adoptUnowned()

    expect(signedOut).toBe(1)
    expect(client.status().unowned).toEqual({ operations: [], files: [] })
    expect(transport.sent.flat()).toEqual([])
  })

  it('takes the list on with what the store says it recorded, and reads nothing more for it', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()
    const store = await openLocalStore(tenant, 'anna')
    let started = false

    await queuedForNobody(tenant)
    writer = new Writing()

    // After the start, the outbox and the count of files cannot be read.
    const unreadable = () =>
      Promise.reject(new Error('Die lokale Ablage hat den Vorgang abgebrochen.'))
    const client = await Client.start({
      store: {
        ...store,
        readOutbox: () => (started ? unreadable() : store.readOutbox()),
        countWaitingFiles: () => (started ? unreadable() : store.countWaitingFiles()),
      },
      transport,
      writer,
      rules,
      deviceId: 'device',
      entities,
      onSignedOut: () => {},
    })

    started = true
    await client.adoptUnowned()

    expect(transport.sent.flat().map((operation) => operation.id)).toEqual(['op-before'])
    expect(client.status().unowned).toEqual({ operations: [], files: [] })
  })

  it('sends nothing another tab let go of after the list was shown', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport)
    const other = await openLocalStore(tenant, 'anna')

    // Another tab of Anna shows the same card, and lets it go.
    await other.dropUnowned([operationId('op-before')], [])
    other.close()

    await client.adoptUnowned()

    expect(transport.sent.flat()).toEqual([])
    expect(client.status().pending).toBe(0)
  })

  it('sends nothing another account took on in between, when the store is back with this one', async () => {
    const tenant = `t${String((counter += 1))}`
    const transport = new Recorded()

    await queuedForNobody(tenant)

    const client = await startFor(tenant, transport)
    const ben = await openLocalStore(tenant, 'ben')

    await ben.adoptUnowned([operationId('op-before')], [])
    ben.close()

    // Anna signs in again in another tab; the store is hers again, and the
    // tab that showed the list clicks on it.
    const again = await openLocalStore(tenant, 'anna')

    await client.adoptUnowned()
    again.close()

    expect(transport.sent.flat()).toEqual([])
    expect(client.status().pending).toBe(0)
  })
})
