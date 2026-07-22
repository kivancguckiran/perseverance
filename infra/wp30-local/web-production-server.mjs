import { createReadStream, existsSync, lstatSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, normalize, resolve } from 'node:path'

const host = process.env.HOST ?? '0.0.0.0'
const port = Number(process.env.PORT ?? 3301)
const origin = `http://${host}:${port}`
const clientRoot = resolve('/app/web/client')
globalThis.require = createRequire(import.meta.url)
const serverEntry = (await import('/app/web-server.mjs')).default
const types = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/healthz' || request.url === '/readyz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ready', role: 'web-ssr' }))
      return
    }
    const url = new URL(request.url ?? '/', origin)
    const relative = normalize(decodeURIComponent(url.pathname)).replace(
      /^[/\\]+/,
      '',
    )
    const staticPath = resolve(clientRoot, relative)
    if (
      staticPath.startsWith(`${clientRoot}/`) &&
      existsSync(staticPath) &&
      lstatSync(staticPath).isFile()
    ) {
      response.writeHead(200, {
        'content-type':
          types[extname(staticPath)] ?? 'application/octet-stream',
      })
      createReadStream(staticPath).pipe(response)
      return
    }
    const rendered = await serverEntry.fetch(
      new Request(url, { headers: request.headers }),
    )
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
    response.end(Buffer.from(await rendered.arrayBuffer()))
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('SSR request failed')
  }
})

server.listen(port, host)
