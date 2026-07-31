// WP38 (ADR-0038): SW tek statik dosya kalır ve scope'unu servis edildiği
// yerden türetir — kökte BASE '/', base-path'li kurulumda '/workspace/' gibi.
// Tüm precache/never-cache yolları bu base ile kurulur; kök davranışı bire bir
// korunur.
const BASE = new URL('./', self.location).pathname
const CACHE_PREFIX = 'persistent-workspace-shell-'
const CACHE_VERSION = `${CACHE_PREFIX}wp38-v1`
const SHELL = [
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
].map((name) => `${BASE}${name}`)
const NEVER_CACHE = [
  'v1/',
  'readyz',
  'healthz',
  'events',
  'auth',
  'attachments/',
  'artifacts/',
].map((name) => `${BASE}${name}`)

function cacheableStaticResponse(response) {
  const cacheControl = response.headers.get('cache-control') ?? ''
  return (
    response.ok &&
    response.type === 'basic' &&
    !/no-store|private/i.test(cacheControl) &&
    !response.headers.has('set-cookie')
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        SHELL.map(async (url) => {
          const request = new Request(url, { cache: 'reload' })
          const response = await fetch(request)
          if (cacheableStaticResponse(response))
            await cache.put(request, response.clone())
        }),
      ),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

const PUSH_STATUSES = new Set([
  'approval_required',
  'approval_resolved',
  'turn_completed',
  'turn_failed',
])

function safePushPayload(event) {
  try {
    const value = event.data?.json()
    const keys = Object.keys(value ?? {})
      .sort()
      .join(',')
    if (
      keys !== 'approvalId,notificationId,sessionId,status,version' ||
      value.version !== 1 ||
      typeof value.notificationId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      !(value.approvalId === null || typeof value.approvalId === 'string') ||
      !PUSH_STATUSES.has(value.status)
    )
      return null
    return value
  } catch {
    return null
  }
}

self.addEventListener('push', (event) => {
  const payload = safePushPayload(event)
  if (!payload) return
  const approval = payload.status === 'approval_required'
  event.waitUntil(
    self.registration.showNotification(
      approval ? 'Secure approval required' : 'Task status updated',
      {
        body: approval
          ? 'Open the workspace to review context and decide.'
          : 'View the latest status in your secure workspace.',
        icon: `${BASE}icon-192.png`,
        badge: `${BASE}icon-192.png`,
        tag: `pcw:${payload.notificationId}`,
        renotify: approval,
        requireInteraction: approval,
        data: payload,
      },
    ),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const payload = event.notification.data
  if (!payload || typeof payload.sessionId !== 'string') return
  const target = new URL(
    `${BASE}sessions/${encodeURIComponent(payload.sessionId)}`,
    self.location.origin,
  )
  target.searchParams.set('notification', payload.notificationId)
  if (payload.approvalId)
    target.searchParams.set('approval', payload.approvalId)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      )
      if (existing) {
        await existing.navigate(target.href)
        return existing.focus()
      }
      return self.clients.openWindow(target.href)
    })(),
  )
})

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) =>
        Promise.all(
          windows.map((client) =>
            client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' }),
          ),
        ),
      ),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    request.headers.has('authorization') ||
    NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))
  )
    return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (cacheableStaticResponse(response))
            void caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put(request, response.clone()))
          return response
        })
        .catch(async () => (await caches.match(request)) ?? caches.match(BASE)),
    )
    return
  }

  if (
    url.pathname.startsWith(`${BASE}assets/`) &&
    ['script', 'style', 'font', 'image'].includes(request.destination)
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (cacheableStaticResponse(response))
            void caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put(request, response.clone()))
          return response
        })
      }),
    )
  }
})
