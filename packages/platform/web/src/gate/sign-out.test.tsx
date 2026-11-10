import 'fake-indexeddb/auto'

import { type OperationId, type TenantId, workingAsHeader } from '@opengewerk/platform-domain'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InterfaceApplication } from '../application.js'
import { InProbe, probeApplication, probeRules } from '../probe-application.js'
import {
  keptTenantsKey,
  rememberAccount,
  rememberedAccount,
  rememberSignedIn,
  rememberTenants,
} from '../session/remembered.js'
import { SyncClient } from '../sync/client.js'
import { deleteLocalStore, openLocalStore, storesOnDevice } from '../sync/store.js'
import { TestServer } from '../sync/test-server.js'
import { workAs } from '../sync/transport.js'
import { SignOutButton } from './sign-out.js'

/**
 * Signing out takes what the device holds of every tenant with it (#186),
 * and asks first when something has not reached the server.
 *
 * In between, the application ends what it keeps on the server for this
 * device (ADR 0010). The tests run with an application that belongs to
 * nobody, and with its records.
 */

let asked: string[]

/** A tenant that has been open on this device, with a shelf in its store. */
async function kept(tenantId: string, unsent = false): Promise<void> {
  const store = await openLocalStore(tenantId)

  await store.write('shelves', [{ id: 's-1', name: 'Regal am Fenster' }])

  if (unsent) {
    await store.queue({
      id: 'o-1' as OperationId,
      entity: 'shelves',
      recordId: 's-2',
      kind: 'create',
      baseVersion: null,
      patches: [{ field: 'name', from: null, to: 'Regal an der Tür' }],
      recordedAt: new Date('2026-09-23T08:00:00.000Z'),
      deviceId: 'device',
    })
  }

  store.close()
}

function button(
  onSignedOut: () => void,
  options: { readonly client?: SyncClient; readonly application?: InterfaceApplication } = {},
) {
  return render(
    <InProbe application={options.application}>
      <SignOutButton client={options.client ?? null} onSignedOut={onSignedOut} />
    </InProbe>,
  )
}

beforeEach(async () => {
  for (const tenant of await storesOnDevice()) {
    await deleteLocalStore(tenant)
  }

  // What the browser keeps of a sign in, as no test before left it: a sign
  // out leaves the account signed in since in place (opengewerk#905).
  globalThis.localStorage.clear()

  asked = []
  vi.stubGlobal('fetch', (path: string) => {
    asked.push(path)

    return Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signing out', () => {
  it('takes the store of every tenant on this device with it, then ends the session', async () => {
    await kept('t-nord')
    await kept('t-sued')
    rememberAccount({
      userId: 'u-1',
      email: 'max@nord.example.de',
      name: 'Max',
      tenantId: 't-nord' as TenantId,
      twoFactorEnabled: false,
      signInMethod: 'password',
      secondFactor: false,
    })
    const signedOut = vi.fn()

    button(signedOut)
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

    await waitFor(() => {
      expect(signedOut).toHaveBeenCalled()
    })
    expect(await storesOnDevice()).toEqual([])
    expect(asked).toContain('/auth/sign-out')
  })

  it('takes the stores of the tenants before as well where the browser cannot list its databases', async () => {
    await kept('t-nord')
    await kept('t-sued')
    rememberAccount({
      userId: 'u-1',
      email: 'max@nord.example.de',
      name: 'Max',
      tenantId: 't-nord' as TenantId,
      twoFactorEnabled: false,
      signInMethod: 'password',
      secondFactor: false,
    })
    // A browser without `indexedDB.databases`, as some still are.
    const databases = indexedDB.databases.bind(indexedDB)

    Object.defineProperty(indexedDB, 'databases', { value: undefined, configurable: true })

    try {
      const signedOut = vi.fn()

      button(signedOut)
      await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

      await waitFor(() => {
        expect(signedOut).toHaveBeenCalled()
      })
    } finally {
      Object.defineProperty(indexedDB, 'databases', { value: databases, configurable: true })
    }

    expect(await storesOnDevice()).toEqual([])
  })

  it('takes the stores a version from before opened, by the tenants of the account', async () => {
    await kept('t-nord')
    await kept('t-sued')
    // Opened before this browser kept a list of the stores it opened.
    globalThis.localStorage.removeItem('opengewerk.stores')
    rememberAccount({
      userId: 'u-1',
      email: 'max@nord.example.de',
      name: 'Max',
      tenantId: 't-nord' as TenantId,
      twoFactorEnabled: false,
      signInMethod: 'password',
      secondFactor: false,
    })
    rememberTenants(
      ['t-nord', 't-sued'].map((id) => ({
        id: id as TenantId,
        name: id,
        roles: ['owner'],
        roleLabels: ['Inhaber'],
        rights: [],
        secondFactor: false,
      })),
    )
    const databases = indexedDB.databases.bind(indexedDB)

    Object.defineProperty(indexedDB, 'databases', { value: undefined, configurable: true })

    try {
      const signedOut = vi.fn()

      button(signedOut)
      await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

      await waitFor(() => {
        expect(signedOut).toHaveBeenCalled()
      })
    } finally {
      Object.defineProperty(indexedDB, 'databases', { value: databases, configurable: true })
    }

    expect(await storesOnDevice()).toEqual([])
  })

  it('asks before changes that never reached the server are lost', async () => {
    await kept('t-nord', true)
    const signedOut = vi.fn()

    button(signedOut)
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Auf diesem Gerät liegt noch 1 Änderung, die den Server nicht erreicht hat.',
    )
    expect(await storesOnDevice()).toEqual(['t-nord'])
    expect(signedOut).not.toHaveBeenCalled()

    // Staying keeps everything.
    await userEvent.click(screen.getByRole('button', { name: 'Angemeldet bleiben' }))
    expect(await storesOnDevice()).toEqual(['t-nord'])

    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Trotzdem abmelden' }))

    await waitFor(() => {
      expect(signedOut).toHaveBeenCalled()
    })
    expect(await storesOnDevice()).toEqual([])
  })

  /**
   * Ben signed in in another tab since Anna's page opened (opengewerk#905),
   * kept by the browser as `remember` keeps him. His store stays his; Anna's
   * sign out takes her own store along, and what she left waiting in his,
   * and asks about that alone.
   */
  async function annaLeavesBen(remember: () => void) {
    const operation = (id: string) => ({
      id: id as OperationId,
      entity: 'shelves',
      recordId: `s-${id}`,
      kind: 'create' as const,
      baseVersion: null,
      patches: [{ field: 'name', from: null, to: 'Regal' }],
      recordedAt: new Date('2026-11-10T08:00:00.000Z'),
      deviceId: 'device',
    })
    // Anna's own store, with a change of hers.
    const nord = await openLocalStore('t-nord', 'u-1')

    await nord.queue(operation('o-anna-nord'))
    nord.close()

    // Ben's, with a change Anna left there before he took it over.
    const before = await openLocalStore('t-sued', 'u-1')

    await before.queue(operation('o-anna-sued'))
    before.close()

    const sued = await openLocalStore('t-sued', 'u-2')

    await sued.queue(operation('o-ben'))
    sued.close()

    remember()
    workAs('u-1')

    const signedOut = vi.fn()

    try {
      button(signedOut)
      await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

      // Hers in both stores, not his.
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Auf diesem Gerät liegen noch 2 Änderungen, die den Server nicht erreicht haben.',
      )

      await userEvent.click(screen.getByRole('button', { name: 'Trotzdem abmelden' }))

      await waitFor(() => {
        expect(signedOut).toHaveBeenCalled()
      })
    } finally {
      workAs(null)
    }

    expect(await storesOnDevice()).toEqual(['t-sued'])

    const left = await openLocalStore('t-sued')

    expect((await left.readOutbox()).map((each) => each.id)).toEqual(['o-ben'])
    expect(await left.whose()).toBe('u-2')
    left.close()
  }

  it('leaves the stores and the sign in of the account signed in since in another tab', async () => {
    await annaLeavesBen(() => {
      rememberAccount({
        userId: 'u-2',
        email: 'ben@sued.example.de',
        name: 'Ben',
        tenantId: 't-sued' as TenantId,
        twoFactorEnabled: false,
        signInMethod: 'password',
        secondFactor: false,
      })
    })

    expect(rememberedAccount()?.userId).toBe('u-2')
  })

  /**
   * Ben chose another tenant without a network, or has not chosen one yet:
   * the account his tab opens with is forgotten or was never kept, and who
   * is signed in on the browser stays known (opengewerk#905).
   */
  it('leaves them as well while the account signed in since keeps no tenant to open with', async () => {
    await annaLeavesBen(() => {
      rememberSignedIn('u-2')
      rememberTenants([
        {
          id: 't-sued' as TenantId,
          name: 'Süd',
          roles: ['member'],
          roleLabels: ['Mitglied'],
          rights: [],
          secondFactor: false,
        },
      ])
    })

    expect(rememberedAccount()).toBeNull()
    expect(globalThis.localStorage.getItem('opengewerk.signedIn')).toBe('u-2')
    expect(
      (
        JSON.parse(globalThis.localStorage.getItem(keptTenantsKey) ?? 'null') as { id: string }[]
      ).map((each) => each.id),
    ).toEqual(['t-sued'])
  })

  /** The question may stand while the page moves on to another account (opengewerk#882). */
  it('signs out the account that asked, when the loss is confirmed after the page moved on', async () => {
    await kept('t-nord', true)
    const named: (string | undefined)[] = []
    const signedOut = vi.fn()

    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      if (path === '/auth/sign-out') {
        named.push((init?.headers as Record<string, string>)[workingAsHeader])
      }

      return Promise.resolve(
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      )
    })
    workAs('u-1')

    try {
      button(signedOut)
      await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))
      await screen.findByRole('alert')

      workAs('u-2')
      await userEvent.click(screen.getByRole('button', { name: 'Trotzdem abmelden' }))

      await waitFor(() => {
        expect(signedOut).toHaveBeenCalled()
      })
      expect(named).toEqual(['u-1'])
    } finally {
      workAs(null)
    }
  })

  it('sends first when it can, and then asks nothing', async () => {
    const server = new TestServer()
    const client = await SyncClient.start({
      store: await openLocalStore('t-west'),
      transport: server,
      writer: server,
      rules: probeRules,
      deviceId: 'device',
      entities: ['notes'],
      onSignedOut: () => {},
    })

    server.offline = true
    await client.create('notes', { text: 'Leiter im Flur vergessen' })
    expect(client.status().pending).toBe(1)
    server.offline = false

    const signedOut = vi.fn()

    button(signedOut, { client })
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

    await waitFor(() => {
      expect(signedOut).toHaveBeenCalled()
    })
    expect(server.operations()).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(await storesOnDevice()).toEqual([])
  })

  /**
   * Sending the outbox first may end with the answer that another account
   * is signed in on the browser, and the page moves on to it (opengewerk#882).
   * The sign out is still the one of the account whose screen asked for it,
   * what the application ends for the device included, and the server
   * refuses it for the other.
   */
  it('names the account the page worked for when asked, after the page moved on', async () => {
    const named: (string | undefined)[] = []
    const endedFor: (string | null)[] = []
    const signedOut = vi.fn()
    const moving = {
      synchronise: () => {
        workAs('u-2')

        return Promise.resolve()
      },
      stop: () => {},
    } as unknown as SyncClient

    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      if (path === '/auth/sign-out') {
        named.push((init?.headers as Record<string, string>)[workingAsHeader])
      }

      return Promise.resolve(
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      )
    })
    workAs('u-1')

    try {
      button(signedOut, {
        client: moving,
        application: probeApplication({
          beforeSignOut: (account) => {
            endedFor.push(account)

            return Promise.resolve()
          },
        }),
      })
      await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

      await waitFor(() => {
        expect(signedOut).toHaveBeenCalled()
      })
      expect(endedFor).toEqual(['u-1'])
      expect(named).toEqual(['u-1'])
    } finally {
      workAs(null)
    }
  })
})

describe('what an application ends for a device at the sign out', () => {
  /**
   * After the data is gone and before the session is: there has to be a
   * session to end something with, and a sign out that left the store behind
   * because something on the server took its time would be the wrong order.
   */
  it('goes after what the device held and before the session', async () => {
    await kept('t-nord')

    const order: string[] = []
    let held: readonly string[] | null = null
    const signedOut = vi.fn()

    vi.stubGlobal('fetch', (path: string) => {
      order.push(path)

      return Promise.resolve(
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      )
    })

    button(signedOut, {
      application: probeApplication({
        beforeSignOut: async () => {
          held = await storesOnDevice()
          order.push('the application')
        },
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

    await waitFor(() => {
      expect(signedOut).toHaveBeenCalled()
    })
    expect(held).toEqual([])
    expect(order).toEqual(['the application', '/auth/sign-out'])
  })

  /** Never in the way: whatever goes wrong in it, the session ends all the same. */
  it.each([
    ['fails later', () => Promise.reject(new Error('The server did not take the row off.'))],
    [
      'fails at once',
      () => {
        throw new Error('This browser has no service worker.')
      },
    ],
  ])('signs out all the same when it %s', async (_how, beforeSignOut) => {
    await kept('t-nord')
    const signedOut = vi.fn()

    button(signedOut, { application: probeApplication({ beforeSignOut }) })
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

    await waitFor(() => {
      expect(signedOut).toHaveBeenCalled()
    })
    expect(asked).toContain('/auth/sign-out')
    expect(await storesOnDevice()).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  /**
   * And never for long. Something that does not answer, as a server behind a
   * network that swallows requests, holds the sign out up for a few seconds
   * and not for ever.
   */
  it('waits for it a few seconds and not for ever', async () => {
    const signedOut = vi.fn()

    button(signedOut, {
      application: probeApplication({ beforeSignOut: () => new Promise(() => {}) }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }))

    // It is waited for: the session is still there a moment later.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(signedOut).not.toHaveBeenCalled()
    expect(asked).not.toContain('/auth/sign-out')

    await waitFor(
      () => {
        expect(signedOut).toHaveBeenCalled()
      },
      { timeout: 6_000 },
    )
    expect(asked).toContain('/auth/sign-out')
  }, 10_000)
})
