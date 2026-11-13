import { describe, expect, it } from 'vitest'

// What a picture is and what a new file is called are the foundation's
// (opengewerk-haustechnik#97) and reach this application's code under the
// names they always had, through the entry of this package.
import { attachmentTitleOf, isPhoto, isPicture } from '../index.js'
import {
  attachmentHomeProblem,
  attachmentMediaTypeProblem,
  shownPhotoVersion,
} from './attachment.js'

describe('what a version says about its file', () => {
  it('has the type as it is recorded, and nothing else', () => {
    expect(attachmentMediaTypeProblem('application/pdf')).toBeNull()
    expect(attachmentMediaTypeProblem('application/octet-stream')).toBeNull()
    expect(attachmentMediaTypeProblem('Application/PDF')).toMatch(/nicht so angegeben/)
    expect(attachmentMediaTypeProblem('text/html')).toMatch(/nicht so angegeben/)
    expect(attachmentMediaTypeProblem(null)).toMatch(/nicht so angegeben/)
  })
})

describe('a picture and a photo', () => {
  it('is a picture when a browser can decode it, and not HEIC', () => {
    expect(isPicture('image/jpeg')).toBe(true)
    expect(isPicture('image/png')).toBe(true)
    expect(isPicture('image/gif')).toBe(true)
    expect(isPicture('image/heic')).toBe(false)
    expect(isPicture('application/pdf')).toBe(false)
  })

  it('is a photo, made smaller, as a JPEG or WebP and not as a PNG', () => {
    expect(isPhoto('image/jpeg')).toBe(true)
    expect(isPhoto('image/webp')).toBe(true)
    expect(isPhoto('image/png')).toBe(false)
  })
})

describe('where a file hangs', () => {
  it('is at least one of customer, site, installation, appliance and job', () => {
    expect(attachmentHomeProblem({ customerId: 'c-1' })).toBeNull()
    expect(attachmentHomeProblem({ jobId: 'j-1', installationId: 'i-1' })).toBeNull()
    // The photo of an appliance of the register (#817).
    expect(attachmentHomeProblem({ applianceId: 'a-1' })).toBeNull()
  })

  it('is refused when it is none of them, an empty string counting as none', () => {
    expect(attachmentHomeProblem({})).toMatch(/hängt an einem Kunden/)
    expect(attachmentHomeProblem({ customerId: '', siteId: null })).toMatch(/hängt an/)
  })
})

describe('the name of a new file', () => {
  it('is the file name without its ending', () => {
    expect(attachmentTitleOf('Schaltplan UV Keller.pdf')).toBe('Schaltplan UV Keller')
    expect(attachmentTitleOf('foto.2026-09-23.jpg')).toBe('foto.2026-09-23')
  })

  it('keeps a name that only starts with a dot, and has one when the name is empty', () => {
    expect(attachmentTitleOf('.notizen')).toBe('.notizen')
    expect(attachmentTitleOf('  ')).toBe('Datei')
  })
})

describe('the version of a photo a protocol shows (#817)', () => {
  const version = (id: string, sequence: number | null) => ({ id, sequence })
  const shown = (
    newestFirst: readonly { id: string; sequence: number | null }[],
    at: number | null,
  ) => shownPhotoVersion(newestFirst, (each) => each.sequence, at)?.id

  it('is the newest of a draft, and of a signed protocol the newest written before it', () => {
    const versions = [version('v3', 30), version('v2', null), version('v1', 5)]

    expect(shown(versions, null)).toBe('v3')
    expect(shown(versions, 10)).toBe('v1')
  })

  it('stays the one written first where all came after the signature, whatever arrives later', () => {
    expect(shown([version('v2', 20)], 10)).toBe('v2')
    // An older version by id, written later still, does not take its place.
    expect(shown([version('v2', 20), version('v1', 30)], 10)).toBe('v2')
  })
})
