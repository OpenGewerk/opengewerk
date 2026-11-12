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
    expect(uniqueNames([composed, decomposed])).toEqual([
      composed,
      `fu${String.fromCharCode(0x308)}r (2).pdf`,
    ])
  })

  it('take "ß" and "SS" for the same name, as capitals write them', () => {
    expect(uniqueNames(['aßß.pdf', 'aSSSS.pdf', 'aßSS.pdf'])).toEqual([
      'aßß.pdf',
      'aSSSS (2).pdf',
      'aßSS (3).pdf',
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
    ]

    expect(cleanName(`x${unbroken}. .`)).toBe('x')

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
