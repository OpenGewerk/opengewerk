import { describe, expect, it } from 'vitest'

import { type AccessAnswer, accessEntries, filePaths } from './access-answer.js'
import type { AccessReport, ReportFile } from './access-report.js'
import { uniqueNames } from './zip.js'

/** A report with nothing but the given files, as `filePaths` reads it. */
function reportOf(files: readonly Pick<ReportFile, 'mediaType' | 'name'>[]): AccessReport {
  return {
    subject: 'customer',
    subjectId: 'kunde',
    tables: new Map(),
    actions: [],
    changes: [],
    files: files.map((file, index) => ({
      table: 'attachment_versions',
      recordId: String(index),
      sha256: String(index).padStart(64, '0'),
      ...file,
    })),
    accounts: [],
  }
}

/** A space that does not break, which trim takes and a pattern for spaces does not. */
const unbroken = String.fromCharCode(0xa0)

describe('the paths of the files of an answer', () => {
  it('are cut and cleaned, and the archive keeps them as they are', () => {
    const paths = filePaths(
      reportOf([
        { mediaType: 'text/plain', name: `${'.'.repeat(99_999)}x` },
        { mediaType: 'text/plain', name: `x${unbroken}. .` },
        { mediaType: 'text/plain', name: 'x' },
        { mediaType: 'application/pdf', name: 'ä'.repeat(100_000) },
        { mediaType: 'application/pdf', name: `${'C'.repeat(197)}.pdf` },
        { mediaType: 'application/octet-stream', name: `${'D'.repeat(197)}.docx` },
        { mediaType: 'application/pdf', name: `${'B'.repeat(194)} 12.05.2026 Lena` },
        { mediaType: 'text/plain', name: `${'B'.repeat(194)} 12.05.2026 Lena` },
        { mediaType: 'application/pdf', name: `${'C'.repeat(195)} ${'D'.repeat(100)}.pdf` },
        { mediaType: 'text/plain', name: `${'E'.repeat(194)}.bc.056 Ende` },
        { mediaType: 'image/png', name: String.fromCodePoint(0x1f600).repeat(1000) },
      ]),
    )

    // The sync lets a name of 100 000 characters through (opengewerk#916);
    // what is cut is the stem, to 200 bytes, and the extension stays. A name
    // without one gets none from the cut ("12.05"), and the one of its media
    // type comes behind it; a cut behind a space leaves no " .pdf".
    expect(paths).toEqual([
      'dateien/Datei',
      'dateien/x',
      'dateien/x (2)',
      `dateien/${'ä'.repeat(100)}.pdf`,
      `dateien/${'C'.repeat(196)}.pdf`,
      `dateien/${'D'.repeat(195)}.docx`,
      `dateien/${'B'.repeat(194)} 12.pdf`,
      `dateien/${'B'.repeat(194)} 12`,
      `dateien/${'C'.repeat(195)}.pdf`,
      `dateien/${'E'.repeat(194)}`,
      `dateien/${String.fromCodePoint(0x1f600).repeat(50)}.png`,
    ])

    // ext4 and macOS hold at most 255 bytes for one part of a path.
    for (const path of paths) {
      for (const part of path.split('/')) {
        expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(255)
      }
    }

    const names = ['Auskunft.pdf', 'daten.json', ...paths]

    expect(uniqueNames(names)).toEqual(names)
  })

  it('give each lost file a note under its path, and the archive keeps those names', async () => {
    // A sigma at the end of a word is written otherwise in lower case than
    // inside one, and "aΣ" and "aσ" were two paths but one note (opengewerk#916).
    const report = reportOf([
      { mediaType: 'text/plain', name: 'aΣ' },
      { mediaType: 'text/plain', name: 'aσ' },
    ])
    const notes = await notesOf(report)

    expect(filePaths(report)).toEqual(['dateien/aΣ', 'dateien/aσ (2)'])
    expect(notes).toEqual(['fehlende Dateien/aΣ/fehlt.txt', 'fehlende Dateien/aσ (2)/fehlt.txt'])

    const names = ['Auskunft.pdf', 'daten.json', ...notes]

    expect(uniqueNames(names)).toEqual(names)
  })

  it('make no path and no note a file and a folder at once', async () => {
    // "a" and "a/b.pdf" made "a" both (opengewerk#919), and with ".txt" behind
    // the path the note of "a" was "a.txt", the folder of the note of "a.txt/b".
    const names = ['a', 'a/b.pdf', 'a/fehlt.txt', 'a.txt/b']

    for (const order of [names, [...names].reverse()]) {
      const report = reportOf(order.map((name) => ({ mediaType: 'text/plain', name })))
      const paths = filePaths(report)
      const notes = await notesOf(report)

      expect([...paths].sort()).toEqual([
        'dateien/a',
        'dateien/a.txt_b',
        'dateien/a_b.pdf',
        'dateien/a_fehlt.txt',
      ])
      expect(notes).toEqual(
        paths.map((path) => `fehlende ${path.replace('dateien/', 'Dateien/')}/fehlt.txt`),
      )

      for (const name of [...paths, ...notes]) {
        expect([...paths, ...notes].filter((other) => other.startsWith(`${name}/`))).toEqual([])
      }
    }
  })
})

/** The names the archive gets for the files of a report when the store has lost every one. */
async function notesOf(report: AccessReport): Promise<string[]> {
  const answer = { report } as unknown as AccessAnswer
  const entries = accessEntries(answer, new Uint8Array(), () => Promise.reject(new Error('lost')))
  const notes: string[] = []

  for (const entry of entries.slice(2)) {
    const got = await entry.bytes()

    notes.push(got instanceof Uint8Array ? entry.name : got.name)
  }

  return notes
}
