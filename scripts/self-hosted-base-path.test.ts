// Self-hosted base-path deployment unit tests (ADR-0038).
// e2e kanıtı self-hosted-base-path:subpath gate'indedir; burada bash normalizasyonu, imaj tag
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

const pwaManifestCall = (expression: string) =>
  spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { configurePwaManifest, normalizePwaId } from './infra/self-hosted/web/pwa-manifest.mjs'; ${expression}`,
    ],
    { cwd: root, encoding: 'utf8' },
  )

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

describe('public origin ve PWA identity normalizasyonu', () => {
  it.each([
    ['Workspace.Example.com', 'workspace.example.com'],
    ['imac.ferahfeza.net', 'imac.ferahfeza.net'],
  ])('domain kabul eder: %s', (input, expected) => {
    const result = libCall(`normalize_domain '${input}'`)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(expected)
  })

  it.each([
    '',
    'https://workspace.example.com',
    'workspace.example.com/path',
    '*.example.com',
    '.example.com',
    'example..com',
    '-bad.example',
  ])('domain fail-closed reddeder: %j', (input) => {
    expect(libCall(`normalize_domain '${input}'`).status).not.toBe(0)
  })

  it('ilk base path değerinden root-relative identity türetir', () => {
    expect(libCall(`pwa_id_for_base '/workspace'`).stdout).toBe('/workspace/')
    expect(libCall(`pwa_id_for_base ''`).stdout).toBe('/')
  })

  it('identity sabitken launch path ve ikonları yeni base path altında üretir', () => {
    const result = pwaManifestCall(`
      const value = configurePwaManifest(
        { id: './', start_url: './', scope: './', icons: [{ src: './icon.png' }] },
        { basePath: '/perseverance', pwaId: '/workspace/' },
      );
      process.stdout.write(JSON.stringify(value));
    `)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: '/workspace/',
      start_url: '/perseverance/',
      scope: '/perseverance/',
      icons: [{ src: '/perseverance/icon.png' }],
    })
  })

  it('PWA identity içinde origin, query ve traversal kabul etmez', () => {
    for (const value of [
      'https://other.example/app',
      '/app?user=1',
      '/app#fragment',
      '/../app/',
    ]) {
      const result = pwaManifestCall(
        `normalizePwaId(${JSON.stringify(value)}, '/perseverance')`,
      )
      expect(result.status).not.toBe(0)
    }
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
    expect(compose).toContain('PWA_ID: ${SELF_HOSTED_PWA_ID:-}')
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

  it('reconfigure yedek, rebuild, rollback ve public readiness uygular', () => {
    const script = read('infra/self-hosted/self-hosted.sh')
    expect(script).toContain('cmd_reconfigure()')
    expect(script).toContain('reconfigure öncesi şifreli yedek alınıyor')
    expect(script).toContain('rollback_reconfigure()')
    expect(script).toContain(
      'update_env_value SELF_HOSTED_PWA_ID "${current_pwa_id}"',
    )
    expect(script).toContain('wait_public_ready "${target_origin}" 60')
    expect(script).toContain('reconfigure) cmd_reconfigure')
    expect(
      script.match(
        /compose up -d --wait --wait-timeout 600 --force-recreate proxy/g,
      ),
    ).toHaveLength(4)
    const lib = read('infra/self-hosted/lib.sh')
    expect(lib).toContain('write_current_release_state()')
    expect(lib).toContain("printf 'SELF_HOSTED_BASE_PATH=%s\\n'")
    expect(script).toContain(
      'update_env_value SELF_HOSTED_BASE_PATH "${previous_base}"',
    )
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
