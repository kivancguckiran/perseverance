import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { serviceWorkerUrl } from './pwa-runtime'

const publicDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
)
const serviceWorkerSource = readFileSync(join(publicDirectory, 'sw.js'), 'utf8')

function pngDimensions(name: string) {
  const bytes = readFileSync(join(publicDirectory, name))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function serviceWorkerHarness(
  fetchResponse: {
    ok: boolean
    type: string
    headers: Headers
    clone(): unknown
  } = {
    ok: true,
    type: 'basic',
    headers: new Headers(),
    clone: () => ({ asset: true }),
  },
  // WP38: sw.js scope'unu servis edildiği URL'den türetir; base-path'li
  // kurulum 'https://workspace.test/workspace/sw.js' ile simüle edilir.
  serviceWorkerLocation = 'https://workspace.test/sw.js',
) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const put = vi.fn(async () => undefined)
  const skipWaiting = vi.fn()
  const showNotification = vi.fn(async () => undefined)
  const cache = {
    addAll: vi.fn(async () => undefined),
    put,
  }
  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  }
  const context = {
    self: {
      location: new URL(serviceWorkerLocation),
      addEventListener: (
        type: string,
        listener: (event: Record<string, unknown>) => void,
      ) => listeners.set(type, listener),
      skipWaiting,
      registration: { showNotification },
      clients: { claim: vi.fn(async () => undefined) },
    },
    caches,
    fetch: vi.fn(async () => fetchResponse),
    Request: function ServiceWorkerRequest(input: string, init?: RequestInit) {
      return new Request(new URL(input, 'https://workspace.test'), init)
    },
    Response,
    URL,
    Promise,
  }
  runInNewContext(serviceWorkerSource, context)
  return {
    listeners,
    caches,
    cache,
    put,
    skipWaiting,
    showNotification,
    context,
  }
}

describe('production PWA assets and cache boundary', () => {
  it('publishes an installable scoped standalone manifest with PNG icons', () => {
    const manifest = JSON.parse(
      readFileSync(join(publicDirectory, 'manifest.webmanifest'), 'utf8'),
    ) as {
      start_url: string
      scope: string
      display: string
      theme_color: string
      background_color: string
      icons: Array<{ src: string; sizes: string; purpose: string }>
    }
    expect(manifest).toMatchObject({
      // WP38: relative üyeler manifest'in servis edildiği base'e çözülür
      // (kökte '/', base-path'li kurulumda '/workspace/').
      start_url: './',
      scope: './',
      display: 'standalone',
      theme_color: '#f3f2f2',
      background_color: '#f3f2f2',
    })
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      ]),
    )
    expect(pngDimensions('icon-192.png')).toEqual({ width: 192, height: 192 })
    expect(pngDimensions('icon-512.png')).toEqual({ width: 512, height: 512 })
    expect(pngDimensions('icon-maskable-512.png')).toEqual({
      width: 512,
      height: 512,
    })
  })

  it('uses one explicit version and waits for user-approved activation', async () => {
    expect(serviceWorkerUrl).toContain('wp38-v1')
    expect(serviceWorkerSource).toContain('wp38-v1')
    const harness = serviceWorkerHarness()
    let installPromise: Promise<unknown> | undefined
    harness.listeners.get('install')?.({
      waitUntil: (promise: Promise<unknown>) => {
        installPromise = promise
      },
    })
    await installPromise
    expect(harness.cache.addAll).not.toHaveBeenCalled()
    expect(harness.put).toHaveBeenCalledTimes(4)
    expect(harness.skipWaiting).not.toHaveBeenCalled()
    harness.listeners.get('message')?.({ data: { type: 'SKIP_WAITING' } })
    expect(harness.skipWaiting).toHaveBeenCalledOnce()
  })

  it('accepts only opaque content-free push payloads', async () => {
    const harness = serviceWorkerHarness()
    let pushPromise: Promise<unknown> | undefined
    harness.listeners.get('push')?.({
      data: {
        json: () => ({
          version: 1,
          notificationId: 'not_opaque',
          sessionId: 'ses_opaque',
          approvalId: 'apr_opaque',
          status: 'approval_required',
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        pushPromise = promise
      },
    })
    await pushPromise
    expect(harness.showNotification).toHaveBeenCalledWith(
      'Secure approval required',
      expect.objectContaining({
        tag: 'pcw:not_opaque',
        requireInteraction: true,
      }),
    )

    harness.listeners.get('push')?.({
      data: {
        json: () => ({
          version: 1,
          notificationId: 'not_leaky',
          sessionId: 'ses_leaky',
          approvalId: null,
          status: 'turn_completed',
          command: 'secret command',
        }),
      },
      waitUntil: vi.fn(),
    })
    expect(harness.showNotification).toHaveBeenCalledTimes(1)
  })

  it('does not pre-cache HTML or private install responses', async () => {
    expect(serviceWorkerSource).not.toMatch(/const SHELL = \[\s*'\/'/)
    const harness = serviceWorkerHarness({
      ok: true,
      type: 'basic',
      headers: new Headers({
        'cache-control': 'private, no-store',
        'set-cookie': 'session=redacted',
      }),
      clone: () => ({ private: true }),
    })
    let installPromise: Promise<unknown> | undefined
    harness.listeners.get('install')?.({
      waitUntil: (promise: Promise<unknown>) => {
        installPromise = promise
      },
    })
    await installPromise
    expect(harness.put).not.toHaveBeenCalled()
  })

  it.each([
    '/v1/sessions/ses/usage',
    '/readyz',
    '/events',
    '/attachments/private',
    '/artifacts/private',
    '/auth/session',
  ])('never intercepts sensitive response path %s', (path) => {
    const harness = serviceWorkerHarness()
    const respondWith = vi.fn()
    harness.listeners.get('fetch')?.({
      request: new Request(`https://workspace.test${path}`),
      respondWith,
    })
    expect(respondWith).not.toHaveBeenCalled()
  })

  it('does not intercept even static requests carrying authorization', () => {
    const harness = serviceWorkerHarness()
    const respondWith = vi.fn()
    harness.listeners.get('fetch')?.({
      request: new Request('https://workspace.test/assets/app.js', {
        headers: { authorization: 'Bearer redacted' },
      }),
      respondWith,
    })
    expect(respondWith).not.toHaveBeenCalled()
  })

  it('caches only the route-matched navigation shell for offline hydration', async () => {
    const harness = serviceWorkerHarness()
    let navigationResponse: Promise<Response> | undefined
    const request = {
      method: 'GET',
      url: 'https://workspace.test/sessions/ses-safe',
      headers: new Headers(),
      mode: 'navigate',
      destination: 'document',
    }
    harness.listeners.get('fetch')?.({
      request,
      respondWith: (promise: Promise<Response>) => {
        navigationResponse = promise
      },
    })
    await navigationResponse
    await Promise.resolve()
    expect(harness.put).toHaveBeenCalledWith(request, { asset: true })
  })

  it('refuses private/no-store asset responses and caches safe static assets', async () => {
    const privateHarness = serviceWorkerHarness({
      ok: true,
      type: 'basic',
      headers: new Headers({ 'cache-control': 'private, no-store' }),
      clone: () => ({ private: true }),
    })
    let privateResponse: Promise<Response> | undefined
    privateHarness.listeners.get('fetch')?.({
      request: {
        method: 'GET',
        url: 'https://workspace.test/assets/private.js',
        headers: new Headers(),
        mode: 'same-origin',
        destination: 'script',
      },
      respondWith: (promise: Promise<Response>) => {
        privateResponse = promise
      },
    })
    await privateResponse
    await Promise.resolve()
    expect(privateHarness.put).not.toHaveBeenCalled()

    const safeHarness = serviceWorkerHarness({
      ok: true,
      type: 'basic',
      headers: new Headers({
        'cache-control': 'public, max-age=31536000',
      }),
      clone: () => ({ safe: true }),
    })
    let safeResponse: Promise<Response> | undefined
    safeHarness.listeners.get('fetch')?.({
      request: {
        method: 'GET',
        url: 'https://workspace.test/assets/app.js',
        headers: new Headers(),
        mode: 'same-origin',
        destination: 'script',
      },
      respondWith: (promise: Promise<Response>) => {
        safeResponse = promise
      },
    })
    await safeResponse
    await Promise.resolve()
    expect(safeHarness.put).toHaveBeenCalledOnce()
  })
})

describe('WP38: service worker scope under a base path', () => {
  const baseLocation = 'https://workspace.test/workspace/sw.js'
  type AnyMock = ReturnType<typeof vi.fn>

  it('derives precache and cache boundary from the served base', async () => {
    const harness = serviceWorkerHarness(undefined, baseLocation)
    let installPromise: Promise<unknown> | undefined
    harness.listeners.get('install')?.({
      waitUntil: (promise: Promise<unknown>) => {
        installPromise = promise
      },
    })
    await installPromise
    expect(harness.put).toHaveBeenCalledTimes(4)
    const precached = (harness.put as AnyMock).mock.calls.map(
      (call) => new URL((call as [Request])[0].url).pathname,
    )
    expect(precached).toEqual(
      expect.arrayContaining([
        '/workspace/manifest.webmanifest',
        '/workspace/icon-192.png',
        '/workspace/icon-512.png',
        '/workspace/icon-maskable-512.png',
      ]),
    )
  })

  it.each([
    '/workspace/v1/sessions/ses/usage',
    '/workspace/readyz',
    '/workspace/events',
    '/workspace/auth/session',
  ])('never intercepts base-scoped sensitive path %s', (path) => {
    const harness = serviceWorkerHarness(undefined, baseLocation)
    const respondWith = vi.fn()
    harness.listeners.get('fetch')?.({
      request: new Request(`https://workspace.test${path}`),
      respondWith,
    })
    expect(respondWith).not.toHaveBeenCalled()
  })

  it('falls back to the base shell for offline navigations', async () => {
    const harness = serviceWorkerHarness(undefined, baseLocation)
    const shellResponse = { shell: true }
    const match = harness.caches.match as AnyMock
    match.mockResolvedValueOnce(undefined)
    match.mockResolvedValueOnce(shellResponse)
    ;(harness.context as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    let navigationResponse: Promise<unknown> | undefined
    harness.listeners.get('fetch')?.({
      request: {
        method: 'GET',
        url: 'https://workspace.test/workspace/sessions/ses-offline',
        headers: new Headers(),
        mode: 'navigate',
        destination: 'document',
      },
      respondWith: (promise: Promise<unknown>) => {
        navigationResponse = promise
      },
    })
    const resolved = await navigationResponse
    expect(resolved).toBe(shellResponse)
    expect(match).toHaveBeenLastCalledWith('/workspace/')
  })

  it('targets notification clicks under the base path', async () => {
    const harness = serviceWorkerHarness(undefined, baseLocation)
    const navigate = vi.fn(async () => undefined)
    const focus = vi.fn(async () => undefined)
    ;(harness.context.self.clients as { matchAll?: unknown }).matchAll = vi.fn(
      async () => [
        { url: 'https://workspace.test/workspace/', navigate, focus },
      ],
    )
    let clickPromise: Promise<unknown> | undefined
    harness.listeners.get('notificationclick')?.({
      notification: {
        close: vi.fn(),
        data: {
          sessionId: 'ses_base',
          notificationId: 'not_base',
          approvalId: null,
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        clickPromise = promise
      },
    })
    await clickPromise
    expect(navigate).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/sessions/ses_base'),
    )
  })
})
