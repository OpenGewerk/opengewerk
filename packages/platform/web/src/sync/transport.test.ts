import { workingAsHeader } from '@opengewerk/platform-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  directWrite,
  httpTransport,
  onOtherAccount,
  request,
  RequestRefused,
  requestFile,
  workAs,
  workingInHeaders,
} from './transport.js'

/**
 * What a route answers that has nothing to say: a removal answers 200 with no
 * body at all, and a request that read it as JSON failed after the server had
 * done what was asked (opengewerk/opengewerk-haustechnik#346). A page then
 * stayed on a record that was gone and said it had no connection.
 */

function answering(body: string, status: number): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(status === 204 ? null : body, {
        status,
        headers: body === '' ? {} : { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an answer of the server', () => {
  it('with nothing in it is no answer, and no failure', async () => {
    answering('', 200)

    await expect(request('/roles/own-1', { method: 'DELETE' })).resolves.toBeUndefined()

    answering('', 204)

    await expect(request('/roles/own-1', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('with something in it is read as it was sent, and a refusal stays one', async () => {
    answering('{"key":"own-1"}', 200)

    await expect(request('/roles')).resolves.toEqual({ key: 'own-1' })

    answering('{"message":"Die Rolle ist noch 1 Zugang zugeordnet."}', 409)

    await expect(request('/roles/own-1', { method: 'DELETE' })).rejects.toBeInstanceOf(
      RequestRefused,
    )
  })
})

/**
 * Signing out empties the stores of the device, and the HTTP cache of the
 * browser is out of its reach (opengewerk-haustechnik#360). So nothing the
 * server answers goes there: every request asks past it, whatever its caller
 * asked for, a file included.
 */
describe('a request to the server', () => {
  it('goes past the HTTP cache of the browser, there and back', async () => {
    const sent: (RequestInit | undefined)[] = []

    vi.stubGlobal('fetch', (_path: string, init?: RequestInit) => {
      sent.push(init)

      return Promise.resolve(new Response('[]', { status: 200 }))
    })

    await request('/staff')
    await request('/sync?since=0', { cache: 'default' })
    await request('/roles/own-1', { method: 'DELETE' })
    await requestFile('/staff/table', 'text/csv')

    expect(sent.map((init) => init?.cache)).toEqual([
      'no-store',
      'no-store',
      'no-store',
      'no-store',
    ])
  })
})

/**
 * The account a page works for (opengewerk#882): every request names it, the
 * ones that do not go through `request` included, and the sync client names
 * the person its store was opened for in its place. The server holds either
 * against the session.
 */
describe('the account a request names', () => {
  let sent: { path: string; headers: Record<string, string> }[]

  beforeEach(() => {
    sent = []
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      sent.push({ path, headers: (init?.headers ?? {}) as Record<string, string> })

      return Promise.resolve(
        new Response('{"receipts":[],"changes":[]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
  })

  afterEach(() => {
    workAs(null)
  })

  /** The account a request named, however the name of its header was written. */
  function namedBy(index: number): string[] {
    return Object.entries(sent[index]?.headers ?? {})
      .filter(([name]) => name.toLowerCase() === workingAsHeader)
      .map(([, value]) => value)
  }

  it('is the one of the page once it knows it, on every request, and none before', async () => {
    await request('/auth/tenants')
    workAs('anna')
    await request('/staff')
    await request('/staff/s-1', { method: 'PATCH', body: '{}' })
    await requestFile('/staff/table', 'text/csv')

    expect(namedBy(0)).toEqual([])
    expect(namedBy(1)).toEqual(['anna'])
    expect(namedBy(2)).toEqual(['anna'])
    expect(namedBy(3)).toEqual(['anna'])
    expect(workingInHeaders()[workingAsHeader]).toBe('anna')
  })

  it('is the person of the store for the sync client, once and in place of the one of the page', async () => {
    workAs('bert')

    await httpTransport.push('device', [], 'anna')
    await httpTransport.pull(0, 'anna')
    await httpTransport.upload?.('a'.repeat(64), new ArrayBuffer(1), 'image/png', 'anna')
    await directWrite.patch('contacts', 'c-1', { name: 'Neu' }, 'anna')
    await directWrite.remove('contacts', 'c-1', 'anna')

    for (const index of [0, 1, 2, 3, 4]) {
      expect(namedBy(index)).toEqual(['anna'])
    }

    // A store that names nobody leaves the one of the page.
    await httpTransport.pull(0)
    expect(namedBy(5)).toEqual(['bert'])
  })

  it('heard as another account signed in tells whoever listens, and no other refusal does', async () => {
    let heard = 0
    const stop = onOtherAccount(() => {
      heard += 1
    })
    let code = 'in_use'

    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ code, message: 'Abgelehnt.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(request('/staff', { method: 'POST' })).rejects.toBeInstanceOf(RequestRefused)
    expect(heard).toBe(0)

    code = 'other_account'
    await expect(request('/staff', { method: 'POST' })).rejects.toBeInstanceOf(RequestRefused)
    await expect(requestFile('/staff/table', 'text/csv')).rejects.toBeInstanceOf(RequestRefused)
    expect(heard).toBe(2)

    stop()
    await expect(request('/staff')).rejects.toBeInstanceOf(RequestRefused)
    expect(heard).toBe(2)
  })
})
