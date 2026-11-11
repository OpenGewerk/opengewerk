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
      ]),
    )

    // The sync lets a name of 100 000 characters through (opengewerk#916);
    // what is cut is the stem, and the extension stays.
    expect(paths).toEqual([
      'dateien/Datei',
      'dateien/x',
      'dateien/x (2)',
      `dateien/${'ä'.repeat(200)}.pdf`,
      `dateien/${'C'.repeat(196)}.pdf`,
      `dateien/${'D'.repeat(195)}.docx`,
    ])

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
    const answer = { report } as unknown as AccessAnswer
    const entries = accessEntries(answer, new Uint8Array(), () => Promise.reject(new Error('lost')))
    const notes: string[] = []

    for (const entry of entries.slice(2)) {
      const got = await entry.bytes()

      notes.push(got instanceof Uint8Array ? entry.name : got.name)
    }

    expect(filePaths(report)).toEqual(['dateien/aΣ', 'dateien/aσ (2)'])
    expect(notes).toEqual(['fehlende Dateien/aΣ.txt', 'fehlende Dateien/aσ (2).txt'])

    const names = ['Auskunft.pdf', 'daten.json', ...notes]

    expect(uniqueNames(names)).toEqual(names)
  })
})
