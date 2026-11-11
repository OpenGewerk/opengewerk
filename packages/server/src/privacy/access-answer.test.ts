import { describe, expect, it } from 'vitest'

import { filePaths } from './access-answer.js'
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
      ]),
    )

    // The sync lets a name of 100 000 characters through (opengewerk#916).
    expect(paths).toEqual([
      'dateien/Datei',
      'dateien/x',
      'dateien/x (2)',
      `dateien/${'ä'.repeat(200)}.pdf`,
    ])

    const names = ['Auskunft.pdf', 'daten.json', ...paths]

    expect(uniqueNames(names)).toEqual(names)
  })
})
