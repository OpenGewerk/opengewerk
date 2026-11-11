import { crc32 } from 'node:zlib'

/**
 * A ZIP archive without compression (#318), written entry by entry so that a
 * customer with years of photos does not have to fit into memory at once.
 * The answer to a request for access is one: a PDF, a JSON file and the
 * stored files of the person. Photos and PDFs are compressed already, and the
 * JSON is small next to them, so storing saves a dependency and costs little.
 *
 * Names are UTF-8 (bit 11), which every current unpacker reads, umlauts
 * included. Without ZIP64: an archive stops at 65 535 entries and 4 GiB, and
 * one that would go beyond is refused before its first byte. A name stops at
 * 65 535 bytes, the most its field holds; a longer one is refused when it is
 * its turn.
 */

/**
 * An entry and how to get its bytes, asked for when it is its turn. What
 * comes back may rename the entry, for a file that could not be read and is
 * replaced by a line of text.
 */
export interface ZipEntry {
  readonly name: string
  readonly bytes: () => Promise<Uint8Array | { readonly bytes: Uint8Array; readonly name: string }>
}

/** Why an archive cannot be written. */
export class ZipTooLargeError extends Error {}

const utf8 = new TextEncoder()
const maxEntries = 0xffff
const maxBytes = 0xffffffff
const maxName = 0xffff

/** The date and time as an archive keeps them, in the local time it is given. */
export function dosMoment(at: {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}): { readonly time: number; readonly date: number } {
  return {
    time: (at.hour << 11) | (at.minute << 5) | Math.floor(at.second / 2),
    date: ((Math.max(at.year, 1980) - 1980) << 9) | (at.month << 5) | at.day,
  }
}

function header(size: number): { readonly bytes: Uint8Array; readonly view: DataView } {
  const bytes = new Uint8Array(size)

  return { bytes, view: new DataView(bytes.buffer) }
}

/**
 * Names made unique within the archive: a second "Foto.jpg" in the same
 * folder becomes "Foto (2).jpg". Slashes separate folders, backslashes and
 * a leading slash or dots do not survive.
 */
export function uniqueNames(names: readonly string[]): string[] {
  return names.map(nameMaker())
}

/** A character no unpacker should be asked to put into a name: a control character or one Windows refuses. */
function unfit(character: string): boolean {
  return character.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(character)
}

/** What a part of a name loses at its end: white space and dots. */
const endOfPart = /^[\s.]$/

/**
 * A part without the white space and dots at its end, one character at a
 * time (opengewerk#916): a pattern for the whole run would try every place in
 * it as its start, and a name of many dots would hold the server for seconds.
 */
function withoutEnd(part: string): string {
  let end = part.length

  while (end > 0 && endOfPart.test(part.charAt(end - 1))) {
    end -= 1
  }

  return part.slice(0, end)
}

/**
 * A name as the archive may hold it: backslashes become slashes, slashes
 * separate folders, and a part loses the white space at its start and the
 * white space and dots at its end, which Windows drops when it unpacks
 * (opengewerk#916); "Foto." would be "Foto" there and "..." the folder it
 * stands in. A part with nothing left does not survive, "." and ".." among
 * them, and a name with nothing left is "Datei". A name it gives back comes
 * back the same when it is cleaned again, so that the archive keeps the names
 * the answer gave it.
 */
export function cleanName(raw: string): string {
  const name = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((part) =>
      withoutEnd(
        [...part].map((character) => (unfit(character) ? '_' : character)).join(''),
      ).trimStart(),
    )
    .filter((part) => part !== '')
    .join('/')

  return name === '' ? 'Datei' : name
}

/**
 * A name as the archive compares it: in capitals, close to Windows, which
 * compares in capitals one character at a time. Where the two differ, this
 * takes more names for the same ("ß" and "SS"), which gives one "(2)" more
 * and never two files one name. Lower case would not do: it writes a sigma at
 * the end of a word otherwise than inside one, and "aΣ" and "aσ" stayed two
 * names until ".txt" came after them (opengewerk#916).
 */
function folded(name: string): string {
  return name.toUpperCase()
}

/** Makes each name it is given unique among those it made before. */
export function nameMaker(): (raw: string) => string {
  const taken = new Set<string>()
  // Where the count of each name stopped: a hundredth "Foto.jpg" tries
  // "Foto (100).jpg" first and not every number from 2 again.
  const counters = new Map<string, number>()

  return (raw) => {
    const fallback = cleanName(raw)
    const dot = fallback.lastIndexOf('.')
    const slash = fallback.lastIndexOf('/')
    const [stem, extension] =
      dot > slash + 1 ? [fallback.slice(0, dot), fallback.slice(dot)] : [fallback, '']
    const key = folded(fallback)
    let candidate = fallback
    let counter = counters.get(key) ?? 2

    while (taken.has(folded(candidate))) {
      candidate = `${stem} (${String(counter)})${extension}`
      counter += 1
    }

    counters.set(key, counter)
    taken.add(folded(candidate))

    return candidate
  }
}

/**
 * The archive as a sequence of pieces: for each entry its local header and
 * its bytes, then the central directory and its end.
 */
export async function* zipPieces(
  entries: readonly ZipEntry[],
  moment: { readonly time: number; readonly date: number },
): AsyncGenerator<Uint8Array> {
  if (entries.length > maxEntries) {
    throw new ZipTooLargeError('Das Archiv hätte mehr als 65 535 Dateien.')
  }

  const unique = nameMaker()
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const got = await entry.bytes()
    const bytes = got instanceof Uint8Array ? got : got.bytes
    const name = utf8.encode(unique(got instanceof Uint8Array ? entry.name : got.name))
    const checksum = crc32(bytes)

    if (name.length > maxName) {
      throw new ZipTooLargeError('Ein Name im Archiv wäre länger als 65 535 Byte.')
    }

    if (offset + 30 + name.length + bytes.length > maxBytes) {
      throw new ZipTooLargeError('Das Archiv würde größer als 4 GiB.')
    }

    const local = header(30 + name.length)

    local.view.setUint32(0, 0x04034b50, true)
    local.view.setUint16(4, 20, true)
    local.view.setUint16(6, 0x0800, true)
    local.view.setUint16(8, 0, true)
    local.view.setUint16(10, moment.time, true)
    local.view.setUint16(12, moment.date, true)
    local.view.setUint32(14, checksum, true)
    local.view.setUint32(18, bytes.length, true)
    local.view.setUint32(22, bytes.length, true)
    local.view.setUint16(26, name.length, true)
    local.view.setUint16(28, 0, true)
    local.bytes.set(name, 30)

    const record = header(46 + name.length)

    record.view.setUint32(0, 0x02014b50, true)
    record.view.setUint16(4, 20, true)
    record.view.setUint16(6, 20, true)
    record.view.setUint16(8, 0x0800, true)
    record.view.setUint16(10, 0, true)
    record.view.setUint16(12, moment.time, true)
    record.view.setUint16(14, moment.date, true)
    record.view.setUint32(16, checksum, true)
    record.view.setUint32(20, bytes.length, true)
    record.view.setUint32(24, bytes.length, true)
    record.view.setUint16(28, name.length, true)
    record.view.setUint32(42, offset, true)
    record.bytes.set(name, 46)
    central.push(record.bytes)

    yield local.bytes
    yield bytes
    offset += local.bytes.length + bytes.length
  }

  const size = central.reduce((sum, record) => sum + record.length, 0)

  if (offset + size + 22 > maxBytes) {
    throw new ZipTooLargeError('Das Archiv würde größer als 4 GiB.')
  }

  for (const record of central) {
    yield record
  }

  const end = header(22)

  end.view.setUint32(0, 0x06054b50, true)
  end.view.setUint16(8, entries.length, true)
  end.view.setUint16(10, entries.length, true)
  end.view.setUint32(12, size, true)
  end.view.setUint32(16, offset, true)

  yield end.bytes
}

/** The whole archive at once, for what is small: tests and an answer without files. */
export async function zipBytes(
  entries: readonly ZipEntry[],
  moment: { readonly time: number; readonly date: number },
): Promise<Uint8Array> {
  const pieces: Uint8Array[] = []

  for await (const piece of zipPieces(entries, moment)) {
    pieces.push(piece)
  }

  const whole = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
  let at = 0

  for (const piece of pieces) {
    whole.set(piece, at)
    at += piece.length
  }

  return whole
}
