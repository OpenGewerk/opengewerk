import { describe, expect, it } from 'vitest'

import { blankFits, separatorFits } from './best-fit.js'
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

  it('keep no character a code page makes a separator of (opengewerk#922)', () => {
    // After "q", with which no mark of them makes a character of its own.
    for (const code of separatorFits) {
      const character = String.fromCodePoint(code)

      expect(cleanName(`q${character}b.pdf`)).not.toContain(character)
    }
  })

  it('keep no part only of what a code page makes spaces or nothing of (opengewerk#922)', () => {
    for (const code of blankFits) {
      expect(cleanName(`x/${String.fromCodePoint(code)}/y`)).toBe('x/y')
    }

    // Nor of what `plain` reads as spaces or nothing, which no code page
    // makes so yet: "¨", "¯", "¸", "˘", "῭" and the half-width sound marks.
    for (const code of [0xa8, 0xaf, 0xb8, 0x2d8, 0x1fed, 0xff9e, 0xff9f]) {
      expect(cleanName(`x/${String.fromCodePoint(code)}/y`)).toBe('x/y')
    }
  })

  it('lose a part that is only dots and spaces once its marks are dropped (opengewerk#922)', () => {
    const umlaut = String.fromCodePoint(0x308)
    const grave = String.fromCodePoint(0x300)
    const rub = String.fromCodePoint(0x6de)

    // An unpacker that drops marks would make ".." of the first.
    expect(
      [`..${umlaut}`, `a/. ${grave}/b`, `x/..${rub}`, `..${umlaut}x`].map((name) =>
        cleanName(name),
      ),
    ).toEqual(['Datei', 'a/b', 'x', `..${umlaut}x`])
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

  it('are no names a code page makes a device of by best fit (opengewerk#920)', () => {
    const marks = String.fromCodePoint(0x308, 0x300)

    // Each on its own: some of them are one name to such an unpacker.
    expect(
      [
        'ＣＯＮ.pdf',
        'ｎｕｌ',
        'ĈON.pdf',
        'ŁPT1.txt',
        'COM¹',
        'COM١.pdf',
        'AµX',
        'CO№UT$',
        `CON${marks}`,
        `CON${marks} .pdf`,
        // "⃝" is "O" in 850 and nothing to an unpacker that drops marks.
        `ŁPT1${String.fromCodePoint(0x20dd)}.pdf`,
        `CON ${String.fromCodePoint(0x308)} .pdf`,
        // Windows drops U+06DE as a mark.
        `NU${String.fromCodePoint(0x6de)}L`,
        'ＣＯＮＥ.pdf',
        'Łódź.pdf',
        'COM0',
        'ŁPT.pdf',
      ].map((name) => cleanName(name)),
    ).toEqual([
      'ＣＯＮ_.pdf',
      'ｎｕｌ_',
      'ĈON_.pdf',
      'ŁPT1_.txt',
      'COM¹_',
      'COM١_.pdf',
      'AµX_',
      'CO№UT$_',
      `CON${marks}_`,
      `CON${marks}_ .pdf`,
      `ŁPT1${String.fromCodePoint(0x20dd)}_.pdf`,
      `CON_ ${String.fromCodePoint(0x308)} .pdf`,
      `NU${String.fromCodePoint(0x6de)}L_`,
      'ＣＯＮＥ.pdf',
      'Łódź.pdf',
      'COM0',
      'ŁPT.pdf',
    ])
  })

  it('are no one name to an unpacker that converts them by best fit (opengewerk#922)', () => {
    const grave = String.fromCodePoint(0x300)

    expect(
      uniqueNames([
        'dateien/Ｆｏｔｏ.jpg',
        'dateien/Foto.jpg',
        // "Ł" is "L" in 1251, which turns "ó" and "ź" into "o" and "z".
        'Łódź.pdf',
        'Lodz.pdf',
        // "è" is "c" in 775.
        'è.pdf',
        'c.pdf',
        // "ð" is "d" in 437 and "e" in 936.
        'ð.txt',
        'D.txt',
        'E.txt',
        // "è" is "c" in 775 and 852, where the grave is "`" and gone only
        // when marks are dropped.
        `è${grave}x.pdf`,
        'cx.pdf',
        // With the grave gone, Windows drops the dot at the end.
        'y',
        `y.${grave}`,
        // Letters and digits stay apart.
        'cat.pdf',
        'eat.pdf',
        'a1.pdf',
        'a3.pdf',
      ]),
    ).toEqual([
      'dateien/Ｆｏｔｏ.jpg',
      'dateien/Foto (2).jpg',
      'Łódź.pdf',
      'Lodz (2).pdf',
      'è.pdf',
      'c (2).pdf',
      'ð.txt',
      'D (2).txt',
      'E (2).txt',
      `è${grave}x.pdf`,
      'cx (2).pdf',
      'y',
      `y (2).${grave}`,
      'cat.pdf',
      'eat.pdf',
      'a1.pdf',
      'a3.pdf',
    ])
  })

  it('count on together when only such an unpacker makes them one name (opengewerk#922)', () => {
    // Two thousand names that differ in their marks and are all "Foto.jpg"
    // to an unpacker that drops them, each looked at about once. Without the
    // marks that are or hold an acute, which becomes "_".
    const marks = Array.from({ length: 0x70 }, (_, index) => 0x300 + index).filter(
      (code) => !String.fromCodePoint(code).normalize('NFC').includes(String.fromCodePoint(0x301)),
    )
    const raw = marks
      .flatMap((first) =>
        marks.map(
          (second) =>
            `dateien/F${String.fromCodePoint(first)}ot${String.fromCodePoint(second)}o.jpg`,
        ),
      )
      .slice(0, 2000)
    const started = performance.now()
    const names = uniqueNames(raw)

    expect(performance.now() - started).toBeLessThan(1000)
    expect(new Set(names).size).toBe(2000)
    expect(names.at(-1)).toMatch(/ \(2000\)\.jpg$/)
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

    // In capitals "ΐ" is three characters, of which one form holds two; the
    // acute that stays alone becomes "_" (opengewerk#922).
    const small = String.fromCodePoint(0x390)
    const capital = String.fromCodePoint(0x3aa, 0x301)

    expect(uniqueNames([`${small}.pdf`, `${capital}.pdf`])).toEqual([
      `${small}.pdf`,
      `${String.fromCodePoint(0x3aa)}_.pdf`,
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
      `Ångström ${enDash} „Test“ € 😀 Simek.pdf`,
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
      // The "_" goes behind the marks, so the acute keeps its letter.
      `CON${String.fromCodePoint(0x308, 0x301)}`,
      'ＣＯＮ.pdf',
      'ŁPT1.txt',
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

  it('look past a long run of U+06DE in time that grows with its length', () => {
    const rub = String.fromCodePoint(0x6de)
    const started = performance.now()

    cleanName(`.${rub.repeat(100_000)}Š`)
    cleanName(rub.repeat(100_000))
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('keep no acute or "Š" that a DOS code page turns into a separator (opengewerk#922)', () => {
    const acute = String.fromCodePoint(0x301)
    const umlaut = String.fromCodePoint(0x308)
    const caron = String.fromCodePoint(0x30c)
    const rub = String.fromCodePoint(0x6de)

    // Each on its own: some of them are one name to such an unpacker.
    expect(
      [
        `..${acute}..${acute}x.pdf`,
        '..Š..Šx.pdf',
        'Šimek.pdf',
        // Made of "S" and a caron, which the form makes "Š".
        `S${caron}imek.pdf`,
        // Another caron behind it, which makes a new "Š" of the "S".
        `Š${caron}x.pdf`,
        // A dot above behind it, with which the form holds it as "Ṧ".
        `Š${String.fromCodePoint(0x307)}.pdf`,
        'šimek.pdf',
        `Ива${acute}н.pdf`,
        `${acute}x.pdf`,
        `..${umlaut}Š${umlaut}x.pdf`,
        `..${rub}Šx.pdf`,
        // "/" and "\" in 860, one folder and the same path there.
        `q${acute}b.pdf`,
        'qŠb.pdf',
        `ɔ${String.fromCodePoint(0x303, 0x301)}.pdf`,
        `i${String.fromCodePoint(0x307, 0x301)}.pdf`,
      ].map((name) => cleanName(name)),
    ).toEqual([
      '.._.._x.pdf',
      '..S..Sx.pdf',
      'Simek.pdf',
      'Simek.pdf',
      'Sx.pdf',
      'Ṧ.pdf',
      'šimek.pdf',
      'Ива_н.pdf',
      '_x.pdf',
      `..${umlaut}S${umlaut}x.pdf`,
      `..${rub}Sx.pdf`,
      'q_b.pdf',
      'qSb.pdf',
      `ɔ${String.fromCodePoint(0x303)}_.pdf`,
      `i${String.fromCodePoint(0x307)}_.pdf`,
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
