/**
 * SHA-256 over the UTF-8 bytes of a text, as a lowercase hexadecimal string.
 *
 * Worked out here and not taken from a platform: the domain knows neither the
 * crypto of Node nor the one of a browser (ADR 0009), and the mark of what a
 * customer signs has to come out the same on the device that shows the page
 * and on the server that checks it (`signedContentFingerprint`). It runs at
 * once, where the crypto of a browser would only answer later.
 */
export function sha256Hex(text: string): string {
  const bytes = utf8(text)
  const bitLength = bytes.length * 8
  // The message, a one bit, zeros up to 56 bytes into the last block, and the
  // length in bits as eight bytes, big endian.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)

  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)

  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const hash = Uint32Array.from(initial)
  const words = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4)
    }

    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15] as number
      const before2 = words[index - 2] as number
      const s0 = rotate(before15, 7) ^ rotate(before15, 18) ^ (before15 >>> 3)
      const s1 = rotate(before2, 17) ^ rotate(before2, 19) ^ (before2 >>> 10)

      words[index] = ((words[index - 16] as number) + s0 + (words[index - 7] as number) + s1) >>> 0
    }

    let a = hash[0] as number
    let b = hash[1] as number
    let c = hash[2] as number
    let d = hash[3] as number
    let e = hash[4] as number
    let f = hash[5] as number
    let g = hash[6] as number
    let h = hash[7] as number

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const first = (h + s1 + choice + (rounds[index] as number) + (words[index] as number)) >>> 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (s0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }

    hash[0] = ((hash[0] as number) + a) >>> 0
    hash[1] = ((hash[1] as number) + b) >>> 0
    hash[2] = ((hash[2] as number) + c) >>> 0
    hash[3] = ((hash[3] as number) + d) >>> 0
    hash[4] = ((hash[4] as number) + e) >>> 0
    hash[5] = ((hash[5] as number) + f) >>> 0
    hash[6] = ((hash[6] as number) + g) >>> 0
    hash[7] = ((hash[7] as number) + h) >>> 0
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('')
}

function rotate(value: number, by: number): number {
  return (value >>> by) | (value << (32 - by))
}

/**
 * The bytes of a text in UTF-8. A surrogate pair is one character of four
 * bytes; a surrogate on its own, which a text from a form may hold, becomes
 * the replacement character, as an encoder in a browser makes it.
 */
function utf8(text: string): Uint8Array {
  const bytes: number[] = []

  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index)

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0

      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        index += 1
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd
    }

    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }

  return Uint8Array.from(bytes)
}

/** The first thirty-two bits of the fractional parts of the square roots of the first eight primes. */
const initial = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

/** The same of the cube roots of the first sixty-four primes. */
const rounds = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
