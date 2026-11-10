import { describe, expect, it } from 'vitest'

import { withoutConnection } from './article-search.js'

/**
 * When the search counts the device without a connection and keeps to the
 * articles on it: when the browser says so, or when the last exchange failed.
 * Not on a page of an older build than the tab that pulls for the store
 * (opengewerk#899), which reaches the server all the same.
 */
describe('a device without a connection, for the search of articles', () => {
  it('is one the browser says is offline, or whose last exchange failed', () => {
    expect(withoutConnection({ online: false, trouble: null, troubleKind: null })).toBe(true)
    expect(
      withoutConnection({ online: true, trouble: 'Keine Verbindung.', troubleKind: 'unreachable' }),
    ).toBe(true)
    expect(withoutConnection({ online: true, trouble: null, troubleKind: null })).toBe(false)
  })

  it('is not one that is only out of date beside a newer build', () => {
    expect(
      withoutConnection({
        online: true,
        trouble: 'In einem anderen Tab läuft eine neuere Fassung. Bitte diese Seite neu laden.',
        troubleKind: 'outdated',
      }),
    ).toBe(false)
  })
})
