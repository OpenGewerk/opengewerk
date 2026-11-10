import 'fake-indexeddb/auto'

import type { Operation, OperationId } from '@opengewerk/platform-domain'
import { describe, expect, it } from 'vitest'

import { openLocalStore, StoreTakenOver, waitingIn } from './store.js'

/**
 * Whose changes a device sends (opengewerk-haustechnik#31).
 *
 * The server takes the person from the session that sends, and an operation
 * names only its device. A change somebody wrote and could not send before
 * their session ended would otherwise go out under whoever signs in next on
 * the same device, with that person's name and rights on it.
 */

let counter = 0

function aTenant(): string {
  return `owners${String((counter += 1))}`
}

function aNote(id: string, text: string): Operation {
  return {
    id: id as unknown as OperationId,
    entity: 'notes',
    recordId: `n-${id}`,
    kind: 'create',
    baseVersion: null,
    patches: [{ field: 'text', from: null, to: text }],
    recordedAt: new Date('2026-10-04T08:00:00Z'),
    deviceId: 'device',
  }
}

const photo = { sha256: 'a'.repeat(64), bytes: new ArrayBuffer(8), mediaType: 'image/jpeg' }

describe('the outbox of a device with more than one person', () => {
  it('sends a change only for the person it was recorded for, and counts every one', async () => {
    const tenant = aTenant()
    const anna = await openLocalStore(tenant, 'anna')

    await anna.queue(aNote('op-anna', 'Leiter im Flur'))
    await anna.keepFile(photo, true)
    anna.close()

    // Ben signs in on the same device after Anna's session ran out.
    const ben = await openLocalStore(tenant, 'ben')

    expect(await ben.readOutbox()).toEqual([])
    expect(await ben.waitingFiles()).toEqual([])
    expect(await ben.countWaitingFiles()).toBe(0)

    await ben.queue(aNote('op-ben', 'Tür klemmt'))

    expect((await ben.readOutbox()).map((operation) => operation.id)).toEqual(['op-ben'])
    ben.close()

    // Signing out counts what would be lost, whoever wrote it.
    expect(await waitingIn(tenant)).toBe(3)

    // Anna is back: hers go out, as they were queued and with nothing added.
    const back = await openLocalStore(tenant, 'anna')

    expect(await back.readOutbox()).toEqual([aNote('op-anna', 'Leiter im Flur')])
    expect((await back.waitingFiles()).map((file) => file.sha256)).toEqual([photo.sha256])
    expect(await back.countWaitingFiles()).toBe(1)
    back.close()
  })

  it('is sent by nobody, for a change from before the person was kept, and still counted', async () => {
    const tenant = aTenant()
    const before = await openLocalStore(tenant)

    await before.queue(aNote('op-before', 'Zählerstand fehlt'))
    before.close()

    const ben = await openLocalStore(tenant, 'ben')

    expect(await ben.readOutbox()).toEqual([])
    ben.close()

    // Counting before a sign out still finds it.
    const counting = await openLocalStore(tenant)

    expect((await counting.readOutbox()).map((operation) => operation.id)).toEqual(['op-before'])
    counting.close()
  })
})

describe('what a device holds of the server, with more than one person', () => {
  it('is for the account that pulled it, and another finds it gone, the changes and files waiting kept', async () => {
    const tenant = aTenant()
    const anna = await openLocalStore(tenant, 'anna')
    const kept = { ...photo, sha256: 'b'.repeat(64) }

    await anna.write('site_accesses', [{ id: 'z-1', value: '4711' }])
    await anna.writeMeta('cursor', 42)
    await anna.writeMeta('narrowed', '{"jobs":"mine"}')
    await anna.writeMeta('stopwatch', '{"userId":"anna","startedAt":"2026-11-08T07:00:00.000Z"}')
    await anna.queue(aNote('op-anna', 'Leiter im Flur'))
    await anna.keepFile(photo, true)
    await anna.keepFile(kept, false)
    anna.close()

    // Ben opens the store of the same tenant on this browser.
    const ben = await openLocalStore(tenant, 'ben')

    expect(await ben.readAll('site_accesses')).toEqual([])
    expect(await ben.readMeta('cursor')).toBeNull()
    expect(await ben.readMeta('narrowed')).toBeNull()
    // What the application keeps for itself says whose it is, and stays.
    expect(await ben.readMeta('stopwatch')).toBe(
      '{"userId":"anna","startedAt":"2026-11-08T07:00:00.000Z"}',
    )
    expect(await ben.readFile(kept.sha256)).toBeNull()
    ben.close()

    // Anna's change and her photo still wait for her.
    const back = await openLocalStore(tenant, 'anna')

    expect(await back.readOutbox()).toEqual([aNote('op-anna', 'Leiter im Flur')])
    expect((await back.waitingFiles()).map((file) => file.sha256)).toEqual([photo.sha256])
    back.close()
  })

  it('stays for the account that pulled it, and a store from before goes to nobody', async () => {
    const tenant = aTenant()
    const before = await openLocalStore(tenant)

    // A store of a version that did not yet say whose it is.
    await before.write('site_accesses', [{ id: 'z-1', value: '4711' }])
    await before.writeMeta('cursor', 42)
    await before.writeMeta('narrowed', '{"site_accesses":"previous-account"}')
    await before.writeMeta('narrowed-settled', '{"site_accesses":"previous-account"}')
    await before.writeMeta('entities', 'site_accesses')
    await before.keepFile(photo, false)
    await before.queue(aNote('op-before', 'Leiter im Flur'))
    before.close()

    const anna = await openLocalStore(tenant, 'anna')

    expect(await anna.readAll('site_accesses')).toEqual([])
    for (const key of ['cursor', 'narrowed', 'narrowed-settled', 'entities']) {
      expect(await anna.readMeta(key)).toBeNull()
    }
    expect(await anna.readFile(photo.sha256)).toBeNull()

    await anna.write('site_accesses', [{ id: 'z-2', value: '0815' }])
    anna.close()

    // What Anna pulled is hers; the change of nobody waits, for nobody.
    const again = await openLocalStore(tenant, 'anna')

    expect(await again.readAll('site_accesses')).toEqual([{ id: 'z-2', value: '0815' }])
    expect(await again.readOutbox()).toEqual([])
    again.close()
  })

  it('goes to one account at a time, also when two tabs open it for two at once', async () => {
    const tenant = aTenant()
    const before = await openLocalStore(tenant)

    await before.write('notes', [{ id: 'n-1', text: 'Zählerstand' }])
    before.close()

    // Anna and Ben, in two tabs of the same browser, at the same moment.
    const [anna, ben] = await Promise.all([
      openLocalStore(tenant, 'anna'),
      openLocalStore(tenant, 'ben'),
    ])

    // Whichever came first took the store over and was taken over by the
    // other; the other found what was pulled before gone.
    const read = await Promise.allSettled([anna.readAll('notes'), ben.readAll('notes')])

    expect(
      read
        .map((each) =>
          each.status === 'fulfilled'
            ? JSON.stringify(each.value)
            : each.reason instanceof StoreTakenOver
              ? 'taken over'
              : String(each.reason),
        )
        .sort(),
    ).toEqual(['[]', 'taken over'])
    anna.close()
    ben.close()
  })

  /**
   * A sign out of Anna after Ben signed in on the browser and took the store
   * over (opengewerk#905): her change and her photo go, his outbox and what
   * was pulled for him stay.
   */
  it('lets go of what one person left waiting in the store of the account signed in since, and of nothing else', async () => {
    const tenant = aTenant()
    const anna = await openLocalStore(tenant, 'anna')

    await anna.queue(aNote('op-anna', 'Leiter im Flur'))
    await anna.keepFile(photo, true)
    // A running stopwatch of hers, with where it was started.
    await anna.writeMeta('stopwatch', '{"userId":"anna","place":{"latitudeMicro":49452000}}')

    const ben = await openLocalStore(tenant, 'ben')

    await ben.queue(aNote('op-ben', 'Kabel im Keller'))
    await ben.write('site_accesses', [{ id: 'z-2', value: '0815' }])
    await ben.writeMeta('reminder', '{"userId":"ben"}')

    const any = await openLocalStore(tenant)

    expect(await any.whose()).toBe('ben')
    expect(await any.waitingOf('anna')).toBe(2)
    expect(await any.waitingOf('ben')).toBe(1)

    // For anybody else than whose the store is, nothing is taken.
    expect(await any.leave('anna', 'carla')).toBe(false)
    expect(await any.leave('ben', 'ben')).toBe(false)
    expect(await any.waitingOf('anna')).toBe(2)

    expect(await any.leave('anna', 'ben')).toBe(true)
    expect(await any.waitingOf('anna')).toBe(0)
    expect(await any.readFile(photo.sha256)).toBeNull()
    expect(await any.readMeta('stopwatch')).toBeNull()
    expect(await any.readMeta('reminder')).toBe('{"userId":"ben"}')
    expect((await ben.readOutbox()).map((operation) => operation.id)).toEqual(['op-ben'])
    expect(await ben.readAll('site_accesses')).toEqual([{ id: 'z-2', value: '0815' }])
    anna.close()
    ben.close()
    any.close()
  })

  /**
   * The office and the site of one browser, which the server narrows apart
   * (opengewerk#907): the records and the bookkeeping of the pulls are each
   * section's; what waits to be sent and what the application keeps are the
   * store's.
   */
  it('keeps the records and the pulls of the office apart from the site, and shares what waits', async () => {
    const tenant = aTenant()
    const site = await openLocalStore(tenant, 'anna')
    const office = await openLocalStore(tenant, 'anna', 'office')

    await site.write('site_accesses', [{ id: 'z-1', value: '0815' }])
    await site.writeMeta('cursor', 9)
    await office.write('site_accesses', [{ id: 'z-1' }])
    // The office starts again for its narrowing, and the site keeps its own.
    await office.restartPull(['site_accesses'], '{"site_accesses":"bare"}')

    expect(await site.readAll('site_accesses')).toEqual([{ id: 'z-1', value: '0815' }])
    expect(await office.readAll('site_accesses')).toEqual([])
    expect(await site.readMeta('cursor')).toBe(9)
    expect(await office.readMeta('cursor')).toBe(0)
    expect(await site.readMeta('narrowed')).toBeNull()

    await office.queue(aNote('op-office', 'Leiter im Flur'))
    await site.writeMeta('stopwatch', '{"userId":"anna"}')

    expect((await site.readOutbox()).map((operation) => operation.id)).toEqual(['op-office'])
    expect(await office.readMeta('stopwatch')).toBe('{"userId":"anna"}')
    site.close()
    office.close()
  })

  /**
   * After the update the office section has never pulled (opengewerk#907): it
   * begins with what the store pulled before, and opens it without a network.
   */
  it('begins a section that never pulled with what the store pulled before it had sections', async () => {
    const tenant = aTenant()
    const before = await openLocalStore(tenant, 'anna')

    await before.write('visits', [{ id: 'v-1', version: 1 }])
    await before.writeMeta('entities', 'visits')
    await before.writeMeta('cursor', 9)
    await before.writeMeta('narrowed', '{"visits":"all"}')
    before.close()

    // Another section's rows are not what the store pulled before; narrowed
    // apart, nor are they taken as pulled since.
    const other = await openLocalStore(tenant, 'anna', 'other')

    await other.writeMeta('narrowed', '{"visits":"other"}')
    await other.write('visits', [{ id: 'v-9', version: 1 }])
    other.close()

    const office = await openLocalStore(tenant, 'anna', 'office')

    // At once, for an application that reads the store before its client starts.
    expect(await office.readAll('visits')).toEqual([{ id: 'v-1', version: 1 }])

    const pulled = await office.beginPull(['visits'])

    expect(pulled.cursor).toBe(9)
    expect(pulled.narrowed).toBe('{"visits":"all"}')
    expect(pulled.rows.get('visits')).toEqual([{ id: 'v-1', version: 1 }])

    // Once only: what the office lets go of from then on is its own, also
    // when it is opened again.
    await office.restartPull(['visits'], '{"visits":"own"}')
    office.close()

    const again = await openLocalStore(tenant, 'anna', 'office')

    expect(await again.readAll('visits')).toEqual([])
    again.close()

    // Nor are the rows of another section copied, where nothing would read them.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`opengewerk.${tenant}`)

      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('not opened'))
      }
    })
    const kinds = await new Promise<string[]>((resolve) => {
      const request = raw.transaction('records').objectStore('records').getAll()

      request.onsuccess = () => {
        resolve((request.result as { entity: string }[]).map((row) => row.entity))
      }
    })

    raw.close()
    expect(kinds.filter((kind) => kind.startsWith('office/other'))).toEqual([])

    const site = await openLocalStore(tenant, 'anna')

    expect(await site.readAll('visits')).toEqual([{ id: 'v-1', version: 1 }])
    expect(await site.readMeta('cursor')).toBe(9)
    site.close()
  })

  /**
   * The page switched from the office to the site in the same tab, without a
   * network (opengewerk#907): the site shows what the office pulled since, for
   * the kinds both hold narrowed alike, and nothing of a kind they hold apart.
   */
  it('takes what another section pulled since, for the kinds both hold narrowed alike', async () => {
    const tenant = aTenant()
    const site = await openLocalStore(tenant, 'anna')

    await site.writeMeta('entities', 'notes,site_accesses')
    await site.writeMeta('narrowed', '{"notes":"all","site_accesses":"s-1:values"}')
    await site.write('notes', [
      { id: 'n-1', version: 1, text: 'Alt' },
      { id: 'n-3', version: 5, text: 'Hier neuer' },
    ])
    await site.write('site_accesses', [{ id: 'z-1', version: 1, value: '0815' }])
    site.close()

    const office = await openLocalStore(tenant, 'anna', 'office')

    await office.writeMeta('narrowed', '{"notes":"all","site_accesses":"s-1:bare"}')
    await office.write('notes', [
      { id: 'n-1', version: 2, text: 'Im Büro geändert' },
      { id: 'n-2', version: 1, text: 'Im Büro angelegt' },
      { id: 'n-3', version: 4, text: 'Dort älter' },
    ])
    await office.write('site_accesses', [{ id: 'z-1', version: 2 }])
    office.close()

    const again = await openLocalStore(tenant, 'anna')
    const notes = await again.readAll('notes')

    expect(
      notes
        .map((note) => note['text'])
        .sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(['Hier neuer', 'Im Büro angelegt', 'Im Büro geändert'])
    // The ways in are narrowed apart: the site keeps its own, with the value.
    expect(await again.readAll('site_accesses')).toEqual([{ id: 'z-1', version: 1, value: '0815' }])
    again.close()
  })

  it('lets go of the pulls of every section when another account takes the store over', async () => {
    const tenant = aTenant()
    const anna = await openLocalStore(tenant, 'anna', 'office')

    await anna.write('site_accesses', [{ id: 'z-1' }])
    await anna.writeMeta('cursor', 9)

    const ben = await openLocalStore(tenant, 'ben')
    const bensOffice = await openLocalStore(tenant, 'ben', 'office')

    expect(await bensOffice.readMeta('cursor')).toBeNull()
    expect(await bensOffice.readAll('site_accesses')).toEqual([])
    anna.close()
    ben.close()
    bensOffice.close()
  })

  it('reads and writes nothing more of the server for a tab still open for the account before', async () => {
    const tenant = aTenant()
    const anna = await openLocalStore(tenant, 'anna')
    const ben = await openLocalStore(tenant, 'ben')

    await ben.write('site_accesses', [{ id: 'z-2', value: '0815' }])

    // Anna's tab: a pull that arrives late, and a screen that reads.
    await expect(anna.write('site_accesses', [{ id: 'z-1', value: '4711' }])).rejects.toThrow(
      StoreTakenOver,
    )
    await expect(anna.readAll('site_accesses')).rejects.toThrow(StoreTakenOver)
    // The ways the client reads and takes the store since opengewerk#899.
    await expect(anna.readPulled(['site_accesses'])).rejects.toThrow(StoreTakenOver)
    await expect(anna.claimPull('site_accesses')).rejects.toThrow(StoreTakenOver)
    await expect(anna.beginPull(['site_accesses'])).rejects.toThrow(StoreTakenOver)
    await expect(anna.writeMeta('cursor', 42)).rejects.toThrow(StoreTakenOver)

    await expect(anna.keepFile(photo, false)).rejects.toThrow(StoreTakenOver)

    // Her own change and her photo still wait for her.
    await anna.queue(aNote('op-anna', 'Leiter im Flur'))
    await anna.keepFile(photo, true)

    expect(await ben.readAll('site_accesses')).toEqual([{ id: 'z-2', value: '0815' }])
    expect(await ben.readMeta('cursor')).toBeNull()
    anna.close()
    ben.close()
  })

  it('takes no page of a pull and no start from the beginning for a tab still open for the account before', async () => {
    const tenant = aTenant()
    const anna = await openLocalStore(tenant, 'anna')
    const ben = await openLocalStore(tenant, 'ben')

    await expect(
      anna.writePulled({
        changes: [{ entity: 'site_accesses', rows: [{ id: 'z-1', value: '4711' }] }],
        from: 0,
        to: 5,
        narrowed: null,
        settled: null,
        entities: '',
      }),
    ).rejects.toThrow(StoreTakenOver)
    await expect(anna.restartPull(['site_accesses'], '{"site_accesses":"all"}')).rejects.toThrow(
      StoreTakenOver,
    )

    expect(await ben.readAll('site_accesses')).toEqual([])
    expect(await ben.readMeta('cursor')).toBeNull()
    expect(await ben.readMeta('narrowed')).toBeNull()
    anna.close()
    ben.close()
  })
})

/**
 * The tabs of a browser share the store and its cursor, and do not take turns
 * pulling (opengewerk#899). A page of a pull is written only while the store
 * stands where the pull began, and going back to the start is all or nothing.
 */
describe('the pulls of the tabs of one browser', () => {
  const visit = (id: string) => ({ id, version: 1 })

  it('writes a page only while the cursor of the store is the one the pull asked from', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    expect(
      await store.writePulled({
        changes: [{ entity: 'visits', rows: [visit('v-1')] }],
        from: 0,
        to: 5,
        narrowed: null,
        settled: null,
        entities: '',
      }),
    ).toBe('written')

    // Another tab asked from 0 as well, before this page was in.
    expect(
      await store.writePulled({
        changes: [{ entity: 'visits', rows: [visit('v-2')] }],
        from: 0,
        to: 9,
        narrowed: null,
        settled: null,
        entities: '',
      }),
    ).toBe('moved')

    expect(await store.readAll('visits')).toEqual([visit('v-1')])
    expect(await store.readMeta('cursor')).toBe(5)
    store.close()
  })

  it('writes a page only while the store keeps the narrowing the answer named', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.restartPull([], '{"visits":"all"}')

    // An answer from before the narrowing changed, written after the start
    // from the beginning that another tab made for the new one.
    expect(
      await store.writePulled({
        changes: [{ entity: 'visits', rows: [visit('v-1')] }],
        from: 0,
        to: 5,
        narrowed: '{"visits":"user:u-1"}',
        settled: null,
        entities: '',
      }),
    ).toBe('moved')
    expect(await store.readAll('visits')).toEqual([])
    expect(await store.readMeta('cursor')).toBe(0)

    expect(
      await store.writePulled({
        changes: [{ entity: 'visits', rows: [visit('v-1')] }],
        from: 0,
        to: 5,
        narrowed: '{"visits":"all"}',
        settled: null,
        entities: '',
      }),
    ).toBe('written')
    expect(await store.readMeta('cursor')).toBe(5)
    store.close()
  })

  it('keeps what the rows add up to with the last page, and nothing of it with a page it refuses', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.restartPull([], '{"visits":"all"}')

    expect(
      await store.writePulled({
        changes: [],
        from: 3,
        to: 9,
        narrowed: '{"visits":"all"}',
        settled: '{"visits":"all"}',
        entities: '',
      }),
    ).toBe('moved')
    expect(await store.readMeta('narrowed-settled')).toBe('')

    expect(
      await store.writePulled({
        changes: [],
        from: 0,
        to: 9,
        narrowed: '{"visits":"all"}',
        settled: '{"visits":"all"}',
        entities: '',
      }),
    ).toBe('written')
    expect(await store.readMeta('narrowed-settled')).toBe('{"visits":"all"}')
    store.close()
  })

  it('goes back to the start for a new narrowing with the named kinds, and nothing settled', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.writePulled({
      changes: [
        { entity: 'visits', rows: [visit('v-1')] },
        { entity: 'shelves', rows: [visit('s-1')] },
      ],
      from: 0,
      to: 9,
      narrowed: null,
      settled: null,
      entities: '',
    })
    await store.writeMeta('narrowed-settled', '{"visits":"all"}')

    await store.restartPull(['visits'], '{"visits":"user:u-1"}')

    expect(await store.readAll('visits')).toEqual([])
    expect(await store.readAll('shelves')).toEqual([visit('s-1')])
    expect(await store.readMeta('cursor')).toBe(0)
    expect(await store.readMeta('narrowed-settled')).toBe('')
    expect(await store.readMeta('narrowed')).toBe('{"visits":"user:u-1"}')
    store.close()
  })

  /**
   * Two tabs of two builds, one that knows a kind of record more: one cursor
   * moved by the other would pass rows of that kind. A page goes in only from
   * a build that knows the kinds the store is kept for, no more and no fewer.
   */
  it('writes a page only from a build that knows the kinds the store is kept for', async () => {
    const store = await openLocalStore(aTenant(), 'anna')
    const page = (entities: string) => ({
      changes: [{ entity: 'visits', rows: [visit('v-1')] }],
      from: 0,
      to: 5,
      narrowed: null,
      settled: null,
      entities,
    })

    await store.writeMeta('entities', 'shelves,visits')

    // A build that does not know shelves, and one that knows a kind more.
    expect(await store.writePulled(page('visits'))).toBe('newerBuild')
    expect(await store.writePulled(page('letters,shelves,visits'))).toBe('fewerKinds')
    expect(await store.readAll('visits')).toEqual([])
    expect(await store.readMeta('cursor')).toBeNull()

    expect(await store.writePulled(page('shelves,visits'))).toBe('written')
    expect(await store.readMeta('cursor')).toBe(5)
    store.close()
  })

  /**
   * A tab of a build from before checked writes sets the cursor itself, past
   * rows of kinds it does not know (opengewerk#899). A page goes in only while
   * the cursor is the one the last checked write left.
   */
  it('writes no page over a cursor a writer that checks nothing set since', async () => {
    const store = await openLocalStore(aTenant(), 'anna')
    const page = (from: number, to: number) => ({
      changes: [{ entity: 'visits', rows: [visit('v-1')] }],
      from,
      to,
      narrowed: null,
      settled: null,
      entities: '',
    })

    // A store kept before writes were checked takes the first page.
    await store.writeMeta('cursor', 3)
    expect(await store.writePulled(page(3, 5))).toBe('written')
    expect(await store.readMeta('cursor-checked')).toBe(5)

    // The tab from before moves the cursor on its own.
    await store.writeMeta('cursor', 12)

    expect(await store.writePulled(page(12, 15))).toBe('unchecked')
    expect(await store.readMeta('cursor')).toBe(12)

    await store.claimPull('')

    expect(await store.readMeta('cursor-checked')).toBe(0)
    expect(await store.writePulled(page(0, 15))).toBe('written')
    store.close()
  })

  it('is taken back for the kinds of a build from the start, with nothing settled', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.writeMeta('entities', 'visits')
    await store.writeMeta('cursor', 9)
    await store.writeMeta('narrowed-settled', '{"visits":"all"}')

    await store.claimPull('shelves,visits')

    expect(await store.readMeta('entities')).toBe('shelves,visits')
    expect(await store.readMeta('cursor')).toBe(0)
    expect(await store.readMeta('narrowed-settled')).toBe('')
    store.close()
  })

  it('begins a pull where its cursor stands for every kind of a build, and keeps the list of the build', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.writeMeta('entities', 'notes,shelves,visits')
    await store.writeMeta('cursor', 9)
    await store.writeMeta('cursor-checked', 9)
    await store.writeMeta('narrowed-settled', '{"visits":"all"}')
    await store.write('visits', [visit('v-1')])

    const pulled = await store.beginPull(['visits', 'shelves'])

    expect(pulled.cursor).toBe(9)
    expect(pulled.checked).toBe(9)
    expect(pulled.settled).toBe('{"visits":"all"}')
    expect(pulled.rows.get('visits')).toEqual([visit('v-1')])
    // The shorter list as well: a build that knows less moves the cursor past
    // the rows it drops, and a longer list must not vouch for that cursor.
    expect(await store.readMeta('entities')).toBe('shelves,visits')
    expect(await store.readMeta('cursor')).toBe(9)
    store.close()
  })

  it('begins a pull from the start for a build the store is kept for fewer kinds than, with nothing settled', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.writeMeta('entities', 'visits')
    await store.writeMeta('cursor', 9)
    await store.writeMeta('cursor-checked', 9)
    await store.writeMeta('narrowed-settled', '{"visits":"all"}')
    await store.write('visits', [visit('v-1')])

    const pulled = await store.beginPull(['shelves', 'visits'])

    expect(pulled.cursor).toBe(0)
    expect(pulled.checked).toBe(0)
    expect(pulled.settled).toBe('')
    // The rows stay: a pull from the start overwrites them by their id.
    expect(pulled.rows.get('visits')).toEqual([visit('v-1')])
    expect(await store.readMeta('entities')).toBe('shelves,visits')
    expect(await store.readMeta('cursor')).toBe(0)
    expect(await store.readMeta('cursor-checked')).toBe(0)
    expect(await store.readMeta('narrowed-settled')).toBe('')
    store.close()
  })

  it('goes back to the start only while it keeps the narrowing the kinds were chosen by', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.restartPull([], '{"visits":"all"}')
    await store.writePulled({
      changes: [{ entity: 'visits', rows: [visit('v-1')] }],
      from: 0,
      to: 9,
      narrowed: '{"visits":"all"}',
      settled: null,
      entities: '',
    })

    // Chosen by a narrowing another tab has replaced since.
    expect(await store.restartPull(['shelves'], '{"visits":"own"}', '{"visits":"part"}')).toBe(
      false,
    )
    expect(await store.readAll('visits')).toEqual([visit('v-1')])
    expect(await store.readMeta('cursor')).toBe(9)
    expect(await store.readMeta('narrowed')).toBe('{"visits":"all"}')

    expect(await store.restartPull(['visits'], '{"visits":"own"}', '{"visits":"all"}')).toBe(true)
    expect(await store.readAll('visits')).toEqual([])
    expect(await store.readMeta('narrowed')).toBe('{"visits":"own"}')
    store.close()
  })

  it('reads where its pulls stand and its rows together', async () => {
    const store = await openLocalStore(aTenant(), 'anna')

    await store.restartPull([], '{"visits":"all"}')
    await store.writePulled({
      changes: [
        { entity: 'visits', rows: [visit('v-1')] },
        { entity: 'shelves', rows: [visit('s-1')] },
      ],
      from: 0,
      to: 9,
      narrowed: '{"visits":"all"}',
      settled: '{"visits":"all"}',
      entities: '',
    })

    const read = await store.readPulled(['visits', 'notes'])

    expect(read.cursor).toBe(9)
    expect(read.narrowed).toBe('{"visits":"all"}')
    expect(read.settled).toBe('{"visits":"all"}')
    expect(read.rows.get('visits')).toEqual([visit('v-1')])
    expect(read.rows.get('notes')).toEqual([])
    expect(read.rows.has('shelves')).toBe(false)
    store.close()
  })
})

describe('what waits on a device for nobody', () => {
  /** A store of a version that did not yet say whose a change is, with two changes and a photo. */
  async function storeFromBefore(tenant: string): Promise<void> {
    const before = await openLocalStore(tenant)

    await before.queue({
      ...aNote('op-late', 'Typenschild'),
      recordedAt: new Date('2026-10-12T08:14:00Z'),
    })
    await before.queue({
      ...aNote('op-early', 'Leiter im Flur'),
      recordedAt: new Date('2026-10-12T07:52:00Z'),
    })
    await before.keepFile(photo, true)
    before.close()
  }

  it('is shown to the person signed in, oldest first, beside what is theirs', async () => {
    const tenant = aTenant()

    await storeFromBefore(tenant)

    const anna = await openLocalStore(tenant, 'anna')

    await anna.queue(aNote('op-anna', 'Zählerstand'))

    const unowned = await anna.readUnowned()

    expect(unowned.operations.map((operation) => operation.id)).toEqual(['op-early', 'op-late'])
    expect(unowned.files).toEqual([
      { sha256: photo.sha256, mediaType: 'image/jpeg', since: expect.any(Number) as number },
    ])
    expect((await anna.readOutbox()).map((operation) => operation.id)).toEqual(['op-anna'])
    anna.close()
  })

  it('goes out for the person who said they made it, and only what they were shown', async () => {
    const tenant = aTenant()

    await storeFromBefore(tenant)

    const anna = await openLocalStore(tenant, 'anna')
    const shown = await anna.readUnowned()

    // Queued for nobody after the list was shown, by a tab of a version before.
    const late = await openLocalStore(tenant)

    await late.queue(aNote('op-unseen', 'Nicht gezeigt'))
    late.close()

    expect(
      await anna.adoptUnowned(
        shown.operations.map((operation) => operation.id),
        shown.files.map((file) => file.sha256),
      ),
    ).toEqual({ operations: ['op-early', 'op-late'], files: [photo.sha256] })

    expect((await anna.readOutbox()).map((operation) => operation.id).sort()).toEqual([
      'op-early',
      'op-late',
    ])
    expect((await anna.waitingFiles()).map((file) => file.sha256)).toEqual([photo.sha256])
    expect((await anna.readUnowned()).operations.map((operation) => operation.id)).toEqual([
      'op-unseen',
    ])
    anna.close()

    // Adopted is Anna's, and nobody else sends it.
    const ben = await openLocalStore(tenant, 'ben')

    expect(await ben.readOutbox()).toEqual([])
    expect(await ben.waitingFiles()).toEqual([])
    expect((await ben.readUnowned()).operations.map((operation) => operation.id)).toEqual([
      'op-unseen',
    ])
    ben.close()
  })

  it('is adopted by nobody from a tab of an account that no longer holds the store', async () => {
    const tenant = aTenant()

    await storeFromBefore(tenant)

    const anna = await openLocalStore(tenant, 'anna')
    const shown = await anna.readUnowned()
    const ben = await openLocalStore(tenant, 'ben')

    await expect(
      anna.adoptUnowned(
        shown.operations.map((operation) => operation.id),
        shown.files.map((file) => file.sha256),
      ),
    ).rejects.toBeInstanceOf(StoreTakenOver)

    expect((await ben.readUnowned()).operations).toHaveLength(2)
    expect(await ben.readOutbox()).toEqual([])
    anna.close()
    ben.close()
  })

  it('leaves the device when let go, and takes nothing of anybody with it', async () => {
    const tenant = aTenant()

    await storeFromBefore(tenant)

    const anna = await openLocalStore(tenant, 'anna')
    const shown = await anna.readUnowned()
    const own = { ...photo, sha256: 'c'.repeat(64) }

    await anna.queue(aNote('op-anna', 'Zählerstand'))
    await anna.keepFile(own, true)
    // Another tab of Anna's took one of them on in the meantime.
    await anna.adoptUnowned(['op-late' as unknown as OperationId], [])

    await anna.dropUnowned(
      shown.operations.map((operation) => operation.id),
      shown.files.map((file) => file.sha256),
    )

    expect(await anna.readUnowned()).toEqual({ operations: [], files: [] })
    expect(await anna.readFile(photo.sha256)).toBeNull()
    expect((await anna.readOutbox()).map((operation) => operation.id).sort()).toEqual([
      'op-anna',
      'op-late',
    ])
    expect((await anna.waitingFiles()).map((file) => file.sha256)).toEqual([own.sha256])
    anna.close()
  })

  it('is taken on by nobody from a stale tab, once another account said it was theirs', async () => {
    const tenant = aTenant()

    await storeFromBefore(tenant)

    // A tab of Anna shows the list.
    const stale = await openLocalStore(tenant, 'anna')
    const shown = await stale.readUnowned()
    const ben = await openLocalStore(tenant, 'ben')

    // Ben says the changes and the photo are his.
    await ben.adoptUnowned(
      shown.operations.map((operation) => operation.id),
      shown.files.map((file) => file.sha256),
    )
    ben.close()

    // Anna signs in again in another tab, and the store is hers again; the
    // stale tab clicks on the list it showed before.
    const again = await openLocalStore(tenant, 'anna')

    expect(
      await stale.adoptUnowned(
        shown.operations.map((operation) => operation.id),
        shown.files.map((file) => file.sha256),
      ),
    ).toEqual({ operations: [], files: [] })

    expect(await again.readOutbox()).toEqual([])
    expect(await again.waitingFiles()).toEqual([])
    stale.close()
    again.close()
  })

  it('is let go by nobody from a stale tab, once another account said it was theirs', async () => {
    const tenant = aTenant()

    await storeFromBefore(tenant)

    const stale = await openLocalStore(tenant, 'anna')
    const shown = await stale.readUnowned()
    const ben = await openLocalStore(tenant, 'ben')

    await ben.adoptUnowned(
      shown.operations.map((operation) => operation.id),
      shown.files.map((file) => file.sha256),
    )
    ben.close()

    const again = await openLocalStore(tenant, 'anna')

    await stale.dropUnowned(
      shown.operations.map((operation) => operation.id),
      shown.files.map((file) => file.sha256),
    )

    // Ben's two changes and his photo wait for him.
    expect(await waitingIn(tenant)).toBe(3)
    stale.close()
    again.close()
  })
})
