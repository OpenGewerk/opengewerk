import { describe, expect, it } from 'vitest'

import { sha256Hex } from './sha256.js'

// The expected digests are worked out by another implementation (Python's
// hashlib) from the UTF-8 bytes, so that this one is held against a second.
describe('SHA-256 of a text', () => {
  it('is the digest of the standard examples', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('pads at the edges of a block and over several blocks', () => {
    expect(sha256Hex('a'.repeat(55))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    )
    expect(sha256Hex('a'.repeat(56))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    )
    expect(sha256Hex('a'.repeat(64))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    )
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
  })

  it('takes the UTF-8 bytes of umlauts, of a character beyond the first plane and of a lone surrogate', () => {
    expect(sha256Hex('Prüfprotokoll äöüß Ä€')).toBe(
      '5c6e9b2ec6bf8b7d19e3edc5e21381f3af8eb99de0cff3d74701295e65893206',
    )
    expect(sha256Hex('Stecker 🔌 geprüft')).toBe(
      '53f39d47fe502bc3a210719fbd29571aa3f4f8772a04b2729cee12d8d45ce528',
    )
    // A surrogate on its own is the replacement character, as an encoder in a browser makes it.
    expect(sha256Hex(`x${String.fromCharCode(0xd800)}y`)).toBe(
      '0b37743370331e33808c0dd0167563798a3c324504cf0055d2b0ac81578d2c58',
    )
  })
})
