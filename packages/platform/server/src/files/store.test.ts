import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStore, StoredFileDamagedError, StoredFileMissingError } from './store.js'

/**
 * The store is the one place where a record that went in can come back
 * different, so the tests are about the ways that could happen: a file
 * changed on disk, a file missing, a name that is not a hash.
 */

let root: string
let store: FileStore

const contents = new TextEncoder().encode('%PDF-1.7 Probe 2026-0001')
const hash = createHash('sha256').update(contents).digest('hex')

/** Where the store keeps bytes: two folders from the hash, then the hash. */
function pathParts(bytes: Uint8Array): string[] {
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  return [sha256.slice(0, 2), sha256.slice(2, 4), sha256]
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-store-'))
  store = new FileStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Every file under the root, as paths relative to it. */
function everything(): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll('\\', '/'),
    )
}

describe('the file store', () => {
  it('keeps a file under its hash, two directories deep', async () => {
    const stored = await store.put(contents)

    expect(stored).toEqual({ sha256: hash, sizeBytes: contents.byteLength })
    expect(everything()).toEqual([`${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`])
  })

  it('gives the same bytes back', async () => {
    await store.put(contents)

    expect(await store.get(hash)).toEqual(contents)
  })

  it('stores the same file once, however often it is put', async () => {
    await store.put(contents)
    await store.put(contents)
    await store.put(new Uint8Array(contents))

    expect(everything()).toHaveLength(1)
  })

  it('leaves no temporary file behind', async () => {
    await store.put(contents)
    await store.put(new TextEncoder().encode('ein anderes Dokument'))

    // The restore check looks at every file and verifies the ones named like
    // a hash. A stray temporary file would be counted and never checked.
    expect(everything().every((path) => /\/[0-9a-f]{64}$/.test(path))).toBe(true)
  })

  it('refuses a file that was changed on disk, rather than handing it out', async () => {
    await store.put(contents)
    const path = join(root, hash.slice(0, 2), hash.slice(2, 4), hash)
    writeFileSync(path, readFileSync(path).toString().replace('0001', '0002'))

    await expect(store.get(hash)).rejects.toThrow(StoredFileDamagedError)
  })

  it('says which file is missing when it is not there', async () => {
    await expect(store.get(hash)).rejects.toThrow(StoredFileMissingError)
    await expect(store.get(hash)).rejects.toThrow(hash)
  })

  it('does not take a name that is not a hash, so nothing walks out of the store', async () => {
    await expect(store.get('../../etc/passwd')).rejects.toThrow('Not a SHA-256')
    await expect(store.get(hash.toUpperCase())).rejects.toThrow('Not a SHA-256')
  })
})

/**
 * The sweep of the store (#657): what no tenant holds any more goes once it
 * is older than the grace, and nothing else. `held` stands in for the
 * database, which answers for every tenant.
 */
describe('the sweep of the file store', () => {
  const day = 24 * 60 * 60 * 1000
  const before = () => new Date(Date.now() - day)

  /** Stores bytes and makes them as old as a week. */
  async function oldFile(text: string): Promise<string> {
    const { sha256 } = await store.put(new TextEncoder().encode(text))
    const week = new Date(Date.now() - 7 * day)

    utimesSync(join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256), week, week)

    return sha256
  }

  const holding =
    (...names: string[]) =>
    async (asked: readonly string[]) =>
      new Set(asked.filter((name) => names.includes(name)))

  it('dates a new file from its put, not from its writing (#991)', async () => {
    // A clock that moves on with every reading, an hour each: the file carries
    // the reading after it was put in place, and not the one from before. At
    // the first reading the name is still free, at the second it is taken,
    // and the temporary file is still there: the name is dated before it goes.
    const start = Date.now()
    const bytes = new TextEncoder().encode('Lieferschein')
    const path = join(root, ...pathParts(bytes))
    const there: boolean[] = []
    const temporary: boolean[] = []
    let readings = 0
    const moving = new FileStore(root, () => {
      there.push(existsSync(path))
      temporary.push(readdirSync(dirname(path)).some((name) => name.endsWith('.part')))

      return new Date(start + ++readings * 60 * 60 * 1000)
    })

    await moving.put(bytes)

    expect(temporary).toEqual([true, true])

    expect(there).toEqual([false, true])
    expect(Math.abs(statSync(path).mtime.getTime() - (start + 2 * 60 * 60 * 1000))).toBeLessThan(
      2000,
    )
  })

  it('leaves a file a second put of the same bytes placed meanwhile (#991)', async () => {
    // The other put comes while this one dates its temporary file: the name
    // keeps its file, and both puts date it as of now.
    const bytes = new TextEncoder().encode('Lieferschein')
    const path = join(root, ...pathParts(bytes))
    let other: number | undefined
    const racing = new FileStore(root, () => {
      if (other === undefined) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes)
        other = statSync(path).ino
      }

      return new Date()
    })

    await racing.put(bytes)

    expect(statSync(path).ino).toBe(other)
    expect(readdirSync(dirname(path))).toEqual([basename(path)])
  })

  // Windows makes links only with rights a test does not have; the CI runs it.
  it.skipIf(process.platform === 'win32')(
    'dates a link at a name of the store and not what it points at (#991)',
    async () => {
      const bytes = new TextEncoder().encode('Lieferschein')
      const path = join(root, ...pathParts(bytes))
      const outside = join(root, '..', `outside-${basename(root)}`)
      const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

      writeFileSync(outside, bytes)
      utimesSync(outside, week, week)
      mkdirSync(dirname(path), { recursive: true })
      symlinkSync(outside, path)

      await store.put(bytes)

      expect(Math.abs(statSync(outside).mtime.getTime() - week.getTime())).toBeLessThan(2000)
      expect(lstatSync(path).isSymbolicLink()).toBe(true)
      rmSync(outside, { force: true })
    },
  )

  it('dates a file in place once more when the first try fails (#991)', async () => {
    // The clock stands in for a passing error of the file system: it fails
    // at the second reading, the first after the file is in place.
    const bytes = new TextEncoder().encode('Lieferschein')
    let readings = 0
    const flaky = new FileStore(root, () => {
      readings += 1

      if (readings === 2) {
        throw new Error('EIO')
      }

      return new Date()
    })

    await expect(flaky.put(bytes)).resolves.toMatchObject({ sizeBytes: bytes.byteLength })
    expect(readings).toBe(3)
  })

  it('keeps a file in place when it cannot be dated, and says so (#991)', async () => {
    const bytes = new TextEncoder().encode('Lieferschein')
    const path = join(root, ...pathParts(bytes))
    let readings = 0
    const broken = new FileStore(root, () => {
      readings += 1

      if (readings > 1) {
        throw new Error('EIO')
      }

      return new Date()
    })

    await expect(broken.put(bytes)).rejects.toThrow('EIO')
    expect(readFileSync(path)).toEqual(Buffer.from(bytes))
    expect(readdirSync(dirname(path))).toEqual([basename(path)])
  })

  it('keeps a file as new as the last put of the same bytes', async () => {
    const sha256 = await oldFile('Rechnung')
    const path = join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)

    await store.put(new TextEncoder().encode('Rechnung'))

    expect(statSync(path).mtime.getTime()).toBeGreaterThan(before().getTime())
  })

  it('takes out an old file nobody holds, and keeps one a tenant holds', async () => {
    const orphan = await oldFile('Verwaist')
    const kept = await oldFile('Gehalten')

    expect(await store.sweep(holding(kept), before())).toBe(1)
    await expect(store.get(orphan)).rejects.toThrow(StoredFileMissingError)
    expect(new TextDecoder().decode(await store.get(kept))).toBe('Gehalten')
  })

  it('keeps a file nobody holds yet while it is younger than the grace, and does not ask about it', async () => {
    const { sha256 } = await store.put(new TextEncoder().encode('Gerade gekommen'))
    const asked: string[] = []

    expect(
      await store.sweep(async (names) => {
        asked.push(...names)

        return new Set<string>()
      }, before()),
    ).toBe(0)
    expect(asked).toEqual([])
    expect(new TextDecoder().decode(await store.get(sha256))).toBe('Gerade gekommen')
  })

  it('keeps a file put again while the sweep asked about it', async () => {
    const sha256 = await oldFile('Noch einmal')

    // The same bytes arrive between the answer and the removal: the upload
    // that brings them writes its row a moment later.
    const removed = await store.sweep(async () => {
      await store.put(new TextEncoder().encode('Noch einmal'))

      return new Set<string>()
    }, before())

    expect(removed).toBe(0)
    expect(new TextDecoder().decode(await store.get(sha256))).toBe('Noch einmal')
    expect(everything()).toEqual([`${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`])
  })

  it('dates a file it puts back as of now (#991)', async () => {
    const sha256 = await oldFile('Zurückgelegt')
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const named: boolean[] = []
    // Dated while it lies aside: the name never shows the older time.
    const sweeping = new FileStore(root, () => {
      named.push(existsSync(join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)))

      return later
    })

    // Put again between the answer and the move, with the clock of the
    // machine: the sweep puts the file back, and it carries the time of that.
    await sweeping.sweep(async () => {
      await store.put(new TextEncoder().encode('Zurückgelegt'))

      return new Set<string>()
    }, before())

    const path = join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)

    expect(named).toEqual([false])
    expect(Math.abs(statSync(path).mtime.getTime() - later.getTime())).toBeLessThan(2000)
  })

  it('goes on with the other files when it cannot date one it puts back (#991)', async () => {
    // The first name the sweep asks about is put again in between, whichever
    // the store lists first, and dating it fails; the second is taken anyway.
    await oldFile('Gebraucht')
    await oldFile('Verwaist')

    let first = ''
    let second = ''
    const failing = new FileStore(root, () => {
      throw new Error('EIO')
    })

    await expect(
      failing.sweep(async (names) => {
        ;[first = '', second = ''] = names

        utimesSync(join(root, first.slice(0, 2), first.slice(2, 4), first), new Date(), new Date())

        return new Set<string>()
      }, before()),
    ).rejects.toThrow('EIO')

    expect(second).not.toBe('')
    expect((await store.get(first)).byteLength).toBeGreaterThan(0)
    await expect(store.get(second)).rejects.toThrow(StoredFileMissingError)
    expect(everything()).toHaveLength(1)
  })

  it('reports the first error when a later batch gets no answer (#991)', async () => {
    // More than a batch of old files: in the first batch one is put again
    // and cannot be dated, the second batch gets no answer at all.
    const week = new Date(Date.now() - 7 * day)

    for (let index = 0; index <= 1000; index += 1) {
      const sha256 = createHash('sha256').update(`Altlast ${index}`).digest('hex')
      const folder = join(root, sha256.slice(0, 2), sha256.slice(2, 4))

      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, sha256), `Altlast ${index}`)
      utimesSync(join(folder, sha256), week, week)
    }

    let batches = 0
    const failing = new FileStore(root, () => {
      throw new Error('EIO')
    })

    await expect(
      failing.sweep(async (names) => {
        batches += 1

        if (batches > 1) {
          throw new Error('held down')
        }

        const [first = ''] = names

        utimesSync(join(root, first.slice(0, 2), first.slice(2, 4), first), new Date(), new Date())

        return new Set<string>()
      }, before()),
    ).rejects.toThrow('EIO')

    expect(batches).toBe(2)
    expect(everything()).toHaveLength(2)
  })

  it('leaves a file another put placed while it lay aside (#991)', async () => {
    const sha256 = await oldFile('Inzwischen neu')
    const path = join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
    let other: number | undefined
    // While the file lies aside and is dated, a put places the same bytes.
    const sweeping = new FileStore(root, () => {
      if (other === undefined) {
        writeFileSync(path, 'Inzwischen neu')
        other = statSync(path).ino
      }

      return new Date()
    })

    await sweeping.sweep(async () => {
      await store.put(new TextEncoder().encode('Inzwischen neu'))

      return new Set<string>()
    }, before())

    expect(statSync(path).ino).toBe(other)
    expect(everything()).toEqual([`${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`])
  })

  it('takes out what an unfinished write or sweep left behind once it is old', async () => {
    const sha256 = await oldFile('Daneben')
    const folder = join(root, sha256.slice(0, 2), sha256.slice(2, 4))
    const week = new Date(Date.now() - 7 * day)

    for (const stray of [`${sha256}.1234.part`, `${sha256}.5678.gone`]) {
      writeFileSync(join(folder, stray), 'halb')
      utimesSync(join(folder, stray), week, week)
    }
    writeFileSync(join(folder, `${sha256}.9999.part`), 'gerade')

    await store.sweep(holding(sha256), before())

    expect(everything().sort()).toEqual(
      [`${sha256}`, `${sha256}.9999.part`].map(
        (name) => `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${name}`,
      ),
    )
  })
})
