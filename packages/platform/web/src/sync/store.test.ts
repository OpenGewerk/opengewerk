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
})
