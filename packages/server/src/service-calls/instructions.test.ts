import { describe, expect, it } from 'vitest'

import { legacyInstructionsFingerprint } from './instructions.js'

/**
 * The fingerprint a request for an early start signed before SHA-256 carries,
 * as the code of that time worked it out (`textFingerprint` before
 * opengewerk#887). The values below came out of that code and not out of
 * this one, so a change here that only agrees with itself does not pass.
 */
describe('the fingerprint of a request from before SHA-256', () => {
  it('is the one the code of that time worked out', () => {
    expect(
      legacyInstructionsFingerprint(
        [
          {
            template: 'withdrawal',
            title: 'Widerrufsbelehrung',
            text: 'Sie haben das Recht, binnen vierzehn Tagen zu widerrufen.',
          },
        ],
        'Ich verlange, dass Sie vor Ablauf der Widerrufsfrist beginnen. Für Kühlung und Größe.',
      ),
    ).toBe('fnv1a32:d101a423:187')
    expect(legacyInstructionsFingerprint([], null)).toBe('fnv1a32:68cf5eaa:9')
  })
})
