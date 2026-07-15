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
) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const put = vi.fn(async () => undefined)
  const skipWaiting = vi.fn()
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
      location: { origin: 'https://workspace.test' },
      addEventListener: (
        type: string,
        listener: (event: Record<string, unknown>) => void,
      ) => listeners.set(type, listener),
      skipWaiting,
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
  return { listeners, caches, cache, put, skipWaiting }
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
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#0d1714',
      background_color: '#0a100e',
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
    expect(serviceWorkerUrl).toContain('phase2-v2')
    expect(serviceWorkerSource).toContain('phase2-v2')
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
