import {
  focusManager,
  QueryClient,
  QueryObserver,
  type QueryObserverResult,
} from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { request, RequestRefused } from '../sync/transport.js'
import { askAgainOnOtherAccount, forgetOnAccountChange, queries, QueryProvider } from './queries.js'

/**
 * What the cache does with a question that failed. It asks once more where
 * asking again can change the answer, and it takes a refusal for the answer
 * it is: a second attempt waits for a window somebody looks at, and a screen
 * that waits there says something else than "this is not there".
 */

function again(attempt: number, error: unknown): boolean {
  const retry = queries.getDefaultOptions().queries?.retry

  if (typeof retry !== 'function') {
    throw new Error('The cache decides by a function whether it asks again.')
  }

  return retry(attempt, error as Error)
}

const refused = (status: number) =>
  new RequestRefused(status, `Der Server hat die Anfrage abgelehnt (${status}).`)
const broken = () => new TypeError('Failed to fetch')

/** How a question with the options of the cache stands once it stops fetching. */
async function settled(error: unknown): Promise<readonly [string, string]> {
  const client = new QueryClient({ defaultOptions: queries.getDefaultOptions() })
  const observer = new QueryObserver(client, {
    queryKey: ['probe'],
    queryFn: () => Promise.reject(error as Error),
    retryDelay: 1,
  })
  const subscription: { stop: () => void } = { stop: () => undefined }
  const result = await new Promise<QueryObserverResult>((resolve) => {
    subscription.stop = observer.subscribe((state) => {
      if (state.fetchStatus === 'paused' || state.status !== 'pending') {
        resolve(state)
      }
    })
  })

  subscription.stop()
  client.clear()

  return [result.status, result.fetchStatus]
}

describe('a question that failed', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
  })

  it('is asked once more where asking again can change the answer', () => {
    // No answer at all: the connection broke.
    expect(again(0, broken())).toBe(true)
    // The server could not answer, or said "not now".
    expect([500, 502, 503, 504, 408, 429].filter((status) => !again(0, refused(status)))).toEqual(
      [],
    )
    // And never a third time.
    expect(again(1, broken())).toBe(false)
    expect(again(1, refused(503))).toBe(false)
  })

  it('is not asked again where the server has looked at the request and said no', () => {
    expect(
      [400, 401, 403, 404, 409, 410, 413, 422].filter((status) => again(0, refused(status))),
    ).toEqual([])
  })

  it('settles on a refusal in a window nobody looks at, and does not wait there for a second attempt', async () => {
    focusManager.setFocused(false)

    // The record is gone: an error, and nothing that still runs or waits.
    expect(await settled(refused(404))).toEqual(['error', 'idle'])
    // A broken connection is worth the second attempt, and that one waits
    // for the window: this is the state a screen reads as "no connection".
    expect(await settled(broken())).toEqual(['pending', 'paused'])
  })
})

describe('the answers of a page when another account signs in on it', () => {
  const someone = (userId: string, tenantId: string) => ({
    userId,
    email: `${userId}@example.de`,
    name: userId,
    tenantId,
    twoFactorEnabled: false,
    emailVerified: true,
    signInMethod: 'password',
    secondFactor: false,
    deviceId: null,
  })

  it('go where the applications hold them, under the provider they all use', () => {
    const client = new QueryClient()
    const shown = render(createElement(QueryProvider, { client, children: null }))

    client.setQueryData(['account'], someone('anna', 't-1'))
    client.setQueryData(['access-requests'], ['Anfrage von Anna'])
    client.setQueryData(['account'], someone('bert', 't-1'))

    expect(client.getQueryData(['access-requests'])).toBeUndefined()
    shown.unmount()
  })

  it('go, those of the account and the tenant before, and stay for the same one', () => {
    const client = new QueryClient()
    const stop = forgetOnAccountChange(client)

    client.setQueryData(['account'], someone('anna', 't-1'))
    client.setQueryData(['access-requests'], ['Anfrage von Anna'])
    client.setQueryData(['legal-texts'], { imprint: 'Impressum' })

    // The same account again, as a refresh answers it: nothing goes.
    client.setQueryData(['account'], someone('anna', 't-1'))
    expect(client.getQueryData(['access-requests'])).toEqual(['Anfrage von Anna'])

    // Somebody else on the same page.
    client.setQueryData(['account'], someone('bert', 't-1'))
    expect(client.getQueryData(['access-requests'])).toBeUndefined()
    expect(client.getQueryData(['legal-texts'])).toEqual({ imprint: 'Impressum' })

    // Another tenant of the same account.
    client.setQueryData(['tenants'], ['t-1', 't-2'])
    client.setQueryData(['account'], someone('bert', 't-2'))
    expect(client.getQueryData(['tenants'])).toBeUndefined()

    stop()
  })
})

/**
 * The account a page works for (opengewerk#882) is asked again when the
 * server says another one is signed in on the browser; which one the page
 * names is the gate's (`boot.test.tsx`).
 */
describe('the account a page works for', () => {
  const someone = (userId: string) => ({
    userId,
    email: `${userId}@example.de`,
    name: userId,
    tenantId: 't-1',
    twoFactorEnabled: false,
    emailVerified: true,
    signInMethod: 'password',
    secondFactor: false,
    deviceId: null,
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is asked again when the server says another one is signed in, and not over another refusal', async () => {
    const client = new QueryClient()
    let asked = 0

    client.setQueryDefaults(['account'], {
      queryFn: () => {
        asked += 1

        return someone('bert')
      },
    })
    client.setQueryData(['account'], someone('anna'))

    const observer = new QueryObserver(client, { queryKey: ['account'], staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    const stop = askAgainOnOtherAccount(client)
    let code = 'in_use'

    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ code, message: 'Abgelehnt.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(request('/probe', { method: 'POST' })).rejects.toBeInstanceOf(RequestRefused)
    expect(asked).toBe(0)

    code = 'other_account'
    await expect(request('/probe', { method: 'POST' })).rejects.toBeInstanceOf(RequestRefused)
    await vi.waitFor(() => {
      expect(client.getQueryData<{ userId: string }>(['account'])?.userId).toBe('bert')
    })
    expect(asked).toBe(1)

    stop()
    unsubscribe()
  })

  /**
   * The refusal may come from within the question itself, from the sign out
   * it ends: asked over again on every refusal, it asked and was refused
   * without end.
   */
  it('is asked once while the question is under way, however many refusals come meanwhile', async () => {
    const client = new QueryClient()
    let asked = 0
    let answer: (account: unknown) => void = () => {}

    client.setQueryDefaults(['account'], {
      queryFn: () => {
        asked += 1

        return new Promise((resolve) => {
          answer = resolve
        })
      },
    })
    // Known, and being asked again: a page that came back into view.
    client.setQueryData(['account'], someone('anna'))

    const observer = new QueryObserver(client, { queryKey: ['account'], staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    const stop = askAgainOnOtherAccount(client)

    void client.refetchQueries({ queryKey: ['account'] })
    expect(asked).toBe(1)

    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'other_account', message: 'Anderes Konto.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    for (let refusal = 0; refusal < 3; refusal += 1) {
      await expect(request('/auth/sign-out', { method: 'POST' })).rejects.toBeInstanceOf(
        RequestRefused,
      )
    }

    answer(someone('bert'))
    await vi.waitFor(() => {
      expect(client.getQueryData<{ userId: string }>(['account'])?.userId).toBe('bert')
    })
    expect(asked).toBe(1)

    stop()
    unsubscribe()
  })
})
