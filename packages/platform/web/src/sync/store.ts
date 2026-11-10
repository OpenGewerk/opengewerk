import { inOutboxOrder } from '@opengewerk/platform-domain'
import type { Operation, OperationId, RecordState, SyncConflict } from '@opengewerk/platform-domain'

/**
 * Where a device keeps what it knows while it has no network.
 *
 * IndexedDB and not `localStorage`: the latter is synchronous, capped at a few
 * megabytes, and stores strings, so every read of a list would parse the
 * whole list again on the main thread. Four hundred rows of one kind are not
 * a corner case here, they are a Tuesday.
 *
 * The shape is deliberately small. Records as they came off the wire, the
 * outbox, the conflicts and two pieces of bookkeeping. Anything derived is
 * derived at read time, because a derived value in here is a value that can
 * disagree with the one it came from and no migration will ever notice.
 */

/** The record as it travels: flat, and only values JSON survives unchanged. */
export type StoredRecord = RecordState

interface RecordRow {
  /** `entity` and `id` joined, so a record has one key in one store. */
  readonly key: string
  readonly entity: string
  readonly id: string
  readonly values: StoredRecord
}

interface MetaRow {
  readonly key: string
  readonly value: string | number
  /**
   * The person a value an application keeps for the device was written for
   * (`writeMeta` on a store opened for one, opengewerk#905). A sign out takes
   * their values from the store of an account signed in since (`leave`).
   */
  readonly owner?: string
}

/**
 * The bytes of a file, under their SHA-256 (#77).
 *
 * An `ArrayBuffer` and not a `Blob`: both survive IndexedDB in a browser, but
 * only the buffer survives every structured clone a test runs in, and the
 * difference is one call when a screen needs a `Blob` for an address.
 */
export interface StoredFile {
  readonly sha256: string
  readonly bytes: ArrayBuffer
  readonly mediaType: string
}

/** What the store recorded for its person when they took a list on. */
export interface AdoptedChanges {
  readonly operations: readonly OperationId[]
  readonly files: readonly string[]
}

/** A file made here that waits for its upload, without its bytes. */
export interface WaitingFile {
  readonly sha256: string
  readonly mediaType: string
  /** When the device kept it, in milliseconds since the epoch. */
  readonly since: number
}

/**
 * What waits on the device for nobody: changes and files queued before the
 * store recorded whose they are (`sendableBy`). Nobody sends them until the
 * person signed in says they made them.
 */
export interface UnownedChanges {
  readonly operations: readonly Operation[]
  readonly files: readonly WaitingFile[]
}

/** One page of a pull, as the sync client writes it down (`writePulled`). */
export interface PulledPage {
  /** The rows of each kind the page brought, of the kinds the client knows. */
  readonly changes: readonly { readonly entity: string; readonly rows: readonly StoredRecord[] }[]
  /** The cursor the pull asked from. */
  readonly from: number
  /** The cursor the page ends at. */
  readonly to: number
  /** What the answer said it narrowed the rows to, as JSON, or null where it said nothing. */
  readonly narrowed: string | null
  /**
   * What the rows add up to once this page is in (`settledKey`), on the last
   * page of a pull with a narrowing; null on any other. Written with the page,
   * so that no other tab goes back to the start in between and finds a pull
   * reported as run through over rows it let go of.
   */
  readonly settled: string | null
  /** The kinds of record the build that writes knows, as `entitiesKey` keeps them. */
  readonly entities: string
}

/**
 * What became of a page (`writePulled`): written; not written because the
 * store moved since the pull began; or not written because the store is kept
 * for other kinds of record than this build knows, of a build that knows more
 * (`newerBuild`) or of one that knows fewer and pulled since (`fewerKinds`);
 * or not written because a writer that checks nothing set the cursor since
 * the last checked write (`unchecked`, `checkedKey`).
 */
export type PageWritten = 'written' | 'moved' | 'newerBuild' | 'fewerKinds' | 'unchecked'

/** Where the pulls of the store stand, and its rows, as one transaction read them (`readPulled`). */
export interface PulledState {
  /** The cursor, or null where none is kept. */
  readonly cursor: number | null
  /** The cursor of the last checked write (`checkedKey`), or null where none is kept. */
  readonly checked: number | null
  /** The narrowing kept (`narrowedKey`), or null. */
  readonly narrowed: string | null
  /** What the rows add up to (`settledKey`), or null; empty while a pull from the start runs. */
  readonly settled: string | null
  /** The rows of each kind asked for, deleted rows included. */
  readonly rows: ReadonlyMap<string, readonly StoredRecord[]>
}

export interface LocalStore {
  /** Everything of one kind, deleted rows included. Filtering is the caller's. */
  readAll(entity: string): Promise<readonly StoredRecord[]>
  write(entity: string, records: readonly StoredRecord[]): Promise<void>
  /** Every row of one kind, gone; the outbox keeps what it holds of it. */
  drop(entity: string): Promise<void>
  /**
   * The rows of one page of a pull and the cursor it ends at, in one
   * transaction, while the store still stands where the pull began
   * (opengewerk#899): its cursor is `from`, and the narrowing it keeps is the
   * one the answer named. The tabs of a browser share the store and its
   * cursor; a tab that pulled from a cursor another tab has moved since, back
   * to the start after a change of the narrowing among them, wrote a later
   * one over rows that never arrived. Written only for the kinds of record the
   * store is kept for (`entitiesKey`), too: two tabs of two builds, one that
   * knows a kind more, would otherwise move one cursor past rows of that kind
   * for the other. Nothing is written where it answers anything but
   * `written`.
   */
  writePulled(page: PulledPage): Promise<PageWritten>
  /**
   * The store kept for the kinds of record of this build (`entities`) from
   * now on, pulled again from the start: the cursor at 0 and nothing settled,
   * in one transaction. For a build that finds the store kept for fewer
   * kinds, by an older build that pulled since and moved the cursor past rows
   * of the others.
   */
  claimPull(entities: string): Promise<void>
  /**
   * Where the pulls of the store stand for a tab that opens, and its rows of
   * the named kinds, read in the transaction that keeps the store for these
   * kinds from now on (opengewerk#899). Where the store is kept for a list
   * that holds every one of them, the list becomes theirs and the cursor
   * stands; otherwise the store is taken back for them as `claimPull` takes
   * it, the cursor at 0 and nothing settled. The answer is the state after.
   * Read and written apart, a tab of a build that knows fewer kinds wrote its
   * list and a page past rows of the others in between, and this tab went on
   * from that cursor under its own list.
   */
  beginPull(entities: readonly string[]): Promise<PulledState>
  /**
   * A pull back to the start, in one transaction: the rows of the named
   * kinds gone, the cursor at 0, nothing settled (`settledKey`), and
   * `narrowed` kept as what the rows are pulled for from now on. In one, so
   * that neither a page closed halfway nor another tab writing a page in
   * between finds a cursor with rows missing behind it.
   *
   * `before` is the narrowing the caller read and chose the kinds by. Where
   * the store keeps another by now, another tab started again in between and
   * may have written rows for kinds this one would leave (opengewerk#899):
   * nothing is written, and the answer is false. Left out, it is not asked.
   */
  restartPull(
    entities: readonly string[],
    narrowed: string,
    before?: string | null,
  ): Promise<boolean>
  /**
   * Where the pulls of the store stand and its rows of the named kinds, read
   * in one transaction (opengewerk#899). Read one by one, another tab that
   * went back to the start in between left a page with rows of one state
   * under the cursor or the narrowing of another.
   */
  readPulled(entities: readonly string[]): Promise<PulledState>

  /**
   * The account the store is kept for (`records-owner`), or null for a store
   * kept for nobody yet. A sign out asks it, and leaves the store of an
   * account signed in on the browser since to that account (opengewerk#905).
   */
  whose(): Promise<string | null>
  /** How many changes and files wait in the store for `person` alone (opengewerk#905). */
  waitingOf(person: string): Promise<number>
  /**
   * What `person` left waiting in the store, gone, while the store is kept
   * for another account, `keptFor`, in one transaction (opengewerk#905): the
   * changes and the files to send recorded for them. A sign out of `person`
   * takes these along from the store of an account signed in on the browser
   * since, and leaves the rest to that account. The answer is false, and
   * nothing is written, where the store is kept for anybody else by now or
   * `keptFor` is `person`; the sign out then deletes the store as any other.
   */
  leave(person: string, keptFor: string): Promise<boolean>

  /** What waits to be sent: of the person the store is open for, or all of it without one. */
  readOutbox(): Promise<readonly Operation[]>
  queue(operation: Operation): Promise<void>
  dequeue(ids: readonly OperationId[]): Promise<void>

  readConflicts(): Promise<readonly SyncConflict[]>
  writeConflicts(conflicts: readonly SyncConflict[]): Promise<void>
  dropConflict(id: string): Promise<void>

  readMeta(key: string): Promise<string | number | null>
  writeMeta(key: string, value: string | number): Promise<void>

  /**
   * A file kept on this device. `waiting` puts it on the list of uploads as
   * well, for a file made here that the server does not have yet; a preview
   * fetched from the server is kept without it.
   */
  keepFile(file: StoredFile, waiting: boolean): Promise<void>
  readFile(sha256: string): Promise<StoredFile | null>
  /**
   * The files made here that still have to go up, oldest first; of the
   * person the store is open for, like the outbox.
   */
  waitingFiles(): Promise<readonly StoredFile[]>
  /** How many that is, without reading a single byte of them. */
  countWaitingFiles(): Promise<number>
  /** Their hashes, without reading a single byte of them either. */
  waitingHashes(): Promise<ReadonlySet<string>>
  /** Off the list of uploads. The bytes stay, for the screens that show them. */
  fileSent(sha256: string): Promise<void>
  /**
   * A file off this device that an application fetched to keep and no longer
   * wants (opengewerk-haustechnik#348). One that still waits for its upload
   * stays, whoever asks: the server does not have it yet. True when the file
   * is gone, false when it stays or was never here.
   */
  dropFile(sha256: string): Promise<boolean>

  /**
   * The changes and files that wait here for nobody, oldest first. Nothing
   * for a store opened without an owner, whose outbox answers with all of it
   * anyway.
   */
  readUnowned(): Promise<UnownedChanges>
  /**
   * The named changes and files, recorded for the person the store is open
   * for, who said they made them: from now on they go out with theirs. Only
   * those still without a person, and only while the store is still that
   * person's (`StoreTakenOver`). Answers with what it recorded, so that the
   * caller need not read the store again to know it.
   */
  adoptUnowned(
    operations: readonly OperationId[],
    files: readonly string[],
  ): Promise<AdoptedChanges>
  /**
   * The named changes and files off this device, as signing out would take
   * them. Only those still without a person: what somebody has adopted in
   * another tab meanwhile stays theirs.
   */
  dropUnowned(operations: readonly OperationId[], files: readonly string[]): Promise<void>

  /** The person the store was opened for, whose changes it sends; none for a count before a sign out. */
  readonly owner?: string
  /** Everything of this tenant, gone. What signing out has to do. */
  clear(): Promise<void>
  close(): void
}

const recordStore = 'records'
const outboxStore = 'outbox'
const conflictStore = 'conflicts'
const metaStore = 'meta'

/** The account whose pulls the records of a store hold. */
const ownerKey = 'records-owner'

/** Where the sync client is in the changes of the server. */
export const cursorKey = 'cursor'

/** What the server last said it narrowed the rows to, as JSON. */
export const narrowedKey = 'narrowed'

/**
 * What the rows on the device were narrowed to when the last pull ran
 * through, as JSON, and empty while the pull after a change of the narrowing
 * is still under way (#444).
 */
export const settledKey = 'narrowed-settled'

/**
 * The kinds of record the build knew that last moved the cursor, as a sorted
 * list with commas.
 */
export const entitiesKey = 'entities'

/**
 * The cursor as the last checked write left it (`writePulled`,
 * `restartPull`, `claimPull`, opengewerk#899). A cursor that differs from it
 * was set by a writer that checks nothing, a tab of a build from before, which
 * may have moved it past rows of kinds it does not know. A store kept before
 * writes were checked has none, and its cursor is taken as it stands until
 * the first checked write, so that no device pulls everything again after
 * the update.
 */
export const checkedKey = 'cursor-checked'

/**
 * The narrowing the last checked write left the store with, as JSON, empty
 * for none (opengewerk#899). A tab of a build from before that went back to
 * the start for a new narrowing and pulled up to the checked cursor again
 * leaves the cursor as it was and the narrowing changed, with the rows of the
 * kinds it does not know gone.
 */
export const checkedForKey = 'cursor-checked-for'

/**
 * What the meta store holds of the pulls, and goes with the records for
 * another account. Everything else in it the application keeps for itself
 * (`SyncClient.keep`), and each such value says itself whose it is.
 */
/**
 * The narrowing the rows a section took over from the store stood under
 * (`adoptUnsectioned`, opengewerk#907), until the section starts its first
 * pull for a narrowing of its own: what changed since then goes from every
 * section that held it alike, as at any later change of the narrowing.
 */
export const adoptedKey = 'narrowed-adopted'

const pulledKeys: readonly string[] = [
  cursorKey,
  narrowedKey,
  settledKey,
  entitiesKey,
  checkedKey,
  checkedForKey,
  adoptedKey,
]
const fileStore = 'files'
const uploadStore = 'uploads'

/** The narrowing a section keeps (`narrowedKey`) by kind, or null where none is kept or it does not read. */
function narrowingIn(row: MetaRow | undefined): Readonly<Record<string, unknown>> | null {
  if (typeof row?.value !== 'string' || row.value === '') {
    return null
  }

  try {
    const read: unknown = JSON.parse(row.value)

    return typeof read === 'object' && read !== null ? (read as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A name of the meta store or a kind of record as `section` of a store keeps it (opengewerk#907). */
function within(section: string | undefined, name: string): string {
  return section === undefined ? name : `${section}/${name}`
}

/**
 * The sections of a store that began a pull (`entitiesKey`) besides
 * `section`, the part without a section as undefined (opengewerk#907).
 */
async function sectionsBesides(
  meta: IDBObjectStore,
  section: string | undefined,
): Promise<(string | undefined)[]> {
  const others: (string | undefined)[] = []

  for (const key of await promised<IDBValidKey[]>(meta.getAllKeys())) {
    const name = String(key)
    const other =
      name === entitiesKey
        ? undefined
        : name.endsWith(`/${entitiesKey}`)
          ? name.slice(0, -entitiesKey.length - 1)
          : null

    if (other !== null && other !== section) {
      others.push(other)
    }
  }

  return others
}

/** Whether a row as pulled says its record is deleted, emptied by an erasure among it. */
function deletedIn(values: StoredRecord): boolean {
  return values['deletedAt'] !== null && values['deletedAt'] !== undefined
}

/** The version a row was pulled in, or -1 for a row that names none. */
function versionOf(values: StoredRecord): number {
  return typeof values['version'] === 'number' ? values['version'] : -1
}

/** The kinds of record a list as `entitiesKey` keeps it names; none for nothing kept. */
function kindsOf(list: string | number | undefined): ReadonlySet<string> {
  return new Set(typeof list === 'string' && list !== '' ? list.split(',') : [])
}

/**
 * Whether the cursor in the store can be trusted by a build that knows `entities`,
 * as the store keeps its list (`known`).
 *
 * A build skips the rows of a kind it does not know and moves the cursor past
 * them all the same, which is right while it has no screen for them. The next
 * build does, and asking from that cursor it would never see those rows: they
 * sit behind it. It happened with the first new kind after the offline layer
 * shipped. A device still running the old build from its service worker
 * pulled the rows of the new kind, dropped them, and after taking the new
 * build over showed records without the part that had been added to them.
 *
 * So the cursor only stands when the build that wrote it knew at least what
 * this one knows. A store without the list was written before the list
 * existed, and its cursor does not stand either. Starting again from the
 * beginning costs one full pull and nothing else: a pull only overwrites rows
 * by their id, and the outbox is laid over whatever arrives.
 */
function cursorStands(known: string | number | undefined, entities: readonly string[]): boolean {
  if (typeof known !== 'string') {
    return false
  }

  const knew = new Set(known.split(','))

  return entities.every((entity) => knew.has(entity))
}

/**
 * The writes that take the store back for the kinds of a build (`list`):
 * the cursor at 0, as the cursor of the last checked write too, under the
 * narrowing it keeps, and nothing settled.
 */
function claimIn(
  meta: IDBObjectStore,
  list: string,
  narrowed: MetaRow | undefined,
  key: (name: string) => string,
): void {
  meta.put({ key: key(entitiesKey), value: list } satisfies MetaRow)
  meta.put({ key: key(cursorKey), value: 0 } satisfies MetaRow)
  meta.put({ key: key(checkedKey), value: 0 } satisfies MetaRow)
  meta.put({ key: key(checkedForKey), value: narrowed?.value ?? '' } satisfies MetaRow)
  meta.put({ key: key(settledKey), value: '' } satisfies MetaRow)
}

/**
 * The rows of each named kind, deleted rows included, read in `transaction`,
 * each kind as the section of the store names it (`kind`).
 */
async function pulledRows(
  transaction: IDBTransaction,
  entities: readonly string[],
  kind: (entity: string) => string,
): Promise<ReadonlyMap<string, readonly StoredRecord[]>> {
  const index = transaction.objectStore(recordStore).index('entity')
  const rows = new Map<string, readonly StoredRecord[]>()

  for (const entity of entities) {
    const found = await promised<RecordRow[]>(index.getAll(kind(entity)))

    rows.set(
      entity,
      found.map((row) => row.values),
    )
  }

  return rows
}

function keyOf(entity: string, id: string): string {
  // A separator that cannot appear in either half, so that two different
  // pairs can never produce the same key: a table name is lower case letters
  // and underscores, a UUID is hex and hyphens, and neither holds a colon.
  // Not a control character, however tempting: a NUL byte in a source file
  // makes git treat the whole file as binary and stop showing its diff.
  return `${entity}::${id}`
}

function promised<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('Die lokale Ablage hat die Anfrage abgelehnt.'))
    }
  })
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('Die lokale Ablage hat den Vorgang abgebrochen.'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('Die lokale Ablage hat den Vorgang abgebrochen.'))
    }
  })
}

/**
 * An operation on its way into the store.
 *
 * `recordedAt` is a `Date` in the model and has to stay one when it comes back
 * out, because the outbox is sorted by it. IndexedDB can hold a `Date`, but
 * only through the structured clone, and that clone is what a branded id does
 * not survive as anything but the string it already is. Writing the round trip
 * out here beats discovering a string where the sort expects a date.
 *
 * Beside it the person it was recorded for, when the store is open for one;
 * see `openLocalStore`. The operation itself never carries it, so it is taken
 * off again on the way out and never travels.
 */
function toStored(operation: Operation, owner: string | undefined) {
  return {
    ...operation,
    recordedAt: operation.recordedAt.toISOString(),
    ...(owner === undefined ? {} : { owner }),
  }
}

function fromStored(row: unknown): Operation {
  const { owner: _owner, ...stored } = row as Operation & { recordedAt: string; owner?: string }

  return { ...stored, recordedAt: new Date(stored.recordedAt) }
}

/** The person a change or a file to send was recorded for, or undefined for nobody. */
function recordedFor(row: unknown): string | undefined {
  return (row as { owner?: string }).owner
}

/**
 * Whether an operation in the outbox is one the person the store is open for
 * may send. One queued before the store recorded the person with it says
 * for nobody whose it is, and nobody sends it: whoever opened the store
 * next sent it with their own name and rights on it. It waits on the device,
 * where counting before a sign out still finds it, and goes with the sign
 * out. Opened without an owner, the store answers with everything.
 */
function sendableBy(row: unknown, owner: string | undefined): boolean {
  return owner === undefined || recordedFor(row) === owner
}

/** A row of the list of uploads. */
interface UploadRow {
  readonly sha256: string
  readonly since: number
  readonly owner?: string
}

/** Whether a row of the outbox or the uploads says for nobody whose it is. */
function nobodys(row: unknown): boolean {
  return (row as { owner?: string }).owner === undefined
}

function upgrade(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(recordStore)) {
    const records = database.createObjectStore(recordStore, { keyPath: 'key' })
    // The only question ever asked of this store: everything of one kind.
    records.createIndex('entity', 'entity', { unique: false })
  }

  for (const name of [outboxStore, conflictStore]) {
    if (!database.objectStoreNames.contains(name)) {
      database.createObjectStore(name, { keyPath: 'id' })
    }
  }

  if (!database.objectStoreNames.contains(metaStore)) {
    database.createObjectStore(metaStore, { keyPath: 'key' })
  }

  // Since version 2 (#77). The bytes in one store and the list of what still
  // has to go up in another, so that finding the waiting uploads does not read
  // every photo on the device to look at a flag.
  if (!database.objectStoreNames.contains(fileStore)) {
    database.createObjectStore(fileStore, { keyPath: 'sha256' })
  }

  if (!database.objectStoreNames.contains(uploadStore)) {
    database.createObjectStore(uploadStore, { keyPath: 'sha256' })
  }
}

/**
 * What the name of every store starts with: the organisation, in small
 * letters, as in the roles of the database. The same in every application on
 * purpose. A browser keeps its databases by the address a page came from,
 * and each application has its own; and a device of an installation that
 * found its store under another name after an update would have lost its
 * outbox.
 */
const storePrefix = 'opengewerk.'

/**
 * The tenants whose store this browser opened, kept beside the stores. A
 * browser that cannot list its databases (`indexedDB.databases`) found at a
 * sign out only the tenant it remembered, and the stores of the tenants
 * before stayed with their records and files. A tenant goes from the list
 * only once its store is gone.
 */
const openedKey = 'opengewerk.stores'

function openedStores(): string[] {
  try {
    const kept: unknown = JSON.parse(globalThis.localStorage.getItem(openedKey) ?? '[]')

    return Array.isArray(kept)
      ? kept.filter((each): each is string => typeof each === 'string')
      : []
  } catch {
    return []
  }
}

function keepOpened(tenants: readonly string[]): void {
  try {
    globalThis.localStorage.setItem(openedKey, JSON.stringify([...new Set(tenants)]))
  } catch {
    // A browser that keeps nothing here keeps the named tenant at least.
  }
}

/**
 * The tenants whose store is on this device: those the browser lists, those
 * it opened (`openedStores`) and the ones named.
 */
export async function storesOnDevice(named: readonly string[] = []): Promise<string[]> {
  const listed =
    typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases())
          .map((database) => database.name ?? '')
          .filter((name) => name.startsWith(storePrefix))
          .map((name) => name.slice(storePrefix.length))
      : []

  return [...new Set([...listed, ...openedStores(), ...named])]
}

/**
 * A sign out of `person` while another account, `keptFor`, is signed in on
 * the browser since (opengewerk#905).
 */
export interface Leaving {
  readonly person: string
  readonly keptFor: string
}

/**
 * How many changes wait in the store of a tenant and have not reached the
 * server: all of them, or, for a sign out that leaves the store to the
 * account it is kept for (`leaving`), those of the person signing out.
 */
export async function waitingIn(tenantId: string, leaving?: Leaving): Promise<number> {
  const store = await openLocalStore(tenantId)

  try {
    if (
      leaving !== undefined &&
      leaving.person !== leaving.keptFor &&
      (await store.whose()) === leaving.keptFor
    ) {
      return await store.waitingOf(leaving.person)
    }

    return (await store.readOutbox()).length + (await store.countWaitingFiles())
  } finally {
    store.close()
  }
}

/**
 * The store of a tenant at a sign out of `leaving.person` while another
 * account is signed in on the browser since (opengewerk#905). Kept for that
 * account, it loses what the person left waiting in it and stays theirs;
 * every other store is deleted (`deleteLocalStore`), as at any sign out.
 */
export async function leaveLocalStore(tenantId: string, leaving: Leaving): Promise<void> {
  const store = await openLocalStore(tenantId)
  let kept: boolean

  try {
    kept = await store.leave(leaving.person, leaving.keptFor)
  } finally {
    store.close()
  }

  if (!kept) {
    await deleteLocalStore(tenantId)
  }
}

/**
 * The store of a tenant, gone from this device (#186). Waits until every
 * connection has let go; the stores opened here close theirs when asked, so
 * that takes a moment and not until a tab is closed.
 */
export function deleteLocalStore(tenantId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`${storePrefix}${tenantId}`)

    request.onsuccess = () => {
      keepOpened(openedStores().filter((each) => each !== tenantId))
      resolve()
    }
    request.onerror = () => {
      reject(request.error ?? new Error('Die lokale Ablage ließ sich nicht löschen.'))
    }
  })
}

/**
 * The store was opened for one account, and another has taken it over since
 * (`claimFor`): a tab still running for the one before reads and writes
 * nothing more of what the store holds for an account.
 */
export class StoreTakenOver extends Error {
  constructor() {
    super('Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet.')
    this.name = 'StoreTakenOver'
  }
}

/**
 * Opens the store for one tenant on this device.
 *
 * The name carries the tenant, which is the isolation on the device: two
 * tenants on one laptop get two databases, and there is no query that could
 * accidentally reach across. The server has row level security for the same
 * job; here the boundary is the file.
 *
 * `owner` is the person the device works for. What is queued is recorded for
 * them, and the outbox answers with theirs alone (opengewerk-haustechnik#31).
 * The server takes the person from the session that sends and an operation
 * names only its device, so a change somebody wrote and could not send before
 * their session ended went out under whoever signed in next on this device,
 * with that person's name and rights on it. Now it waits on the device until
 * its person signs in again. Opened without an owner, the outbox answers with
 * everything, which is what counting before a sign out needs: a change of
 * somebody else that waits here is lost with the sign out all the same.
 *
 * `section` is the part of the store the records pulled and the bookkeeping
 * of their pulls belong to (opengewerk#907). The office and the site of one
 * browser share the store, and the server narrows them apart: the site holds
 * the values of the ways into its sites, the office does not. In one section
 * each took the narrowing of the other for a changed one, started again from
 * 0 and dropped the rows of the other. What waits to be sent, the files, the
 * conflicts and what an application keeps for the device stay the store's,
 * whichever entry wrote them. Without a section the store is as it was
 * before, which the site keeps: a device in a cellar opens what it pulled.
 */
export async function openLocalStore(
  tenantId: string,
  owner?: string,
  section?: string,
): Promise<LocalStore> {
  // Listed before it is opened, so that a store that exists is never missing from the list.
  keepOpened([...openedStores(), tenantId])

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    // Version 2 added the files (#77). `upgrade` adds whatever is missing, so a
    // device on version 1 keeps its records and gains the two new stores.
    const request = indexedDB.open(`${storePrefix}${tenantId}`, 2)

    request.onupgradeneeded = () => {
      upgrade(request.result)
    }
    request.onsuccess = () => {
      // Let go when another tab signs out and deletes this store (#186). A
      // connection held open here would block the deletion until this tab
      // closes, and the data would outlive the sign out.
      request.result.onversionchange = () => {
        request.result.close()
      }
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('Die lokale Ablage lässt sich nicht öffnen.'))
    }
  })

  function transact(names: readonly string[], mode: IDBTransactionMode): IDBTransaction {
    return database.transaction([...names], mode)
  }

  /** A kind of record as this section of the store keeps it (`section`). */
  function inSection(name: string): string {
    return within(section, name)
  }

  /** A key of the meta store: the bookkeeping of the pulls is the section's, any other key the store's. */
  function metaKey(key: string): string {
    return pulledKeys.includes(key) ? inSection(key) : key
  }

  if (owner !== undefined) {
    await claimFor(owner)
  }

  // Neither where another account has taken the store over since it was
  // claimed above, by a tab opening it at the same moment: nothing here is
  // this account's to copy, and the first read says so (`StoreTakenOver`), as
  // it did before there were sections.
  try {
    if (section !== undefined) {
      await adoptUnsectioned()
    }

    if (owner !== undefined) {
      await takeFromOtherSections()
    }
  } catch (error) {
    if (!(error instanceof StoreTakenOver)) {
      throw error
    }
  }

  /**
   * What another section of the store pulled since this one last did, for
   * the kinds both hold narrowed alike (opengewerk#907): a row the other holds
   * in a later version, or that is missing here. The office and the site of a
   * browser are one tab apart, and the page switched from one to the other
   * without a network showed only what this section pulled itself, older than
   * what was on screen a moment before. A kind narrowed apart is left alone:
   * its rows differ, the ways into the sites carry their values on the site
   * alone. The cursor stays as it is; the next pull brings every row from it
   * as the server holds it then.
   */
  async function takeFromOtherSections(): Promise<void> {
    const transaction = await held([recordStore, metaStore], 'readwrite')
    const meta = transaction.objectStore(metaStore)
    const records = transaction.objectStore(recordStore)
    const own = narrowingIn(await promised<MetaRow | undefined>(meta.get(metaKey(narrowedKey))))
    const kinds = kindsOf(
      (await promised<MetaRow | undefined>(meta.get(metaKey(entitiesKey))))?.value,
    )

    if (own === null || kinds.size === 0) {
      await finished(transaction)

      return
    }

    for (const other of await sectionsBesides(meta, section)) {
      const at = (name: string) => within(other, name)
      const theirs = narrowingIn(await promised<MetaRow | undefined>(meta.get(at(narrowedKey))))

      if (theirs === null) {
        continue
      }

      for (const kind of kinds) {
        // Narrowed by neither is alike as well: every device gets all of it.
        if (own[kind] !== theirs[kind]) {
          continue
        }

        for (const row of await promised<RecordRow[]>(records.index('entity').getAll(at(kind)))) {
          const key = keyOf(inSection(kind), row.id)
          const mine = await promised<RecordRow | undefined>(records.get(key))

          if (mine === undefined || versionOf(mine.values) < versionOf(row.values)) {
            records.put({ ...row, key, entity: inSection(kind) } satisfies RecordRow)
          }
        }
      }
    }

    await finished(transaction)
  }

  /**
   * A section that never pulled begins with the rows the store pulled before
   * it had sections (opengewerk#907), so that the office opens without a
   * network what it showed before the update. The rows alone, without the
   * bookkeeping of their pull: kept with them, the narrowing of the site looked
   * like the office's own, and its first exchange let go of the ways into the
   * sites for the site as well. Without it the section pulls from the start
   * at its first exchange and takes what it holds as narrowed anew.
   *
   * And a section whose records went since it began begins again. Every
   * takeover by another account lets go of every record, by any build, also
   * one from before sections, which knows only the bookkeeping outside them;
   * and an account that comes back after another finds the section begun for
   * it. A row of the section's own, among its records, says they are still
   * those its bookkeeping counts: gone with them, the cursor of the section
   * would stand over rows that are missing. Asked and written in one
   * transaction, for the account of the store.
   */
  async function adoptUnsectioned(): Promise<void> {
    const transaction = await held([recordStore, metaStore], 'readwrite')
    const meta = transaction.objectStore(metaStore)
    const records = transaction.objectStore(recordStore)
    const mark = keyOf(inSection(''), '')

    if ((await promised<RecordRow | undefined>(records.get(mark))) === undefined) {
      for (const key of pulledKeys) {
        meta.delete(inSection(key))
      }

      records.put({ key: mark, entity: inSection(''), id: '', values: {} } satisfies RecordRow)
    }

    if ((await promised<MetaRow | undefined>(meta.get(metaKey(entitiesKey)))) === undefined) {
      const stood = await promised<MetaRow | undefined>(meta.get(narrowedKey))

      if (stood !== undefined) {
        meta.put({ key: metaKey(adoptedKey), value: stood.value } satisfies MetaRow)
      }

      for (const row of await promised<RecordRow[]>(records.getAll())) {
        if (!row.entity.includes('/')) {
          records.put({
            ...row,
            key: keyOf(inSection(row.entity), row.id),
            entity: inSection(row.entity),
          } satisfies RecordRow)
        }
      }
    }

    await finished(transaction)
  }

  /**
   * A transaction over what the store holds for its account, while the
   * store is still that account's. Asked in the same transaction, since
   * the store is shared by the tabs of the browser: a pull still on its way
   * for the account before wrote its rows, the codes of sites among them,
   * into the store of the one after, and a tab still open for the one
   * before read what was pulled for the one after.
   */
  async function held(names: readonly string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    if (owner === undefined) {
      return transact(names, mode)
    }

    const transaction = transact([...new Set([...names, metaStore])], mode)
    const row = await promised<MetaRow | undefined>(
      transaction.objectStore(metaStore).get(ownerKey),
    )

    if (row?.value !== owner) {
      transaction.abort()

      throw new StoreTakenOver()
    }

    return transaction
  }

  /**
   * What the store holds of the server is for the account that pulled it.
   * The records a server sends depend on who asks: the jobs of one
   * technician, the ways into the sites of their open jobs with the codes. A
   * store opened for another account of the same tenant on this browser
   * showed those to the next person before the first pull had said what they
   * may see. So another account finds the records, the conflicts, the files
   * kept for reading and the cursor gone and pulls anew; the outbox, the
   * files waiting to be sent and what the application keeps for itself, a
   * running stopwatch with the person it is of, stay (opengewerk-haustechnik#31).
   * A store from before this was kept says for nobody whose it is, and is
   * treated as another account's: handed to whoever opened it first after the
   * update, it showed them what the server had sent the person before, the
   * codes of sites among it. Its device pulls everything once more, and
   * without a network shows nothing of it until it has one.
   */
  async function claimFor(person: string): Promise<void> {
    // Read and written in one transaction. Read in one of its own, two tabs
    // opening the store for two people at once both found it without an owner,
    // and the second took it over with what was pulled for the first. Two
    // transactions that write the same stores run one after the other, so the
    // second finds the owner the first wrote.
    const names = [recordStore, conflictStore, metaStore, fileStore, uploadStore]
    const transaction = transact(names, 'readwrite')
    const row = await promised<MetaRow | undefined>(
      transaction.objectStore(metaStore).get(ownerKey),
    )
    const kept = row?.value

    if (kept === person) {
      await finished(transaction)

      return
    }

    // Another account's, or nobody's.
    transaction.objectStore(recordStore).clear()
    transaction.objectStore(conflictStore).clear()
    // That of a section goes when the section is opened next: with the
    // records went the row that says they are its own (`adoptUnsectioned`,
    // opengewerk#907).
    for (const key of pulledKeys) {
      transaction.objectStore(metaStore).delete(key)
    }

    const waiting = new Set(
      (await promised<IDBValidKey[]>(transaction.objectStore(uploadStore).getAllKeys())).map(
        String,
      ),
    )

    for (const key of await promised<IDBValidKey[]>(
      transaction.objectStore(fileStore).getAllKeys(),
    )) {
      if (!waiting.has(String(key))) {
        transaction.objectStore(fileStore).delete(key)
      }
    }

    transaction.objectStore(metaStore).put({ key: ownerKey, value: person } satisfies MetaRow)
    await finished(transaction)
  }

  return {
    ...(owner === undefined ? {} : { owner }),

    async readAll(entity) {
      const transaction = await held([recordStore], 'readonly')
      const rows = await promised<RecordRow[]>(
        transaction.objectStore(recordStore).index('entity').getAll(inSection(entity)),
      )

      return rows.map((row) => row.values)
    },

    async write(entity, records) {
      const transaction = await held([recordStore], 'readwrite')
      const store = transaction.objectStore(recordStore)

      for (const values of records) {
        const id = String(values['id'])

        store.put({
          key: keyOf(inSection(entity), id),
          entity: inSection(entity),
          id,
          values,
        } satisfies RecordRow)
      }

      await finished(transaction)
    },

    async drop(entity) {
      const transaction = await held([recordStore], 'readwrite')
      const store = transaction.objectStore(recordStore)
      const keys = await promised<IDBValidKey[]>(
        store.index('entity').getAllKeys(inSection(entity)),
      )

      for (const key of keys) {
        store.delete(key)
      }

      await finished(transaction)
    },

    /** See `LocalStore.writePulled`: kinds, cursor and narrowing asked in the transaction that writes. */
    async writePulled(page) {
      const transaction = await held([recordStore, metaStore], 'readwrite')
      const meta = transaction.objectStore(metaStore)
      const kinds = await promised<MetaRow | undefined>(meta.get(metaKey(entitiesKey)))
      const cursor = await promised<MetaRow | undefined>(meta.get(metaKey(cursorKey)))
      const checked = await promised<MetaRow | undefined>(meta.get(metaKey(checkedKey)))
      const checkedFor = await promised<MetaRow | undefined>(meta.get(metaKey(checkedForKey)))
      const narrowed = await promised<MetaRow | undefined>(meta.get(metaKey(narrowedKey)))
      const kept = kindsOf(kinds?.value)
      const known = kindsOf(page.entities)
      const stands = cursor?.value ?? 0
      const answer: PageWritten = [...kept].some((kind) => !known.has(kind))
        ? 'newerBuild'
        : [...known].some((kind) => !kept.has(kind))
          ? 'fewerKinds'
          : (checked !== undefined && checked.value !== stands) ||
              (checkedFor !== undefined && checkedFor.value !== (narrowed?.value ?? ''))
            ? 'unchecked'
            : stands !== page.from || (page.narrowed !== null && narrowed?.value !== page.narrowed)
              ? 'moved'
              : 'written'

      if (answer !== 'written') {
        transaction.abort()

        return answer
      }

      const records = transaction.objectStore(recordStore)

      for (const { entity, rows } of page.changes) {
        for (const values of rows) {
          const id = String(values['id'])

          records.put({
            key: keyOf(inSection(entity), id),
            entity: inSection(entity),
            id,
            values,
          } satisfies RecordRow)
        }
      }

      // A record deleted, or emptied by an erasure, is so in every section
      // that holds it (opengewerk#907), in the version it came in or a later
      // one: the other entry would otherwise show it until it pulled itself,
      // on a device that never opens it, for good.
      const others = page.changes.some(({ rows }) => rows.some(deletedIn))
        ? await sectionsBesides(meta, section)
        : []

      for (const other of others) {
        for (const { entity, rows } of page.changes) {
          for (const values of rows.filter(deletedIn)) {
            const id = String(values['id'])
            const key = keyOf(within(other, entity), id)
            const held = await promised<RecordRow | undefined>(records.get(key))

            if (held !== undefined && versionOf(held.values) < versionOf(values)) {
              records.put({ key, entity: within(other, entity), id, values } satisfies RecordRow)
            }
          }
        }
      }

      meta.put({ key: metaKey(cursorKey), value: page.to } satisfies MetaRow)
      meta.put({ key: metaKey(checkedKey), value: page.to } satisfies MetaRow)
      meta.put({ key: metaKey(checkedForKey), value: narrowed?.value ?? '' } satisfies MetaRow)

      if (page.settled !== null) {
        meta.put({ key: metaKey(settledKey), value: page.settled } satisfies MetaRow)
      }

      await finished(transaction)

      return 'written'
    },

    /** See `LocalStore.claimPull`: kinds, cursor, checked cursor and settled in one transaction. */
    async claimPull(entities) {
      const transaction = await held([metaStore], 'readwrite')
      const meta = transaction.objectStore(metaStore)
      const narrowed = await promised<MetaRow | undefined>(meta.get(metaKey(narrowedKey)))

      claimIn(meta, entities, narrowed, metaKey)

      await finished(transaction)
    },

    /** See `LocalStore.beginPull`: the list asked, the state read and the list or the claim written in one transaction. */
    async beginPull(entities) {
      const transaction = await held([recordStore, metaStore], 'readwrite')
      const meta = transaction.objectStore(metaStore)

      const kinds = await promised<MetaRow | undefined>(meta.get(metaKey(entitiesKey)))
      const cursor = await promised<MetaRow | undefined>(meta.get(metaKey(cursorKey)))
      const checked = await promised<MetaRow | undefined>(meta.get(metaKey(checkedKey)))
      const narrowed = await promised<MetaRow | undefined>(meta.get(metaKey(narrowedKey)))
      const settled = await promised<MetaRow | undefined>(meta.get(metaKey(settledKey)))
      const list = [...entities].sort().join(',')
      const stands = cursorStands(kinds?.value, entities)

      if (!stands) {
        claimIn(meta, list, narrowed, metaKey)
      } else if (kinds?.value !== list) {
        // A shorter list too: a build that knows less moves the cursor past
        // the rows it drops, and the next longer list must not find a record
        // that says otherwise.
        meta.put({ key: metaKey(entitiesKey), value: list } satisfies MetaRow)
      }

      const rows = await pulledRows(transaction, entities, inSection)

      await finished(transaction)

      return {
        cursor: !stands ? 0 : typeof cursor?.value === 'number' ? cursor.value : null,
        checked: !stands ? 0 : typeof checked?.value === 'number' ? checked.value : null,
        narrowed: typeof narrowed?.value === 'string' ? narrowed.value : null,
        settled: !stands ? '' : typeof settled?.value === 'string' ? settled.value : null,
        rows,
      }
    },

    /** See `LocalStore.restartPull`: the narrowing asked, rows, cursor, settled and narrowing in one transaction. */
    async restartPull(entities, narrowed, before) {
      const transaction = await held([recordStore, metaStore], 'readwrite')
      const meta = transaction.objectStore(metaStore)
      const kept = await promised<MetaRow | undefined>(meta.get(metaKey(narrowedKey)))
      const adopted = await promised<MetaRow | undefined>(meta.get(metaKey(adoptedKey)))

      if (before !== undefined && (kept?.value ?? null) !== before) {
        transaction.abort()

        return false
      }

      const records = transaction.objectStore(recordStore)

      for (const entity of entities) {
        const keys = await promised<IDBValidKey[]>(
          records.index('entity').getAllKeys(inSection(entity)),
        )

        for (const key of keys) {
          records.delete(key)
        }
      }

      meta.put({ key: metaKey(settledKey), value: '' } satisfies MetaRow)
      meta.put({ key: metaKey(cursorKey), value: 0 } satisfies MetaRow)
      meta.put({ key: metaKey(checkedKey), value: 0 } satisfies MetaRow)
      meta.put({ key: metaKey(checkedForKey), value: narrowed } satisfies MetaRow)
      meta.put({ key: metaKey(narrowedKey), value: narrowed } satisfies MetaRow)

      // Every other section that held one of these kinds narrowed as this one
      // did lets go of it as well and pulls from the start (opengewerk#907):
      // what the narrowing no longer lets the account hold, a customer
      // restricted on a request for deletion or the rows of a role that sees
      // less, goes from the whole store at once, also from a section whose
      // entry this device never opens again. A kind the
      // sections hold narrowed apart, the ways into the sites with their
      // values on the site alone, each lets go of at its own exchange: taken
      // with this one, every exchange of the office took the values off the
      // site.
      // A section that took its rows over begins its first pull without a
      // narrowing of its own: the one the rows stood under stands for it, and
      // a change since the update reaches the part they came from as well.
      const was = narrowingIn(kept) ?? narrowingIn(adopted)
      const now = narrowingIn({ key: narrowedKey, value: narrowed }) ?? {}

      for (const other of was === null ? [] : await sectionsBesides(meta, section)) {
        const theirs = narrowingIn(
          await promised<MetaRow | undefined>(meta.get(within(other, narrowedKey))),
        )
        const alike =
          theirs === null
            ? []
            : // Narrowed by neither before is alike as well, a kind narrowed
              // for a role that sees less among it; and only a kind whose
              // narrowing changed, not one the client names for want of the one
              // before.
              entities.filter(
                (entity) => theirs[entity] === was?.[entity] && was?.[entity] !== now[entity],
              )

        if (theirs === null || alike.length === 0) {
          continue
        }

        for (const entity of alike) {
          const keys = await promised<IDBValidKey[]>(
            records.index('entity').getAllKeys(within(other, entity)),
          )

          for (const key of keys) {
            records.delete(key)
          }
        }

        // Its own narrowing stays: its next exchange finds the server's
        // answer changed and starts the kind itself, with this section's no
        // longer alike. Taking this one's over made a kind the entries hold
        // apart alike with the other's old one, and each start went back and
        // forth between the two.
        const own = await promised<MetaRow | undefined>(meta.get(within(other, narrowedKey)))

        meta.put({ key: within(other, settledKey), value: '' } satisfies MetaRow)
        meta.put({ key: within(other, cursorKey), value: 0 } satisfies MetaRow)
        meta.put({ key: within(other, checkedKey), value: 0 } satisfies MetaRow)
        meta.put({ key: within(other, checkedForKey), value: own?.value ?? '' } satisfies MetaRow)
      }

      await finished(transaction)

      return true
    },

    /** See `LocalStore.readPulled`: cursor, narrowing, settled and rows in one transaction. */
    async readPulled(entities) {
      const transaction = await held([recordStore, metaStore], 'readonly')
      const meta = transaction.objectStore(metaStore)
      const cursor = await promised<MetaRow | undefined>(meta.get(metaKey(cursorKey)))
      const checked = await promised<MetaRow | undefined>(meta.get(metaKey(checkedKey)))
      const narrowed = await promised<MetaRow | undefined>(meta.get(metaKey(narrowedKey)))
      const settled = await promised<MetaRow | undefined>(meta.get(metaKey(settledKey)))
      const rows = await pulledRows(transaction, entities, inSection)

      return {
        cursor: typeof cursor?.value === 'number' ? cursor.value : null,
        checked: typeof checked?.value === 'number' ? checked.value : null,
        narrowed: typeof narrowed?.value === 'string' ? narrowed.value : null,
        settled: typeof settled?.value === 'string' ? settled.value : null,
        rows,
      }
    },

    async whose() {
      const transaction = transact([metaStore], 'readonly')
      const row = await promised<MetaRow | undefined>(
        transaction.objectStore(metaStore).get(ownerKey),
      )

      return typeof row?.value === 'string' ? row.value : null
    },

    async waitingOf(person) {
      const transaction = transact([outboxStore, uploadStore], 'readonly')
      const [queued, uploads] = await Promise.all([
        promised<unknown[]>(transaction.objectStore(outboxStore).getAll()),
        promised<unknown[]>(transaction.objectStore(uploadStore).getAll()),
      ])

      return [...queued, ...uploads].filter((row) => recordedFor(row) === person).length
    },

    /** See `LocalStore.leave`: whose the store is asked in the transaction that takes the rows. */
    async leave(person, keptFor) {
      const transaction = transact([metaStore, outboxStore, uploadStore, fileStore], 'readwrite')
      const row = await promised<MetaRow | undefined>(
        transaction.objectStore(metaStore).get(ownerKey),
      )

      if (keptFor === person || row?.value !== keptFor) {
        transaction.abort()

        return false
      }

      const meta = transaction.objectStore(metaStore)
      const outbox = transaction.objectStore(outboxStore)
      const uploads = transaction.objectStore(uploadStore)
      const [kept, queued, waiting] = await Promise.all([
        promised<MetaRow[]>(meta.getAll()),
        promised<unknown[]>(outbox.getAll()),
        promised<UploadRow[]>(uploads.getAll()),
      ])

      // What the application kept for them, a running stopwatch with where
      // it was started among it.
      for (const each of kept) {
        if (each.owner === person) {
          meta.delete(each.key)
        }
      }

      for (const each of queued) {
        if (recordedFor(each) === person) {
          outbox.delete((each as { id: string }).id)
        }
      }

      for (const each of waiting) {
        if (each.owner === person) {
          uploads.delete(each.sha256)
          transaction.objectStore(fileStore).delete(each.sha256)
        }
      }

      await finished(transaction)

      return true
    },

    async readOutbox() {
      const transaction = transact([outboxStore], 'readonly')

      return (await promised<unknown[]>(transaction.objectStore(outboxStore).getAll()))
        .filter((row) => sendableBy(row, owner))
        .map(fromStored)
    },

    async queue(operation) {
      const transaction = transact([outboxStore], 'readwrite')

      transaction.objectStore(outboxStore).put(toStored(operation, owner))

      await finished(transaction)
    },

    async dequeue(ids) {
      const transaction = transact([outboxStore], 'readwrite')
      const store = transaction.objectStore(outboxStore)

      for (const id of ids) {
        store.delete(id)
      }

      await finished(transaction)
    },

    async readConflicts() {
      const transaction = await held([conflictStore], 'readonly')

      return await promised<SyncConflict[]>(transaction.objectStore(conflictStore).getAll())
    },

    async writeConflicts(conflicts) {
      const transaction = await held([conflictStore], 'readwrite')
      const store = transaction.objectStore(conflictStore)

      // Replaced whole rather than merged. The server owns this list, so what
      // it last said is the answer, and a conflict that has disappeared there
      // has been decided by somebody, possibly on another device.
      store.clear()

      for (const conflict of conflicts) {
        store.put(conflict)
      }

      await finished(transaction)
    },

    async dropConflict(id) {
      const transaction = await held([conflictStore], 'readwrite')

      transaction.objectStore(conflictStore).delete(id)

      await finished(transaction)
    },

    async readMeta(key) {
      const transaction = await held([metaStore], 'readonly')
      const row = await promised<MetaRow | undefined>(
        transaction.objectStore(metaStore).get(metaKey(key)),
      )

      return row?.value ?? null
    },

    async writeMeta(key, value) {
      const transaction = await held([metaStore], 'readwrite')

      transaction.objectStore(metaStore).put({
        key: metaKey(key),
        value,
        ...(owner === undefined ? {} : { owner }),
      } satisfies MetaRow)

      await finished(transaction)
    },

    async keepFile(file, waiting) {
      // A photo to send is the person's own, as a change in the outbox is, and
      // waits for them; a file kept for reading is what was pulled.
      const transaction = waiting
        ? transact([fileStore, uploadStore], 'readwrite')
        : await held([fileStore, uploadStore], 'readwrite')

      transaction.objectStore(fileStore).put(file)

      // A file waits for its person like a change does: the upload is a row
      // in the log of the tenant, under the person whose session sends it.
      if (waiting) {
        transaction.objectStore(uploadStore).put({
          sha256: file.sha256,
          since: Date.now(),
          ...(owner === undefined ? {} : { owner }),
        })
      }

      await finished(transaction)
    },

    async readFile(sha256) {
      const transaction = await held([fileStore], 'readonly')
      const found = await promised<StoredFile | undefined>(
        transaction.objectStore(fileStore).get(sha256),
      )

      return found ?? null
    },

    async waitingFiles() {
      const listed = transact([uploadStore], 'readonly')
      const waiting = (
        await promised<{ sha256: string; since: number; owner?: string }[]>(
          listed.objectStore(uploadStore).getAll(),
        )
      ).filter((row) => sendableBy(row, owner))

      // A second transaction with every request made at once. A request made
      // after an `await` may find its transaction already committed.
      const reading = transact([fileStore], 'readonly')
      const store = reading.objectStore(fileStore)
      const found = await Promise.all(
        [...waiting]
          .sort((left, right) => left.since - right.since)
          .map(({ sha256 }) => promised<StoredFile | undefined>(store.get(sha256))),
      )

      return found.filter((file): file is StoredFile => file !== undefined)
    },

    async countWaitingFiles() {
      const transaction = transact([uploadStore], 'readonly')

      if (owner === undefined) {
        return await promised<number>(transaction.objectStore(uploadStore).count())
      }

      const rows = await promised<unknown[]>(transaction.objectStore(uploadStore).getAll())

      return rows.filter((row) => sendableBy(row, owner)).length
    },

    async waitingHashes() {
      const transaction = transact([uploadStore], 'readonly')
      const rows = await promised<{ sha256: string; owner?: string }[]>(
        transaction.objectStore(uploadStore).getAll(),
      )

      return new Set(rows.filter((row) => sendableBy(row, owner)).map((row) => row.sha256))
    },

    async fileSent(sha256) {
      const transaction = transact([uploadStore], 'readwrite')

      transaction.objectStore(uploadStore).delete(sha256)

      await finished(transaction)
    },

    async dropFile(sha256) {
      // One transaction over both, so that a file made here in the same
      // moment is not taken from under its upload. Each request goes out
      // from the callback of the one before: after an `await` the
      // transaction may have committed already.
      const transaction = transact([fileStore, uploadStore], 'readwrite')
      const waiting = transaction.objectStore(uploadStore).count(sha256)
      let dropped = false

      waiting.onsuccess = () => {
        const held = transaction.objectStore(fileStore).count(sha256)

        held.onsuccess = () => {
          if (waiting.result === 0 && held.result > 0) {
            transaction.objectStore(fileStore).delete(sha256)
            dropped = true
          }
        }
      }

      await finished(transaction)

      return dropped
    },

    async readUnowned() {
      if (owner === undefined) {
        return { operations: [], files: [] }
      }

      const transaction = await held([outboxStore, uploadStore, fileStore], 'readonly')
      const [queued, uploads] = await Promise.all([
        promised<unknown[]>(transaction.objectStore(outboxStore).getAll()),
        promised<UploadRow[]>(transaction.objectStore(uploadStore).getAll()),
      ])
      const waiting = uploads.filter(nobodys).sort((left, right) => left.since - right.since)
      // Every request at once, before the transaction can commit.
      const kept = await Promise.all(
        waiting.map(({ sha256 }) =>
          promised<StoredFile | undefined>(transaction.objectStore(fileStore).get(sha256)),
        ),
      )

      return {
        operations: inOutboxOrder(queued.filter(nobodys).map(fromStored)),
        files: waiting.flatMap(({ sha256, since }, at) => {
          const file = kept[at]

          return file ? [{ sha256, since, mediaType: file.mediaType }] : []
        }),
      }
    },

    async adoptUnowned(operations, files) {
      if (owner === undefined) {
        return { operations: [], files: [] }
      }

      // One transaction that asks whose the store is and writes: a tab of
      // the account before must not hand what it showed to the one after.
      const transaction = await held([outboxStore, uploadStore], 'readwrite')
      const outbox = transaction.objectStore(outboxStore)
      const uploads = transaction.objectStore(uploadStore)
      const [queued, waiting] = await Promise.all([
        Promise.all(operations.map((id) => promised<unknown>(outbox.get(id)))),
        Promise.all(files.map((sha256) => promised<UploadRow | undefined>(uploads.get(sha256)))),
      ])

      const taken: { operations: OperationId[]; files: string[] } = { operations: [], files: [] }

      operations.forEach((id, at) => {
        const row = queued[at]

        if (row !== undefined && nobodys(row)) {
          outbox.put({ ...(row as object), owner })
          taken.operations.push(id)
        }
      })

      for (const row of waiting) {
        if (row !== undefined && nobodys(row)) {
          uploads.put({ ...row, owner })
          taken.files.push(row.sha256)
        }
      }

      await finished(transaction)

      return taken
    },

    async dropUnowned(operations, files) {
      if (owner === undefined) {
        return
      }

      const transaction = await held([outboxStore, uploadStore, fileStore], 'readwrite')
      const outbox = transaction.objectStore(outboxStore)
      const uploads = transaction.objectStore(uploadStore)
      const [queued, waiting] = await Promise.all([
        Promise.all(operations.map((id) => promised<unknown>(outbox.get(id)))),
        Promise.all(files.map((sha256) => promised<UploadRow | undefined>(uploads.get(sha256)))),
      ])

      operations.forEach((id, at) => {
        const row = queued[at]

        if (row !== undefined && nobodys(row)) {
          outbox.delete(id)
        }
      })

      for (const row of waiting) {
        if (row !== undefined && nobodys(row)) {
          uploads.delete(row.sha256)
          transaction.objectStore(fileStore).delete(row.sha256)
        }
      }

      await finished(transaction)
    },

    async clear() {
      const names = [recordStore, outboxStore, conflictStore, metaStore, fileStore, uploadStore]
      const transaction = transact(names, 'readwrite')

      for (const name of names) {
        transaction.objectStore(name).clear()
      }

      await finished(transaction)
    },

    close() {
      database.close()
    },
  }
}
