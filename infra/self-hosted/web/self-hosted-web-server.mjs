// WP32 — self-hosted SSR/PWA sunucusu (ADR-0032).
// wp30 web-production-server deseninin self-hosted uyarlaması: web bundle'ı
// build sırasında `https://public-origin.invalid` placeholder origin'i ile
// üretilir; bu sunucu açılışta client asset'lerini ve SSR bundle'ını yazılabilir
// bir dizine kopyalayıp placeholder'ı kanonik PUBLIC_ORIGIN ile değiştirir.
// Böylece aynı imaj her alan adında domain-agnostik çalışır (UI fork'u yok).
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'

const host = process.env.HOST ?? '0.0.0.0'
const port = Number(process.env.PORT ?? 3301)
const publicOrigin = (process.env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '')
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(publicOrigin)) {
  process.stderr.write(
    'PUBLIC_ORIGIN zorunludur ve https:// ile başlamalıdır\n',
  )
  process.exit(1)
}
// WP38 (ADR-0038): base-path'li kurulumda statik/SSR servis base altından
// yapılır ve placeholder ikamesi origin+base ile çalışır (apiBaseUrl base'i
// içerir). Boş BASE_PATH = kök = bugünkü davranış. Fail-closed doğrulama:
// imaj build'i ile uyumsuz/geçersiz base yapılandırması sunucuyu başlatmaz.
const basePath = process.env.BASE_PATH ?? ''
if (
  basePath !== '' &&
  !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(basePath)
) {
  process.stderr.write(
    `BASE_PATH geçersiz (başta '/', sonda yok, segmentler [A-Za-z0-9._~-]): ${basePath}\n`,
  )
  process.exit(1)
}

const PLACEHOLDER = 'https://public-origin.invalid'
const SUBSTITUTABLE = new Set(['.js', '.mjs', '.html', '.webmanifest', '.json'])
const imageClientRoot = '/app/web/client'
const imageServerBundle = '/app/web-server.mjs'

const runtimeRoot = mkdtempSync(join(tmpdir(), 'self-hosted-web-'))
const clientRoot = join(runtimeRoot, 'client')
cpSync(imageClientRoot, clientRoot, { recursive: true })

// apiBaseUrl base'i içermelidir: https://domain/workspace (kökte https://domain).
const substitutionTarget = `${publicOrigin}${basePath}`
const substitute = (path) => {
  const content = readFileSync(path, 'utf8')
  if (!content.includes(PLACEHOLDER)) return
  writeFileSync(path, content.replaceAll(PLACEHOLDER, substitutionTarget))
}
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (SUBSTITUTABLE.has(extname(path))) substitute(path)
  }
}
walk(clientRoot)

const serverBundlePath = join(runtimeRoot, 'web-server.mjs')
writeFileSync(
  serverBundlePath,
  readFileSync(imageServerBundle, 'utf8').replaceAll(
    PLACEHOLDER,
    substitutionTarget,
  ),
)

globalThis.require = createRequire(import.meta.url)
const serverEntry = (await import(serverBundlePath)).default
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
    // Kök health endpoint'leri her durumda korunur (compose healthcheck +
    // monitoring geriye uyumluluğu); base altındaki /readyz Caddy tarafından
    // control-plane'e taşınır (ADR-0038 §5).
    if (request.url === '/healthz' || request.url === '/readyz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ status: 'ready', role: 'self-hosted-web-ssr' }),
      )
      return
    }
    const url = new URL(request.url ?? '/', publicOrigin)
    if (basePath !== '') {
      if (url.pathname === basePath) {
        // Tam base isteği kanonik base/'e yönlendirilir (SW scope ve router
        // basepath eşleşmesi için).
        response.writeHead(308, { location: `${basePath}/${url.search}` })
        response.end()
        return
      }
      if (url.pathname === '/') {
        response.writeHead(308, { location: `${basePath}/${url.search}` })
        response.end()
        return
      }
      if (!url.pathname.startsWith(`${basePath}/`)) {
        // Base dışı yollar bu instance'a ait değildir (belgelenmiş davranış).
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found (base path dışında)')
        return
      }
    }
    const scopedPathname =
      basePath === '' ? url.pathname : url.pathname.slice(basePath.length)
    const relative = normalize(decodeURIComponent(scopedPathname)).replace(
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
