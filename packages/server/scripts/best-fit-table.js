import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Writes src/privacy/best-fit.ts from a dump of best-fit-dump.ps1
 * (opengewerk#922): node scripts/best-fit-table.js <dump.json>, then Prettier
 * over the file. The table keeps what a code page makes of a character where
 * `plain` in src/privacy/zip.ts reads the two otherwise, and leaves out what
 * becomes a character Windows refuses in a name, or a dot, a slash or a
 * backslash: a name with it fails there, or `cleanName` has replaced the
 * character already.
 */

const dump = process.argv[2]

if (dump === undefined) {
  throw new Error('Usage: node scripts/best-fit-table.js <dump.json>')
}

/** @type {{ pages: number[], '0': Record<string, Record<string, string>>, '528': Record<string, Record<string, string>> }} */
const data = JSON.parse(readFileSync(dump, 'utf8'))

// As `plain` in src/privacy/zip.ts reads a character; the two stay the same.
const dropped = new RegExp(`[\\p{M}${String.fromCodePoint(0x6de)}]`, 'gu')
const plain = (/** @type {string} */ text) =>
  [...text]
    .map((character) => character.normalize('NFKD').replace(dropped, '').toUpperCase())
    .join('')

const refused = new Set([...'<>:"|?*/.', String.fromCodePoint(0x5c)])

/** @type {Map<string, { code: number, made: number, pages: number, dropping: number }>} */
const rows = new Map()

for (const [mode, field] of /** @type {const} */ ([
  ['0', 'pages'],
  ['528', 'dropping'],
])) {
  data.pages.forEach((page, bit) => {
    for (const [code, made] of Object.entries(data[mode][String(page)] ?? {})) {
      const character = String.fromCodePoint(Number(code))
      const units = [...made]

      if (units.length > 1) {
        throw new Error(`U+${Number(code).toString(16)} becomes more than one character in ${page}`)
      }
      if (units.some((unit) => refused.has(unit) || unit.charCodeAt(0) < 0x20)) {
        continue
      }
      if (plain(made) === plain(character)) {
        continue
      }

      const madeCode = units[0]?.codePointAt(0) ?? 0
      const key = `${code}:${madeCode}`
      const row = rows.get(key) ?? { code: Number(code), made: madeCode, pages: 0, dropping: 0 }

      row[field] = (row[field] | (1 << bit)) >>> 0
      rows.set(key, row)
    }
  })
}

const hex = (/** @type {number} */ value) => `0x${value.toString(16)}`
const sorted = [...rows.values()].sort((a, b) => a.code - b.code || a.made - b.made)
const lines = [
  '// Written by scripts/best-fit-table.js from what WideCharToMultiByte made of',
  '// each character on Windows (scripts/best-fit-dump.ps1); not edited by hand.',
  '',
  '/** The code pages of the table, in the order of the bits below. */',
  `export const fitPages = [${data.pages.join(', ')}] as const`,
  '',
  '/**',
  ' * What a code page makes of a character by best fit where `plain` in zip.ts',
  ' * reads the two otherwise (opengewerk#922): the character, what it becomes',
  ' * (0 for nothing), and as bits of `fitPages` the code pages that do so',
  ' * without flags and those that do so when they drop marks',
  ' * (WC_COMPOSITECHECK | WC_DISCARDNS).',
  ' */',
  'export const fits: readonly (readonly [number, number, number, number])[] = [',
  ...sorted.map(
    (row) => `  [${hex(row.code)}, ${hex(row.made)}, ${hex(row.pages)}, ${hex(row.dropping)}],`,
  ),
  ']',
  '',
]

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/privacy/best-fit.ts')

writeFileSync(target, lines.join('\n'), 'utf8')
console.log(`${String(sorted.length)} rows written to ${target}`)
