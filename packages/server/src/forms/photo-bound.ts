/**
 * How many photos one printed page reads, and how many bytes of them together
 * (#817, #940): each is read whole into memory and written into the page
 * again. A photo past either bound is not read, and the page says where it
 * lies. A photo a device takes is made smaller first and keeps far below. The
 * bytes leave room in what the renderer takes in one request (browserless,
 * 10 MiB unless set otherwise): a photo grows by a third as base64, and the
 * page has its own.
 */
export const printedPhotos = { count: 20, bytes: 6_000_000 } as const

/** What the renderer takes in one request, unless it is set otherwise (`MAX_PAYLOAD_SIZE`). */
export const rendererRequestBytes = 10_485_760

/** Room in a request for the policy around the page and the markup of each photo. */
const requestReserve = 64_000

/** How many photos a page reads, and how many bytes of them together. */
export interface PhotoBound {
  readonly count: number
  readonly bytes: number
}

/**
 * The bound for the photos of one page whose request without them takes
 * `pageBytes`: `printedPhotos`, and no more bytes than the request has left,
 * at three bytes for every four characters of base64. A large page leaves
 * less, one at the edge of the renderer none.
 */
export function photoBound(pageBytes: number): PhotoBound {
  const left = rendererRequestBytes - pageBytes - requestReserve

  return {
    count: printedPhotos.count,
    bytes: Math.max(0, Math.min(printedPhotos.bytes, Math.floor((left * 3) / 4))),
  }
}

/**
 * What the texts printed with a photo, its title and the name of its file,
 * add to a request at most, as bytes of a photo count against the bound: six
 * bytes for each of theirs, as `&quot;` stands for `"`. A name has no bound of
 * its own, and a long one would otherwise fill what the photos leave free.
 */
export function printedTextBytes(...texts: readonly string[]): number {
  return texts.reduce((sum, each) => sum + 6 * Buffer.byteLength(each), 0)
}

/**
 * The photos a page reads, in the order it prints them, while they stay
 * within `bound`. One printed several times counts each time; one past the
 * bound is passed over, and a smaller one after it may still fit.
 */
export function withinBound<P>(
  photos: readonly P[],
  sizeOf: (photo: P) => number,
  bound: PhotoBound,
  timesOf: (photo: P) => number = () => 1,
): P[] {
  const chosen: P[] = []
  let printed = 0
  let read = 0

  for (const photo of photos) {
    const times = Math.max(1, timesOf(photo))
    const bytes = sizeOf(photo) * times

    if (printed + times <= bound.count && read + bytes <= bound.bytes) {
      printed += times
      read += bytes
      chosen.push(photo)
    }
  }

  return chosen
}
