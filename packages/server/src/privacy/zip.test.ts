import { describe, expect, it } from 'vitest'

import { cleanName, dosMoment, uniqueNames, zipBytes, ZipTooLargeError } from './zip.js'

/** A space that does not break, which trim takes and a pattern for spaces does not. */
const unbroken = String.fromCharCode(0xa0)

/** The names in the archive of an answer (#318) and the moment it keeps. */
describe('the names in an archive', () => {
  it('stay in the archive: no way up, no root, no backslash', () => {
    expect(
      uniqueNames(['../../etc/passwd', '/dateien/a.jpg', 'dateien\\..\\b.jpg', './c.pdf']),
    ).toEqual(['etc/passwd', 'dateien/a.jpg', 'dateien/b.jpg', 'c.pdf'])
  })

  it('are unique, counting on before the ending', () => {
    expect(
      uniqueNames(['dateien/Foto.jpg', 'dateien/foto.JPG', 'dateien/Foto.jpg', 'Plan']),
    ).toEqual(['dateien/Foto.jpg', 'dateien/foto (2).JPG', 'dateien/Foto (3).jpg', 'Plan'])
  })

  it('count on from where they stopped, around a name that is taken already', () => {
    expect(uniqueNames(['a.txt', 'a (2).txt', 'a.txt', 'A.txt'])).toEqual([
      'a.txt',
      'a (2).txt',
      'a (3).txt',
      'A (4).txt',
    ])

    // Twenty thousand times the same name, each one looked at once.
    const started = performance.now()
    const names = uniqueNames(Array.from({ length: 20_000 }, () => 'dateien/Foto.jpg'))

    expect(performance.now() - started).toBeLessThan(1000)
    expect(names.at(-1)).toBe('dateien/Foto (20000).jpg')
    expect(new Set(names).size).toBe(20_000)
  })

  it('lose control characters and what Windows refuses', () => {
    expect(uniqueNames([`dateien/Rech${String.fromCharCode(0)}nung: 1?.pdf`])).toEqual([
      'dateien/Rech_nung_ 1_.pdf',
    ])
  })

  it('lose half a character and keep a whole one of two halves', () => {
    const half = String.fromCharCode(0xd83d)
    const whole = String.fromCodePoint(0x1f600)

    expect(uniqueNames([`a${half}b.pdf`, `${whole}.pdf`, `c${half}`])).toEqual([
      'a_b.pdf',
      `${whole}.pdf`,
      'c_',
    ])
  })

  it('give a nameless entry a name', () => {
    expect(uniqueNames(['', '..'])).toEqual(['Datei', 'Datei (2)'])
  })

  it('lose the dots and spaces Windows drops at the end of a part', () => {
    expect(uniqueNames(['Foto.', 'Foto', '...', 'a. ./b .pdf', 'dateien/. .'])).toEqual([
      'Foto',
      'Foto (2)',
      'Datei',
      'a/b .pdf',
      'dateien',
    ])
  })

  it('are no names Windows keeps for a device', () => {
    expect(
      uniqueNames([
        'CON',
        'nul.txt',
        'Com1.pdf',
        'LPT9',
        'CONSOLE.txt',
        'a/aux/b',
        'con_',
        'CONIN$',
        'conout$.txt',
        'CON .pdf',
        'nul .tar.gz',
        `PRN.${String.fromCharCode(0x2028)}x`,
      ]),
    ).toEqual([
      'CON_',
      'nul_.txt',
      'Com1_.pdf',
      'LPT9_',
      'CONSOLE.txt',
      'a/aux_/b',
      'con_ (2)',
      'CONIN$_',
      'conout$_.txt',
      'CON_ .pdf',
      'nul_ .tar.gz',
      `PRN_.${String.fromCharCode(0x2028)}x`,
    ])
  })

  it('take a name in either Unicode form for the same, as macOS does', () => {
    const composed = 'für.pdf'
    const decomposed = `fu${String.fromCharCode(0x308)}r.pdf`

    expect(composed).not.toBe(decomposed)
    // Both are kept in one form, of one character for "ü".
    expect(uniqueNames([composed, decomposed])).toEqual([composed, 'für (2).pdf'])
  })

  it('take "ẞ", "ß" and "SS" for the same name, as macOS folds them', () => {
    expect(uniqueNames(['aßß.pdf', 'aSSSS.pdf', 'aßSS.pdf'])).toEqual([
      'aßß.pdf',
      'aSSSS (2).pdf',
      'aßSS (3).pdf',
    ])
    expect(uniqueNames(['straße.pdf', 'STRAẞE.pdf'])).toEqual(['straße.pdf', 'STRAẞE (2).pdf'])

    const theta = String.fromCodePoint(0x3f4)
    const dotted = String.fromCodePoint(0x130)
    const dot = String.fromCodePoint(0x307)

    expect(uniqueNames([`${theta}.pdf`, 'Θ.pdf', `${dotted}.pdf`, `i${dot}.pdf`])).toEqual([
      `${theta}.pdf`,
      'Θ (2).pdf',
      `${dotted}.pdf`,
      `i${dot} (2).pdf`,
    ])

    // In capitals "ΐ" is three characters, of which one form holds two.
    const small = String.fromCodePoint(0x390)
    const capital = String.fromCodePoint(0x3aa, 0x301)

    expect(uniqueNames([`${small}.pdf`, `${capital}.pdf`])).toEqual([
      `${small}.pdf`,
      `${capital} (2).pdf`,
    ])
  })

  it('lose characters an unpacker could make a dot, a slash or a colon of', () => {
    const wide = String.fromCodePoint(0xff0e, 0xff0e, 0xff0f, 0xff0e, 0xff0e, 0xff3c)
    const yen = String.fromCodePoint(0xa5)
    const half = String.fromCodePoint(0xbd)
    const ratio = String.fromCodePoint(0x2236)
    const enDash = String.fromCodePoint(0x2013)
    const acute = String.fromCodePoint(0xb4)

    expect(
      uniqueNames([
        `${wide}x.pdf`,
        `${yen}a${yen}b`,
        `1${half} Zimmer.pdf`,
        `a${ratio}b`,
        `..${acute}..${acute}x.pdf`,
        `Ångström ${enDash} „Test“ € 😀 Šimek.pdf`,
      ]),
    ).toEqual([
      '______x.pdf',
      '_a_b',
      `1${half} Zimmer.pdf`,
      'a_b',
      '.._.._x.pdf',
      `Ångström ${enDash} „Test“ € 😀 Šimek.pdf`,
    ])
  })

  it('come back the same when they are cleaned again', () => {
    const names = [
      `x${unbroken}. .`,
      `x .${unbroken}.`,
      `${unbroken} .x`,
      '...',
      ' a. /. b',
      `dateien/x${unbroken}.`,
      // The form makes two marks of each: 40, of which the second cut leaves 30.
      `a${String.fromCodePoint(0xf73).repeat(20)}`,
      // The "Š" goes for the dot before it, then the acute for the "_".
      `..Š${String.fromCodePoint(0x301)}x.pdf`,
    ]

    expect(cleanName(`x${unbroken}. .`)).toBe('x')
    expect([...cleanName(`a${String.fromCodePoint(0xf73).repeat(20)}`)].length).toBe(31)

    for (const name of names) {
      expect(cleanName(cleanName(name))).toBe(cleanName(name))
    }

    // So the archive gives two files the names the answer gave them (opengewerk#916).
    expect(uniqueNames([`dateien/x${unbroken}. .`, 'dateien/x'])).toEqual([
      'dateien/x',
      'dateien/x (2)',
    ])
  })

  it('clean a long run of dots in time that grows with its length', () => {
    const long = `${'.'.repeat(100_000)}x`
    const started = performance.now()

    expect(cleanName(long)).toBe(long)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('cut a long run of marks before they are put in order', () => {
    const marks = `a${String.fromCodePoint(0x301).repeat(50_000)}${String.fromCodePoint(0x334).repeat(49_999)}`
    const started = performance.now()
    const cleaned = cleanName(marks)

    expect(performance.now() - started).toBeLessThan(500)
    expect([...cleaned].length).toBeLessThanOrEqual(31)
    expect(cleanName(cleaned)).toBe(cleaned)
  })

  it('make no "../" of an acute or an "Š" that a DOS code page turns into a separator', () => {
    const acute = String.fromCodePoint(0x301)
    // A mark between a dot and an "Š", which a conversion may drop.
    const umlaut = String.fromCodePoint(0x308)

    expect(
      uniqueNames([
        `..${acute}..${acute}x.pdf`,
        '..Š..Šx.pdf',
        'Šimek.pdf',
        `Ива${acute}н.pdf`,
        `${acute}x.pdf`,
        'xŠ.pdf',
        `..${umlaut}Š${umlaut}..${umlaut}Š${umlaut}x.pdf`,
      ]),
    ).toEqual([
      '.._.._x.pdf',
      '.._.._x (2).pdf',
      'Šimek.pdf',
      `Ива${acute}н.pdf`,
      '_x.pdf',
      'x_.pdf',
      `..${umlaut}_${umlaut}..${umlaut}_${umlaut}x.pdf`,
    ])
  })

  it('refuse a name longer than its field holds', async () => {
    const bytes = () => Promise.resolve(new Uint8Array([1]))
    const moment = { time: 0, date: 0 }

    await expect(zipBytes([{ name: 'ä'.repeat(32_767), bytes }], moment)).resolves.toBeDefined()
    await expect(zipBytes([{ name: 'ä'.repeat(32_768), bytes }], moment)).rejects.toThrow(
      ZipTooLargeError,
    )
  })
})

describe('the moment of an archive', () => {
  it('is kept as DOS time, two seconds at a time, from 1980 on', () => {
    expect(dosMoment({ year: 2026, month: 11, day: 5, hour: 14, minute: 7, second: 59 })).toEqual({
      time: (14 << 11) | (7 << 5) | 29,
      date: (46 << 9) | (11 << 5) | 5,
    })
    expect(dosMoment({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 }).date).toBe(
      (1 << 5) | 1,
    )
  })
})
