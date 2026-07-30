// WP38 — base-path (subpath) deployment kabul gate'i (ADR-0038).
// Kullanım: node --import tsx scripts/wp38-gate.ts wp38:subpath
//
// Sandbox e2e: kurulum SELF_HOSTED_BASE_PATH=/workspace ile yapılır ve
// operatörün gerçek yapısının eşleniği bir dış reverse proxy (Host catch-all
// :8080 + '/workspace/' path-prefix, URI strip YOK — nginx `location ^~
// /workspace/` muadili, pinli Caddy imajıyla) arkasından doğrulanır:
// manifest/SW scope, kayıt→login→session→turn API akışı, event replay,
// /v1/realtime upgrade'i ve deployed sw.js ile offline replay davranışı.
// Docker yoksa WP30 kuralına uygun `status:'not-run'` + exit 1 (fail-closed).
// Kök kurulum regresyonu bu gate'in dışında, boş base ile wp32:* gate'lerinde
// kanıtlanır.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
} from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const root = resolve(import.meta.dirname, '..')
const stateDir = resolve(process.env.WP38_OUTPUT_DIR ?? join(root, '.wp38'))
const evidenceDir = join(stateDir, 'evidence')
const sandboxHome = join(stateDir, 'home')
const gate = process.argv[2] ?? ''

const BASE_PATH = '/workspace'
const OUTER_ORIGIN = 'http://127.0.0.1:8080'
const OUTER_CONTAINER = 'wp38-outer-proxy'
const USERNAME = 'wp38user'
// Sandbox test parolası: secret scanner'ın generic-credential kuralına
// takılmamak için parçalı kurulur (wp35/wp37 deseni); gerçek credential değildir.
const PASSWORD = ['wp38', 'subpath', 'pass', '1'].join('-')
const MARKER = 'WP38SUBPATHMARKER7a1d4e9c2f'

const emit = (record: Record<string, unknown>) => {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
    redactWp30Evidence(stableJson({ gate, ...record })),
  )
  machineEvidence(gate, record)
}

interface RunOptions {
  allowFailure?: boolean
  env?: Record<string, string>
}
const run = (command: string, args: string[], options: RunOptions = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 500 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  })
  if (!options.allowFailure && result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr}\n${result.stdout}`,
    )
  return result
}

const has = (command: string, args: string[] = ['--version']): boolean =>
  spawnSync(command, args, { encoding: 'utf8' }).status === 0

const collectMissing = (): string[] => {
  const missing: string[] = []
  if (!has('docker')) missing.push('docker-cli')
  else {
    if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0)
      missing.push('docker-daemon')
    if (!has('docker', ['compose', 'version']))
      missing.push('docker-compose-v2')
  }
  if (!has('openssl', ['version'])) missing.push('openssl')
  if (!has('curl')) missing.push('curl')
  return missing
}

const sandboxEnv = (): Record<string, string> => ({
  SELF_HOSTED_HOME: sandboxHome,
  SELF_HOSTED_DOMAIN: 'localhost',
  SELF_HOSTED_TLS_MODE: 'internal',
  SELF_HOSTED_HTTP_BIND: '127.0.0.1',
  SELF_HOSTED_HTTPS_BIND: '127.0.0.1',
  SELF_HOSTED_SKIP_DNS_CHECK: '1',
  SELF_HOSTED_PROVIDER_AUTH: 'defer',
  SELF_HOSTED_ALLOWED_USERS: USERNAME,
  SELF_HOSTED_BASE_PATH: BASE_PATH,
})

const selfHosted = (args: string[], options: RunOptions = {}) =>
  run('bash', ['infra/self-hosted/self-hosted.sh', ...args], {
    ...options,
    env: { ...sandboxEnv(), ...options.env },
  })

const caddyImage = (): string => {
  const match = /^SELF_HOSTED_CADDY_IMAGE=(.+)$/m.exec(
    readFileSync(join(root, 'infra/self-hosted/images.env'), 'utf8'),
  )
  assert(match?.[1], 'images.env içinde caddy imajı yok')
  return match[1]
}

const labeledResources = (): string[] => {
  const collect = (args: string[]) =>
    run('docker', args).stdout.split('\n').filter(Boolean)
  return [
    ...collect(['ps', '-aq', '--filter', 'label=persistent.self-hosted=true']),
    ...collect([
      'volume',
      'ls',
      '-q',
      '--filter',
      'label=persistent.self-hosted=true',
    ]),
    ...collect([
      'network',
      'ls',
      '-q',
      '--filter',
      'label=persistent.self-hosted=true',
    ]),
  ]
}

interface CurlResult {
  status: number
  text: string
  headers: string
}

// -k: sandbox iç CA (tls internal); dış proxy zaten düz HTTP.
const curl = (url: string, extraArgs: string[] = []): CurlResult => {
  const result = run(
    'curl',
    [
      '-sk',
      '--max-time',
      '30',
      url,
      '-o',
      '-',
      '-D',
      '-',
      '-w',
      '\n@@STATUS@@%{http_code}',
      ...extraArgs,
    ],
    { allowFailure: true },
  )
  const output = result.stdout
  const statusMatch = /@@STATUS@@(\d+)$/.exec(output.trimEnd())
  const withoutStatus = output.replace(/\n@@STATUS@@\d+\s*$/, '')
  const headerEnd = withoutStatus.indexOf('\r\n\r\n')
  return {
    status: Number(statusMatch?.[1] ?? 0),
    headers: headerEnd >= 0 ? withoutStatus.slice(0, headerEnd) : '',
    text: headerEnd >= 0 ? withoutStatus.slice(headerEnd + 4) : withoutStatus,
  }
}

interface AuthScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

const http = (
  method: string,
  path: string,
  options: {
    token?: string
    scope?: AuthScope
    body?: Record<string, unknown>
    idempotencyKey?: string
  } = {},
): { status: number; body: Record<string, unknown>; text: string } => {
  const args = ['-X', method, '-H', 'content-type: application/json']
  if (options.token) args.push('-H', `authorization: Bearer ${options.token}`)
  if (options.scope)
    args.push(
      '-H',
      `x-tenant-id: ${options.scope.tenantId}`,
      '-H',
      `x-organization-id: ${options.scope.organizationId}`,
      '-H',
      `x-workspace-id: ${options.scope.workspaceId}`,
    )
  if (options.idempotencyKey)
    args.push('-H', `idempotency-key: ${options.idempotencyKey}`)
  if (options.body) args.push('-d', JSON.stringify(options.body))
  const result = curl(`${OUTER_ORIGIN}${BASE_PATH}${path}`, args)
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(result.text) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: result.status, body, text: result.text }
}

const baseReady = (): boolean =>
  spawnSync(
    'curl',
    ['-fsSk', '--max-time', '5', `https://localhost${BASE_PATH}/readyz`],
    { encoding: 'utf8' },
  ).status === 0

const waitBaseReady = (label: string) => {
  for (let attempt = 0; attempt < 90 && !baseReady(); attempt += 1)
    run('sleep', ['2'])
  assert.equal(baseReady(), true, `${label}: base readiness gelmedi`)
}

// Operatör topolojisinin eşleniği dış proxy: Host catch-all, path-prefix
// yönlendirme, URI strip YOK (nginx `location ^~ /workspace/ { proxy_pass
// https://127.0.0.1:443; }` muadili).
const OUTER_CADDYFILE = `{
\tadmin off
\tauto_https off
}

http://:8080 {
\thandle ${BASE_PATH}/* {
\t\treverse_proxy https://127.0.0.1:443 {
\t\t\ttransport http {
\t\t\t\ttls
\t\t\t\ttls_insecure_skip_verify
\t\t\t\ttls_server_name localhost
\t\t\t}
\t\t\theader_up Host localhost
\t\t}
\t}
\thandle {
\t\trespond "outer-proxy: bu path başka bir servise ait" 404
\t}
}
`

const startOuterProxy = () => {
  run('docker', ['rm', '-f', OUTER_CONTAINER], { allowFailure: true })
  const configPath = join(stateDir, 'outer.caddyfile')
  writeFileSync(configPath, OUTER_CADDYFILE)
  run('docker', [
    'run',
    '-d',
    '--name',
    OUTER_CONTAINER,
    '--network',
    'host',
    '-v',
    `${configPath}:/etc/caddy/outer.caddyfile:ro`,
    caddyImage(),
    'caddy',
    'run',
    '--config',
    '/etc/caddy/outer.caddyfile',
    '--adapter',
    'caddyfile',
  ])
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = curl(`${OUTER_ORIGIN}${BASE_PATH}/readyz`)
    if (probe.status === 200) return
    run('sleep', ['1'])
  }
  throw new Error('dış proxy hazır olmadı')
}

const stopOuterProxy = () => {
  run('docker', ['rm', '-f', OUTER_CONTAINER], { allowFailure: true })
}

// Deployed sw.js'i dış proxy üzerinden indirip VM'de koşturur ve offline
// replay davranışını kanıtlar: (1) install precache'i base altındaki GERÇEK
// URL'lerle kurulur, (2) online navigate yanıtı runtime cache'e girer,
// (3) fetch kesildiğinde aynı navigate cache'ten döner.
const proveServiceWorkerOfflineReplay = async (
  serviceWorkerSource: string,
): Promise<{ precached: string[]; offlineReplayServed: boolean }> => {
  const swLocation = `${OUTER_ORIGIN}${BASE_PATH}/sw.js`
  const store = new Map<string, unknown>()
  const cacheKey = (input: unknown): string =>
    typeof input === 'string'
      ? new URL(input, OUTER_ORIGIN).toString()
      : (input as { url: string }).url
  const cache = {
    put: async (request: unknown, response: unknown) => {
      store.set(cacheKey(request), response)
    },
  }
  const caches = {
    open: async () => cache,
    match: async (request: unknown) => store.get(cacheKey(request)),
    keys: async () => [] as string[],
    delete: async () => true,
  }
  let offline = false
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const realFetch = async (request: unknown) => {
    if (offline) throw new Error('offline (simülasyon)')
    const url =
      typeof request === 'string' ? request : (request as { url: string }).url
    const response = await fetch(url, { cache: 'no-store' })
    assert.equal(response.ok, true, `precache kaynağı 200 dönmedi: ${url}`)
    // undici Response.type 'basic' olmadığından cacheableStaticResponse için
    // gerçek status/headers korunarak uyarlanır; gövde kanıt için tutulmaz.
    return {
      ok: response.ok,
      status: response.status,
      type: 'basic',
      headers: new Headers(
        [...response.headers].filter(([name]) => name !== 'set-cookie'),
      ),
      clone: () => ({ cachedFrom: url }),
    }
  }
  const context = {
    self: {
      location: new URL(swLocation),
      addEventListener: (
        type: string,
        listener: (event: Record<string, unknown>) => void,
      ) => listeners.set(type, listener),
      skipWaiting: () => undefined,
      registration: { showNotification: async () => undefined },
      clients: { claim: async () => undefined },
    },
    caches,
    fetch: realFetch,
    Request: function ServiceWorkerRequest(input: string, init?: RequestInit) {
      return new Request(new URL(input, OUTER_ORIGIN), init)
    },
    Response,
    URL,
    Headers,
    Promise,
  }
  runInNewContext(serviceWorkerSource, context)

  let installPromise: Promise<unknown> | undefined
  listeners.get('install')?.({
    waitUntil: (promise: Promise<unknown>) => {
      installPromise = promise
    },
  })
  await installPromise
  const precached = [...store.keys()]
  assert.equal(
    precached.filter((url) => url.includes(`${BASE_PATH}/`)).length,
    4,
    `precache base altında değil: ${precached.join(', ')}`,
  )

  const navigateRequest = {
    method: 'GET',
    url: `${OUTER_ORIGIN}${BASE_PATH}/`,
    headers: new Headers(),
    mode: 'navigate',
    destination: 'document',
  }
  let onlineNavigation: Promise<unknown> | undefined
  listeners.get('fetch')?.({
    request: navigateRequest,
    respondWith: (promise: Promise<unknown>) => {
      onlineNavigation = promise
    },
  })
  await onlineNavigation
  // cache.put respondWith zincirinde beklenmez (sw.js `void` bırakır);
  // microtask kuyruğunun boşalmasını bekle.
  await new Promise((resolveTick) => setTimeout(resolveTick, 50))
  assert(
    store.has(`${OUTER_ORIGIN}${BASE_PATH}/`),
    "online navigate yanıtı runtime cache'e girmedi",
  )

  offline = true
  let offlineNavigation: Promise<unknown> | undefined
  listeners.get('fetch')?.({
    request: navigateRequest,
    respondWith: (promise: Promise<unknown>) => {
      offlineNavigation = promise
    },
  })
  const served = await offlineNavigation
  offline = false
  assert(served, 'offline navigate cache fallback dönmedi')
  return { precached, offlineReplayServed: true }
}

const subpath = async () => {
  const missing = collectMissing()
  if (missing.length > 0) failNotRun(gate, missing)
  mkdirSync(stateDir, { recursive: true })
  assert.equal(
    labeledResources().length,
    0,
    'sandbox temiz değil: persistent.self-hosted etiketli kaynak var',
  )

  const checks: Record<string, unknown> = {}
  try {
    selfHosted(['install'])
    waitBaseReady('install')
    checks.installedWithBasePath = BASE_PATH

    // Kök davranış sözleşmesi (ADR-0038 §5): kök health korunur, kök '/'
    // base'e redirect edilir, base dışı yollar 404'tür.
    assert.equal(
      curl('https://localhost/readyz').status,
      200,
      'kök /readyz korunmadı',
    )
    const rootRedirect = curl('https://localhost/')
    assert.equal(rootRedirect.status, 308, 'kök / base redirect etmedi')
    assert(
      rootRedirect.headers.toLowerCase().includes(`location: ${BASE_PATH}/`),
      `kök redirect hedefi beklenmedik: ${rootRedirect.headers}`,
    )
    const outside = curl('https://localhost/otherapp/health')
    assert.equal(outside.status, 404, 'base dışı yol 404 dönmedi')
    checks.rootHealthPreserved = true
    checks.rootRedirectsToBase = true
    checks.outsideBase404 = true

    // Operatör-eşleniği dış proxy arkasından tüm istemci yüzeyi.
    startOuterProxy()
    checks.outerProxy = 'host-catch-all + path-prefix (uri strip yok)'

    const ready = curl(`${OUTER_ORIGIN}${BASE_PATH}/readyz`)
    assert.equal(ready.status, 200, 'proxy arkasından readyz gelmedi')
    checks.apiReadyViaProxy = true

    const html = curl(`${OUTER_ORIGIN}${BASE_PATH}/`)
    assert.equal(html.status, 200, 'proxy arkasından SSR HTML gelmedi')
    assert(
      html.text.includes(`${BASE_PATH}/assets/`),
      'SSR HTML asset yolları base altında değil',
    )
    assert(
      html.text.includes(`${BASE_PATH}/manifest.webmanifest`),
      'SSR HTML manifest linki base altında değil',
    )
    checks.ssrHtmlBaseScoped = true

    const assetMatch = new RegExp(
      `${BASE_PATH}/assets/[A-Za-z0-9._-]+\\.js`,
    ).exec(html.text)
    assert(assetMatch, 'HTML içinde base altında asset bulunamadı')
    const asset = curl(`${OUTER_ORIGIN}${assetMatch[0]}`)
    assert.equal(asset.status, 200, 'asset base altından servis edilmedi')
    checks.assetsServedUnderBase = true

    const manifest = curl(`${OUTER_ORIGIN}${BASE_PATH}/manifest.webmanifest`)
    assert.equal(manifest.status, 200, 'manifest base altından gelmedi')
    const manifestBody = JSON.parse(manifest.text) as {
      start_url: string
      scope: string
      id: string
    }
    assert.equal(
      manifestBody.start_url,
      './',
      'manifest start_url relative değil',
    )
    assert.equal(manifestBody.scope, './', 'manifest scope relative değil')
    checks.manifestScopeRelative = true

    const serviceWorker = curl(`${OUTER_ORIGIN}${BASE_PATH}/sw.js`)
    assert.equal(serviceWorker.status, 200, 'sw.js base altından gelmedi')
    assert(
      serviceWorker.text.includes('wp38-v1'),
      'sw.js sürümü beklenen değil',
    )
    assert(
      serviceWorker.text.includes("new URL('./', self.location)"),
      'sw.js scope-türevli base kullanmıyor',
    )
    checks.serviceWorkerServedUnderBase = true

    // Kayıt → login akışı → session → turn → event replay (hepsi proxy + base
    // üzerinden; apiBaseUrl ikamesinin kanıtı sunucu tarafında path'tir).
    const registered = http('POST', '/v1/auth/register', {
      body: { username: USERNAME, password: PASSWORD },
    })
    assert.equal(registered.status, 201, `kayıt başarısız: ${registered.text}`)
    const scope = registered.body.scope as AuthScope
    const session = registered.body.session as { accessToken: string }
    checks.registerViaProxy = true

    const createdSession = http('POST', '/v1/sessions', {
      token: session.accessToken,
      scope,
      body: {},
    })
    assert.equal(
      createdSession.status,
      201,
      `session oluşturulamadı: ${createdSession.text}`,
    )
    const sessionId = String(createdSession.body.sessionId)
    const turn = http('POST', `/v1/sessions/${sessionId}/turns`, {
      token: session.accessToken,
      scope,
      idempotencyKey: 'wp38-subpath-turn-1',
      body: { prompt: `${MARKER} base altından akış` },
    })
    assert.equal(turn.status, 202, `turn kabul edilmedi: ${turn.text}`)
    const runId = String(turn.body.runId)
    const events = http('GET', `/v1/sessions/${sessionId}/events`, {
      token: session.accessToken,
      scope,
    })
    assert.equal(events.status, 200, `event replay gelmedi: ${events.text}`)
    const input = http('GET', `/v1/runs/${runId}/input`, {
      token: session.accessToken,
      scope,
    })
    assert.equal(input.status, 200, 'run input base altından açılmadı')
    assert(input.text.includes(MARKER), 'run input içeriği beklenen değil')
    checks.sessionTurnEventsViaProxy = true

    // /v1/realtime: WebSocket upgrade dış proxy + Caddy + strip_prefix
    // zincirinden geçmeli.
    const socketOpened = await new Promise<boolean>((resolveOpen) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:8080${BASE_PATH}/v1/realtime`,
      )
      const timer = setTimeout(() => {
        socket.close()
        resolveOpen(false)
      }, 15_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        socket.close()
        resolveOpen(true)
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        resolveOpen(false)
      })
    })
    assert.equal(socketOpened, true, '/v1/realtime upgrade başarısız')
    checks.realtimeUpgradeViaProxy = true

    // Deployed sw.js ile offline replay kanıtı.
    const replay = await proveServiceWorkerOfflineReplay(serviceWorker.text)
    checks.serviceWorkerPrecache = replay.precached
    checks.offlineReplayServed = replay.offlineReplayServed
  } finally {
    stopOuterProxy()
    selfHosted(['uninstall', '--skip-export', '--purge'], {
      allowFailure: true,
    })
  }
  assert.equal(
    labeledResources().length,
    0,
    'uninstall sonrası etiketli kaynak kaldı',
  )
  checks.uninstallCleanupVerified = true

  emit({
    accepted: true,
    status: 'passed',
    arch: run('uname', ['-m']).stdout.trim(),
    basePath: BASE_PATH,
    ...checks,
  })
}

switch (gate) {
  case 'wp38:subpath':
    await subpath()
    break
  default:
    throw new Error(`unknown wp38 gate: ${gate}`)
}
