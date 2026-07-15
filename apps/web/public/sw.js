const CACHE_PREFIX = 'persistent-workspace-shell-'
const CACHE_VERSION = `${CACHE_PREFIX}phase2-v2`
const SHELL = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
]
const NEVER_CACHE = [
  '/v1/',
  '/readyz',
  '/healthz',
  '/events',
  '/auth',
  '/attachments/',
  '/artifacts/',
]

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
        .catch(async () => (await caches.match(request)) ?? caches.match('/')),
    )
    return
  }

  if (
    url.pathname.startsWith('/assets/') &&
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
