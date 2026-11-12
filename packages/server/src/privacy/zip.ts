import { crc32 } from 'node:zlib'

import { fits } from './best-fit.js'

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
 * folder becomes "Foto (2).jpg". Slashes separate folders, backslashes
 * become slashes, and a leading slash and parts of only dots do not survive.
 */
export function uniqueNames(names: readonly string[]): string[] {
  return names.map(nameMaker())
}

/**
 * What a character beyond ASCII may not hold in its compatibility form
 * (opengewerk#916): a dot, a slash, a backslash, a colon or another character
 * of ASCII that Windows refuses. "／" is "/" in that form, "．" is ".".
 */
const asciiSeparators = new Set([...'/.:"<>|?*', String.fromCodePoint(0x5c)])

/**
 * Characters beyond ASCII that a Windows unpacker which turns names into its
 * code page by best fit makes a dot, a slash, a backslash or a colon of,
 * checked against the character itself: "¥" and "₩" are the backslash of
 * Japanese and Korean code pages, "´" is a slash in the Greek one. The
 * others look like a slash or a colon (of mathematics and phonetics, the full
 * stop and the colon of the Armenian and the Hebrew script); not every code
 * page makes one of them, and they are replaced all the same. Other characters
 * Windows refuses after best fit stay, they are part of ordinary names ("„",
 * "∗"), and a name with one fails there as with any character the code page
 * lacks. The combining acute is one where it stays alone after the name is
 * brought into one form, on a letter without a form of its own ("q́"): the DOS
 * code pages 860, 861 and 865 make a slash of it (opengewerk#922).
 */
const separatorsByFit = new Set(
  String.fromCodePoint(
    0x301,
    0xa5,
    0x20a9,
    0x2044,
    0x2215,
    0x2216,
    0x29f5,
    0x29f8,
    0x29f9,
    0x2236,
    0x2d0,
    0x2f8,
    0xa789,
    0x589,
    0x5c3,
    0xb4,
    0x2ca,
  ),
)

/**
 * A character no unpacker should be asked to put into a name: a control
 * character, one Windows refuses, half of one (a surrogate without its other
 * half), which the archive would write as U+FFFD and `daten.json` as
 * "\ud800", so that the two named the file differently, or one beyond ASCII
 * that an unpacker could make a separator of, as "．．／" would be "../"
 * (opengewerk#916).
 */
function unfit(character: string): boolean {
  const code = character.charCodeAt(0)

  return (
    code < 0x20 ||
    '<>:"|?*'.includes(character) ||
    (character.length === 1 && code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0x80 &&
      (separatorsByFit.has(character) ||
        [...character.normalize('NFKC')].some((part) => asciiSeparators.has(part))))
  )
}

/**
 * The names Windows keeps for devices, in capitals as `plain` gives them. What
 * comes before the first dot of a name, without the spaces at its end, may be
 * none of them: "CON", "nul.txt", "CON .pdf" and "CONIN$" are devices.
 */
const deviceNames = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...['COM', 'LPT'].flatMap((stem) => [...'123456789'].map((digit) => `${stem}${digit}`)),
]

/** What `plain` drops: marks, and U+06DE, which Windows takes for one. */
const dropped = new RegExp(`[\\p{M}${String.fromCodePoint(0x6de)}]`, 'gu')

/**
 * What a character is to a Windows unpacker that turns names into its code
 * page by best fit, as near as a rule can say (opengewerk#920): without its
 * marks, in its compatibility form and in capitals. "Ｃ", "Ĉ" and "c" are "C",
 * "¹" is "1", and a mark alone is nothing, as an unpacker that asks Windows to
 * drop such marks (WC_DISCARDNS) leaves of it; so is U+06DE, which Windows
 * takes for a mark.
 */
function plain(character: string): string {
  // Most names are ASCII, which has no other form and no marks.
  return character.charCodeAt(0) < 0x80
    ? character.toUpperCase()
    : character.normalize('NFKD').replace(dropped, '').toUpperCase()
}

/**
 * The ways an unpacker may turn a name: one for each code page of `fitPages`
 * without flags, then one for each when it drops marks (WC_COMPOSITECHECK |
 * WC_DISCARDNS).
 */
const ways = 64

/** How a character reads in the ways in which it does not read as `plain`. */
interface Fit {
  /** By way, undefined where it reads as `plain`. */
  readonly readings: readonly (string | undefined)[]
  /**
   * The ways in which it does not, each given by the first way that reads
   * every character of the table alike: of the 64, 47 differ.
   */
  readonly ways: readonly number[]
}

/** What a code page makes of each character of the table, by way. */
const readingsByWay = new Map<string, (string | undefined)[]>()

for (const [code, made, pages, dropping] of fits) {
  const character = String.fromCodePoint(code)
  const reading = made === 0 ? '' : plain(String.fromCodePoint(made))
  const byWay = readingsByWay.get(character) ?? Array.from({ length: ways }, () => undefined)

  for (let bit = 0; bit < 32; bit += 1) {
    if (((pages >>> bit) & 1) === 1) {
      byWay[bit] = reading
    }
    if (((dropping >>> bit) & 1) === 1) {
      byWay[32 + bit] = reading
    }
  }

  readingsByWay.set(character, byWay)
}

/** For each way, the first way that reads every character of the table alike. */
const firstAlike = Array.from({ length: ways }, (_, way) => way)

for (let way = 1; way < ways; way += 1) {
  const twin = firstAlike
    .slice(0, way)
    .find((other) => [...readingsByWay.values()].every((byWay) => byWay[other] === byWay[way]))

  firstAlike[way] = twin ?? way
}

/**
 * The fits of each character that a code page makes something of which
 * `plain` reads otherwise (opengewerk#920, opengewerk#922): "Ł" is "L" in
 * 1252, "Ø" is "O" in 437, "ð" is "D" in one code page and "E" in another,
 * "⃝" is "O" in 850. The table comes from WideCharToMultiByte on Windows over
 * every character of Unicode in 32 code pages (scripts/best-fit-dump.ps1).
 */
const fitsOf = new Map<string, Fit>(
  [...readingsByWay].map(([character, byWay]) => [
    character,
    {
      readings: byWay,
      ways: [
        ...new Set(
          byWay.flatMap((each, way) => (each === undefined ? [] : [firstAlike[way] ?? way])),
        ),
      ],
    },
  ]),
)

/**
 * What a character may be to that unpacker in any code page: what `plain`
 * gives, and its readings by fit. "⃝" is nothing or "O", "¹" is "1" or "3".
 */
function readings(character: string): string[] {
  const byFit = fitsOf.get(character)?.readings ?? []

  return [...new Set([plain(character), ...byFit.filter((each) => each !== undefined)])]
}

/** A reading of spaces or of nothing, which Windows drops before a dot. */
const blankReading = /^ *$/

/**
 * How many characters at the start of a stem make the name of a device when
 * each is read as one of its `readings`, with nothing after them that cannot
 * be read as spaces or as nothing; the fewest that do, or undefined. One pass
 * for each device name, which stops as soon as no reading still spells it.
 */
function deviceLength(stem: readonly string[]): number | undefined {
  // The readings of each character, read when a pass first gets to it: most
  // passes stop at the first character.
  const read: (readonly string[] | undefined)[] = []
  const readingsAt = (index: number): readonly string[] => {
    const known = read[index]

    if (known !== undefined || index >= stem.length) {
      return known ?? []
    }

    const found = readings(stem[index] ?? '')

    read[index] = found

    return found
  }
  // Whether every character from an index on may be read as spaces or
  // nothing, worked out the first time a pass spells a name to its end.
  let blank: boolean[] | undefined
  const blankFrom = (index: number): boolean => {
    if (blank === undefined) {
      const all = Array.from({ length: stem.length + 1 }, () => true)

      for (let at = stem.length - 1; at >= 0; at -= 1) {
        all[at] = (all[at + 1] ?? true) && readingsAt(at).some((text) => blankReading.test(text))
      }
      blank = all
    }

    return blank[index] ?? true
  }

  let fewest: number | undefined

  for (const name of deviceNames) {
    // How far into the name the characters so far may reach.
    let reached = new Set([0])

    for (let index = 0; index <= stem.length && reached.size > 0; index += 1) {
      if (reached.has(name.length) && blankFrom(index)) {
        fewest = Math.min(fewest ?? index, index)
        break
      }

      const next = new Set<number>()

      // A reading of nothing stays where it is. No reading of a character
      // has spaces after a letter, so a name ends between two characters.
      for (const at of reached) {
        for (const text of readingsAt(index)) {
          if (name.startsWith(text, at)) {
            next.add(at + text.length)
          }
        }
      }

      reached = next
    }
  }

  return fewest
}

/** A character that is a mark and goes with the one before it. */
const mark = /^\p{M}/u

/**
 * A part that is not the name of a device: Windows makes no file "CON" or
 * "NUL.txt", so it gets a "_" behind the device, "CON_", "NUL_.txt" and
 * "CON_ .pdf". Also when only an unpacker that converts by best fit makes a
 * device of it, "ＣＯＮ", "ĈON" or "ŁPT1" (opengewerk#920). The "_" comes after
 * the marks of the last character, which stay with it.
 */
function notADevice(part: string): string {
  const dot = part.indexOf('.')
  const stem = [...(dot === -1 ? part : part.slice(0, dot))]
  let count = deviceLength(stem)

  if (count === undefined) {
    return part
  }

  while (count < stem.length && mark.test(stem[count] ?? '')) {
    count += 1
  }

  const device = stem.slice(0, count).join('')

  return `${device}_${part.slice(device.length)}`
}

/**
 * A run of more marks than 30, the most a stream-safe text holds after one
 * character (UAX #15), and more than any writing needs: it is cut to 30
 * before and after the name is brought into one form (opengewerk#916). The
 * form orders a run by inserting, in time that grows with the square of its
 * length, and a name of 100 000 marks held the server for seconds. After it
 * once more, as the form may make two marks of one.
 */
const markRun = /(\p{M}{30})\p{M}+/gu

/**
 * A name in which "Š" is "S" (opengewerk#922): the DOS code pages 860, 861
 * and 865 make a backslash of it, and a name with it a folder. In one form
 * again after each round, as an "S" and a caron behind the old "Š" make a new
 * one; the runs of marks are cut to 30, so there are at most 31 rounds.
 */
function withoutCaronS(name: string): string {
  let result = name

  while (result.includes('Š')) {
    result = result.replaceAll('Š', 'S').normalize('NFC')
  }

  return result
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
  const name = withoutCaronS(raw.replace(markRun, '$1').normalize('NFC').replace(markRun, '$1'))
    .replace(/\\/g, '/')
    .split('/')
    .map((part) =>
      notADevice(
        withoutEnd(
          [...part].map((character) => (unfit(character) ? '_' : character)).join(''),
        ).trimStart(),
      ),
    )
    .filter((part) => part !== '')
    .join('/')

  return name === '' ? 'Datei' : name
}

/**
 * A name as the archive compares it: in one Unicode form, as macOS does, so
 * that "für" of one character and of two are one name; then in lower case and
 * from there in capitals, so that "ẞ", "ß" and "SS" are one name, as macOS
 * folds them, and close to Windows, which compares in capitals one character
 * at a time. Where the two differ, this takes more names for the same, which
 * can give a name a number Windows would not need, more than one where it has
 * several "ß", and never two files one name. Lower case alone would not do: it
 * writes a sigma at the end of a word otherwise than inside one, and "aΣ" and
 * "aσ" stayed two names until ".txt" came after them (opengewerk#916); in
 * capitals both are "Σ" again.
 */
function folded(name: string): string {
  return name.normalize('NFC').toLowerCase().toUpperCase().normalize('NFC')
}

/** Whether a reading is only what Windows drops at the end of a part. */
function droppedAtEnd(reading: string): boolean {
  for (let at = 0; at < reading.length; at += 1) {
    if (reading.charAt(at) !== ' ' && reading.charAt(at) !== '.') {
      return false
    }
  }

  return true
}

/**
 * A number for a name as it reads in one way, given as the reading of each
 * of its characters, each part without the spaces and dots at its end, which
 * Windows drops: the same for the same name, and worked out without spelling
 * the name (cyrb53). Rarely two names share one, which costs one of them a
 * number it would not need. Only a slash reads as a slash: `cleanName` has
 * replaced every other character that could.
 */
function numberOf(readings: readonly string[]): number {
  let first = 0xdeadbeef
  let second = 0x41c6ce57
  // Where what may be the end of a part starts; taken in once something
  // follows it, left out before a slash and at the end.
  let pendingFrom = -1

  for (let index = 0; index < readings.length; index += 1) {
    const reading = readings[index] ?? ''

    if (reading === '/') {
      pendingFrom = -1
    } else if (droppedAtEnd(reading)) {
      pendingFrom = pendingFrom < 0 ? index : pendingFrom
      continue
    } else if (pendingFrom >= 0) {
      for (let before = pendingFrom; before < index; before += 1) {
        const pending = readings[before] ?? ''

        for (let at = 0; at < pending.length; at += 1) {
          first = Math.imul(first ^ pending.charCodeAt(at), 2654435761)
          second = Math.imul(second ^ pending.charCodeAt(at), 1597334677)
        }
      }
      pendingFrom = -1
    }

    for (let at = 0; at < reading.length; at += 1) {
      first = Math.imul(first ^ reading.charCodeAt(at), 2654435761)
      second = Math.imul(second ^ reading.charCodeAt(at), 1597334677)
    }
  }

  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)

  return 4294967296 * (2097151 & second) + (first >>> 0)
}

/**
 * The names an unpacker that turns names into its code page by best fit may
 * make of a name, as numbers (opengewerk#922): one for each way of turning in
 * which a fit reads one of its characters otherwise than `plain`, and one as
 * `plain` reads every character, which holds for the others. Two names that
 * one code page makes the same share one of these: "Ｆｏｔｏ.jpg" and
 * "Foto.jpg" in any, "Łódź.pdf" and "Lodz.pdf" in 1251, "è.pdf" and "c.pdf"
 * in 775. Two that share one only through two different code pages count as
 * the same as well, which costs a number and never a file. At most 48
 * numbers, each worked out in one pass, whatever the name.
 */
function fitNames(name: string): Set<number> {
  const characters = [...name]
  const plainly = characters.map(plain)
  const names = new Set([numberOf(plainly)])
  const fitted = characters.flatMap((character, index) => {
    const fit = fitsOf.get(character)

    return fit === undefined ? [] : [{ index, fit }]
  })
  // The readings of one way: as `plain` but where a fit reads otherwise.
  const read = [...plainly]

  for (const way of new Set(fitted.flatMap(({ fit }) => fit.ways))) {
    for (const { index, fit } of fitted) {
      read[index] = fit.readings[way] ?? plainly[index] ?? ''
    }
    names.add(numberOf(read))
  }

  return names
}

/**
 * Makes each name it is given unique among those it made before: as macOS
 * and Windows compare names (`folded`), and as an unpacker that converts them
 * by best fit may make them (`fitNames`).
 */
export function nameMaker(): (raw: string) => string {
  const taken = new Set<string>()
  // The numbers of `fitNames` of every name made so far.
  const takenByFit = new Set<number>()
  // Where the count of each name stopped, by `folded` and by each number of
  // `fitNames`: a hundredth "Foto.jpg" tries "Foto (100).jpg" first and not
  // every number from 2 again, and so does a hundredth name that only an
  // unpacker makes "Foto.jpg" of, "F̀oto.jpg" after "Fòto.jpg" (opengewerk#922).
  const counters = new Map<string | number, number>()

  return (raw) => {
    const fallback = cleanName(raw)
    const dot = fallback.lastIndexOf('.')
    const slash = fallback.lastIndexOf('/')
    const [stem, extension] =
      dot > slash + 1 ? [fallback.slice(0, dot), fallback.slice(dot)] : [fallback, '']
    let candidate = fallback
    let byFit = fitNames(candidate)
    const keys = [folded(fallback), ...byFit]
    let counter = Math.max(...keys.map((key) => counters.get(key) ?? 2))
    let numbered = false

    while (taken.has(folded(candidate)) || [...byFit].some((name) => takenByFit.has(name))) {
      candidate = `${stem} (${String(counter)})${extension}`
      byFit = fitNames(candidate)
      counter += 1
      numbered = true
    }

    if (numbered) {
      for (const key of keys) {
        counters.set(key, counter)
      }
    }
    taken.add(folded(candidate))
    for (const name of byFit) {
      takenByFit.add(name)
    }

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
