import { workingAsHeader } from '@opengewerk/platform-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RequestRefused, workAs } from '../sync/transport.js'
import { leavePush } from './push-device.js'
import { fakePushBrowser, forgetPushBrowser } from './test-push.js'

/**
 * Push at the sign out (#284), for the account signing out (opengewerk#882):
 * the page may have moved on to another account signed in on the browser
 * since, and its row and the subscription of the browser are not this sign
 * out's to end.
 */

let asked: { readonly path: string; readonly method: string; readonly account?: string }[]

beforeEach(() => {
  asked = []
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const account = (init?.headers as Record<string, string> | undefined)?.[workingAsHeader]

    asked.push({ path, method: init?.method ?? 'GET', account })

    // The session of the browser is u-2's: the server refuses any other.
    if (account !== undefined && account !== 'u-2') {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 'other_account', message: 'Anderes Konto.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    const body =
      path === '/push'
        ? {
            available: true,
            publicKey: 'BPublic',
            occasions: [],
            devices: [{ id: 'd-1', thisSession: true }],
          }
        : { id: 'd-1' }

    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
    )
  })
})

afterEach(() => {
  forgetPushBrowser()
  workAs(null)
})

describe('push at the sign out', () => {
  it('leaves the row and the subscription of another account signed in since', async () => {
    const { subscription } = fakePushBrowser({ subscribed: true })

    // The page moved on to u-2 while u-1 was signing out.
    workAs('u-2')

    await expect(leavePush('u-1')).rejects.toBeInstanceOf(RequestRefused)

    expect(asked).toEqual([{ path: '/push', method: 'GET', account: 'u-1' }])
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('takes the row and the subscription of the account signing out, named for it', async () => {
    const { subscription } = fakePushBrowser({ subscribed: true })

    await leavePush('u-2')

    expect(asked).toEqual([
      { path: '/push', method: 'GET', account: 'u-2' },
      { path: '/push/subscriptions/d-1', method: 'DELETE', account: 'u-2' },
    ])
    expect(subscription.unsubscribe).toHaveBeenCalled()
  })
})
