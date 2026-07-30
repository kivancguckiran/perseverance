// WP38 — base-path (subpath) deployment birim testleri (ADR-0038). Sandbox
// e2e kanıtı wp38:subpath gate'indedir; burada bash normalizasyonu, imaj tag
// kuralı, Caddyfile şablon placeholder'ları ve dağıtım dosyalarının base
// farkındalığı statik olarak doğrulanır.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const libCall = (expression: string) => {
  const result = spawnSync(
    'bash',
    ['-c', `source infra/self-hosted/lib.sh >/dev/null 2>&1; ${expression}`],
    { cwd: root, encoding: 'utf8' },
  )
  return { status: result.status, stdout: result.stdout }
}

describe('normalize_base_path (lib.sh)', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['/workspace', '/workspace'],
    ['/workspace/', '/workspace'],
    ['/a/b-c/d_e~f.g', '/a/b-c/d_e~f.g'],
  ])('kabul eder: %j → %j', (input, expected) => {
    const result = libCall(`normalize_base_path '${input}'`)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(expected)
  })

  it.each([
    'workspace', // başta '/' yok
    '//workspace', // çift slash
    '/workspace//', // boş segment / çift sonda slash
    '/work space', // geçersiz karakter
    '/work/../etc', // path traversal
    '/.', // nokta segmenti
    '/v1', // uygulama-rezerve kök
    '/v1/x',
    '/healthz',
    '/readyz',
    '/assets',
    '/events',
  ])('fail-closed reddeder: %j', (input) => {
    const result = libCall(`normalize_base_path '${input}'`)
    expect(result.status).not.toBe(0)
  })
})

describe('product_image_tag (lib.sh)', () => {
  it('kökte tag değişmez, base slug eklenir', () => {
    expect(libCall(`product_image_tag abc123 ''`).stdout).toBe(
      'perseverance-self-hosted-product:abc123',
    )
    expect(libCall(`product_image_tag abc123 '/workspace'`).stdout).toBe(
      'perseverance-self-hosted-product:abc123-workspace',
    )
    expect(libCall(`product_image_tag abc123 '/a/b'`).stdout).toBe(
      'perseverance-self-hosted-product:abc123-a-b',
    )
  })
})

describe('dağıtım dosyaları base farkındalığı', () => {
  it("Caddyfile şablonu base placeholder'larını içerir ve kök davranışı korur", () => {
    const caddyfile = read('infra/self-hosted/config/Caddyfile.tmpl')
    expect(caddyfile).toContain('@@CONTROL_PLANE_PATHS@@')
    expect(caddyfile).toContain('@@CONTROL_PLANE_STRIP@@')
    expect(caddyfile).toContain('@@BASE_REDIRECT@@')
    // Kök render'ında strip/redirect boşalır; matcher path'i kökte
    // '/v1/* /healthz /readyz' olarak render edilir (self-hosted.sh).
    const script = read('infra/self-hosted/self-hosted.sh')
    expect(script).toContain(
      'local control_plane_paths="/v1/* /healthz /readyz"',
    )
    expect(script).toContain('uri strip_prefix ${base_path}')
    expect(script).toContain('redir / ${base_path}/ 308')
  })

  it("install/upgrade base path'i build-arg olarak indirir ve state imaj referansı yazar", () => {
    const script = read('infra/self-hosted/self-hosted.sh')
    expect(script).toContain('--base-path) export SELF_HOSTED_BASE_PATH=')
    expect(
      script.match(/--build-arg "SELF_HOSTED_BASE_PATH=\$\{base_path\}"/g),
    ).toHaveLength(2)
    expect(script).toContain('run_check base-path-valid')
  })

  it("product.Dockerfile web build'ine VITE_BASE_PATH geçirir", () => {
    const dockerfile = read('infra/self-hosted/product.Dockerfile')
    expect(dockerfile).toContain('ARG SELF_HOSTED_BASE_PATH=')
    expect(dockerfile).toContain('VITE_BASE_PATH="${SELF_HOSTED_BASE_PATH}"')
  })

  it("compose web servisi BASE_PATH env'ini geçirir", () => {
    const compose = read('infra/self-hosted/compose.yml')
    expect(compose).toContain('BASE_PATH: ${SELF_HOSTED_BASE_PATH:-}')
  })

  it("web SSR sunucusu base doğrular ve placeholder'ı origin+base ile ikame eder", () => {
    const server = read('infra/self-hosted/web/self-hosted-web-server.mjs')
    expect(server).toContain("const basePath = process.env.BASE_PATH ?? ''")
    expect(server).toContain('`${publicOrigin}${basePath}`')
    expect(server).toContain('BASE_PATH geçersiz')
    // Kök health endpoint'leri korunur.
    expect(server).toContain(
      "request.url === '/healthz' || request.url === '/readyz'",
    )
  })

  it('manifest relative scope kullanır ve sw.js scope-türevli base kurar', () => {
    const manifest = JSON.parse(
      read('apps/web/public/manifest.webmanifest'),
    ) as { start_url: string; scope: string; id: string }
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
    expect(manifest.id).toBe('./')
    const serviceWorker = read('apps/web/public/sw.js')
    expect(serviceWorker).toContain("new URL('./', self.location)")
    expect(serviceWorker).not.toMatch(/'\/(manifest\.webmanifest|icon-)/)
  })

  it('istemci new URL(kök-mutlak, apiBaseUrl) desenini kullanmaz', () => {
    for (const file of [
      'apps/web/src/workspace-page.tsx',
      'apps/web/src/production-session-page.tsx',
      'apps/web/src/pwa-runtime.tsx',
      'apps/web/src/self-hosted-auth.ts',
      'apps/web/src/login-page.tsx',
    ])
      expect(read(file)).not.toMatch(/new URL\(\s*'\/[^']*',\s*apiBaseUrl\)/)
  })
})
