import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
  },
})

try {
  await server.listen()
  const address = server.httpServer?.address()
  assert(
    address && typeof address === 'object',
    'Vite HTTP server did not bind',
  )

  for (const pathname of ['/', '/sessions/ssr-regression']) {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`)
    const body = await response.text()
    assert.equal(
      response.status,
      200,
      `${pathname} returned ${response.status}`,
    )
    assert.match(body, /Perseverance/)
    assert.doesNotMatch(body, /ReferenceError|SessionPage is not defined/)
  }

  console.log('SSR HTTP smoke passed for / and /sessions/:sessionId')
} finally {
  await server.close()
}
