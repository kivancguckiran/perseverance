// WP32 — self-hosted dağıtım kabul gate'leri (ADR-0032).
// Kullanım: node --import tsx scripts/wp32-gate.ts <gate>
// Gate'ler: wp32:preflight | wp32:install-smoke | wp32:lifecycle |
//           wp32:credential-scan | wp32:golden
// Docker/temiz-VPS/agent-browser gerektiren adımlar ortam eksikse WP30 kuralına
// uygun biçimde `status:'not-run'` + exit 1 raporlar (fail-closed); hiçbir
// not-run sonucu başarıya terfi etmez. Evidence `.wp32/evidence/` altına
// timestamp'siz ve redakte yazılır.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
} from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import {
  WP32_REQUIRED_FILES,
  scanForCredentials,
  wp32StaticScanPolicy,
  type Wp32ScanSource,
} from './wp32-lib'

const root = resolve(import.meta.dirname, '..')
const stateDir = resolve(process.env.WP32_OUTPUT_DIR ?? join(root, '.wp32'))
const evidenceDir = join(stateDir, 'evidence')
const lifecycleDir = join(stateDir, 'lifecycle')
const sandboxHome = join(stateDir, 'home')
const gate = process.argv[2] ?? ''

const emit = (record: Record<string, unknown>) => {
  mkdirSync(evidenceDir, { recursive: true })
  const payload = { gate, ...record }
  writeFileSync(
    join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
    redactWp30Evidence(stableJson(payload)),
  )
  machineEvidence(gate, record)
}

interface RunOptions {
  allowFailure?: boolean
  env?: Record<string, string>
  input?: string
}
const run = (command: string, args: string[], options: RunOptions = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    env: { ...process.env, ...options.env },
    ...(options.input === undefined ? {} : { input: options.input }),
  })
  if (!options.allowFailure && result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr}\n${result.stdout}`,
    )
  return result
}

const has = (command: string, args: string[] = ['--version']): boolean =>
  spawnSync(command, args, { encoding: 'utf8' }).status === 0

const caddyImage = (): string => {
  const match = /^SELF_HOSTED_CADDY_IMAGE=(.+)$/m.exec(
    readFileSync(join(root, 'infra/self-hosted/images.env'), 'utf8'),
  )
  assert(match?.[1], 'images.env içinde caddy imajı yok')
  return match[1]
}

const collectMissing = (): string[] => {
  const missing: string[] = []
  if (!has('docker')) missing.push('docker-cli')
  else {
    if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0)
      missing.push('docker-daemon')
    if (!has('docker', ['compose', 'version']))
      missing.push('docker-compose-v2')
    if (
      spawnSync('docker', ['manifest', 'inspect', caddyImage()], {
        encoding: 'utf8',
      }).status !== 0
    )
      missing.push('container-registry-access')
  }
  if (!has('openssl', ['version'])) missing.push('openssl')
  if (!has('curl')) missing.push('curl')
  return missing
}

// Sandbox kurulum ortamı: loopback'e bağlı, iç CA'lı, DNS kontrolü atlanmış,
// provider auth bilinçli ertelenmiş tek makine kurulumu.
const sandboxEnv = (): Record<string, string> => ({
  SELF_HOSTED_HOME: sandboxHome,
  SELF_HOSTED_DOMAIN: 'localhost',
  SELF_HOSTED_TLS_MODE: 'internal',
  SELF_HOSTED_HTTP_BIND: '127.0.0.1',
  SELF_HOSTED_HTTPS_BIND: '127.0.0.1',
  SELF_HOSTED_SKIP_DNS_CHECK: '1',
  SELF_HOSTED_PROVIDER_AUTH: 'defer',
})

const selfHosted = (
  args: string[],
  options: RunOptions = {},
): ReturnType<typeof run> =>
  run('bash', ['infra/self-hosted/self-hosted.sh', ...args], {
    ...options,
    env: { ...sandboxEnv(), ...options.env },
  })

const composeArgs = (...args: string[]): string[] => [
  'compose',
  '--project-name',
  'persistent-self-hosted',
  '--env-file',
  join(sandboxHome, 'config/self-hosted.env'),
  '-f',
  join(root, 'infra/self-hosted/compose.yml'),
  ...args,
]

const curlReady = (path = '/readyz'): boolean =>
  spawnSync('curl', ['-fsSk', '--max-time', '5', `https://localhost${path}`], {
    encoding: 'utf8',
  }).status === 0

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

const psqlCount = (where: string): number => {
  const result = run('docker', [
    ...composeArgs('exec', '-T', 'postgres'),
    'psql',
    '-U',
    'self_hosted_admin',
    '-d',
    'persistent_codex',
    '-tA',
    '-c',
    // WP36 gerçek-ortam bulgusu: API oturumları production topolojisinde
    // persistent_codex.ha_sessions tablosunda kalıcılaşır; persistent_codex.
    // sessions yalnız corpus placeholder kayıtları içerir. Gate ilk gerçek
    // koşuda yanlış tabloyu saydığı için düzeltildi.
    `SELECT count(*) FROM persistent_codex.ha_sessions WHERE ${where}`,
  ])
  return Number(result.stdout.trim())
}

const readSandboxEnv = (key: string): string => {
  const envText = readFileSync(
    join(sandboxHome, 'config/self-hosted.env'),
    'utf8',
  )
  const match = new RegExp(`^${key}=(.+)$`, 'm').exec(envText)
  assert(match?.[1], `sandbox env eksik: ${key}`)
  return match[1]
}

// ---------------------------------------------------------------------------
// wp32:preflight — ortam hazırlığı (gerçek kurulum ortamı yoksa not-run)
// ---------------------------------------------------------------------------
const preflight = () => {
  const missing = collectMissing()
  if (missing.length > 0) failNotRun(gate, missing)
  const arch = run('uname', ['-m']).stdout.trim()
  emit({
    accepted: true,
    status: 'passed',
    arch,
    checks: [
      'docker-cli',
      'docker-daemon',
      'docker-compose-v2',
      'container-registry-access',
      'openssl',
      'curl',
    ],
  })
}

// ---------------------------------------------------------------------------
// wp32:install-smoke — temiz sandbox'ta tek komut kurulum + cleanup doğrulaması
// ---------------------------------------------------------------------------
const installSmoke = () => {
  const missing = collectMissing()
  if (missing.length > 0) failNotRun(gate, missing)
  assert.equal(
    labeledResources().length,
    0,
    'sandbox temiz değil: persistent.self-hosted etiketli kaynak var',
  )
  const install = selfHosted(['install'])
  const publicReady = curlReady('/readyz')
  const webReady =
    spawnSync('curl', ['-fsSk', '--max-time', '5', 'https://localhost/'], {
      encoding: 'utf8',
    }).status === 0
  const resourcesUp = labeledResources().length
  selfHosted(['uninstall', '--skip-export', '--purge'])
  const leftover = labeledResources().length
  assert.equal(publicReady, true, 'public /readyz doğrulanamadı')
  assert.equal(webReady, true, 'web kökü doğrulanamadı')
  assert.equal(leftover, 0, 'uninstall sonrası etiketli kaynak kaldı')
  emit({
    accepted: true,
    status: 'passed',
    arch: run('uname', ['-m']).stdout.trim(),
    singleCommandInstall: true,
    tlsMode: 'internal',
    publicReadyz: publicReady,
    webRoot: webReady,
    resourcesDuringRun: resourcesUp,
    uninstallCleanupVerified: true,
    installLogSha256Lines: install.stdout.split('\n').length,
  })
}

// ---------------------------------------------------------------------------
// wp32:lifecycle — install → veri → restart → backup → veri kaybı → restore →
// upgrade → rollback → uninstall-with-export; conversation kaybı sıfır olmalı.
// ---------------------------------------------------------------------------
const lifecycle = () => {
  const missing = collectMissing()
  if (missing.length > 0) failNotRun(gate, missing)
  mkdirSync(lifecycleDir, { recursive: true })
  assert.equal(labeledResources().length, 0, 'sandbox temiz değil')

  selfHosted(['install'])
  const organizationId = readSandboxEnv('SELF_HOSTED_ORGANIZATION_ID')
  const workspaceId = readSandboxEnv('SELF_HOSTED_WORKSPACE_ID')

  // Admin token bas ve API üzerinden gerçek bir session (conversation) yarat.
  const token = run('docker', [
    ...composeArgs('exec', '-T', 'identity'),
    'node',
    '/opt/self-hosted/identity-service.mjs',
    'mint',
    'self-hosted-admin',
  ]).stdout.trim()
  const create = run('curl', [
    '-fsSk',
    '-X',
    'POST',
    'https://localhost/v1/sessions',
    '-H',
    `authorization: Bearer ${token}`,
    '-H',
    'content-type: application/json',
    '-H',
    `x-tenant-id: ${organizationId}`,
    '-H',
    `x-organization-id: ${organizationId}`,
    '-H',
    `x-workspace-id: ${workspaceId}`,
    '-d',
    '{}',
  ])
  const sessionId = (JSON.parse(create.stdout) as { sessionId: string })
    .sessionId
  assert(sessionId, 'session oluşturulamadı')

  // Restart: istemci kapalıyken stack yeniden başlar, veri yerinde kalmalı.
  run('docker', [...composeArgs('restart')])
  for (let attempt = 0; attempt < 60 && !curlReady(); attempt += 1)
    run('sleep', ['2'])
  assert.equal(curlReady(), true, 'restart sonrası readiness gelmedi')
  assert.equal(
    psqlCount(`session_id='${sessionId}'`),
    1,
    'restart sonrası session kayboldu',
  )

  // Yedek al → veriyi bilinçli sil → geri yükle → veri geri gelmeli.
  const backup = selfHosted(['backup'])
  const backupPath = backup.stdout.trim().split('\n').at(-1) ?? ''
  assert(existsSync(backupPath), `yedek dosyası yok: ${backupPath}`)
  run('docker', [
    ...composeArgs('exec', '-T', 'postgres'),
    'psql',
    '-U',
    'self_hosted_admin',
    '-d',
    'persistent_codex',
    '-c',
    `DELETE FROM persistent_codex.ha_sessions WHERE session_id='${sessionId}'`,
  ])
  assert.equal(psqlCount(`session_id='${sessionId}'`), 0)
  selfHosted(['restore', backupPath])
  assert.equal(
    psqlCount(`session_id='${sessionId}'`),
    1,
    'restore session kaybetti',
  )

  // Upgrade: throwaway boş commit ile gerçek upgrade akışı; ardından rollback.
  run('git', [
    '-C',
    root,
    'commit',
    '--allow-empty',
    '-m',
    'wp32 lifecycle upgrade probe',
  ])
  const probeCommit = run('git', [
    '-C',
    root,
    'rev-parse',
    'HEAD',
  ]).stdout.trim()
  try {
    selfHosted(['upgrade'])
    assert.equal(curlReady(), true, 'upgrade sonrası readiness gelmedi')
    assert.equal(
      psqlCount(`session_id='${sessionId}'`),
      1,
      'upgrade session kaybetti',
    )
    selfHosted(['rollback'])
    assert.equal(curlReady(), true, 'rollback sonrası readiness gelmedi')
    assert.equal(
      psqlCount(`session_id='${sessionId}'`),
      1,
      'rollback session kaybetti',
    )
  } finally {
    run('git', ['-C', root, 'reset', '--hard', `${probeCommit}~1`], {
      allowFailure: true,
    })
  }

  // Runtime credential taraması için ham logları topla (bellekte tara, diske
  // yalnız redakte kopya + sonuç yaz).
  const logs = run('docker', [...composeArgs('logs', '--no-color')], {
    allowFailure: true,
  })
  const runtimeSources: Wp32ScanSource[] = [
    { name: 'docker-compose-logs', content: `${logs.stdout}\n${logs.stderr}` },
  ]

  // Uninstall-with-export: export arşivi üret, çöz ve conversation dump'ının
  // export içinde olduğunu doğrula; ardından sıfır kalıntı.
  const exportDir = join(lifecycleDir, 'export')
  mkdirSync(exportDir, { recursive: true })
  const backupKey = readFileSync(
    join(sandboxHome, 'secrets/backup-key'),
    'utf8',
  )
  writeFileSync(join(lifecycleDir, 'backup-key.tmp'), backupKey, {
    mode: 0o600,
  })
  selfHosted(['uninstall', '--export', exportDir])
  const exportArchives = run('sh', [
    '-c',
    `ls ${exportDir}/*.tar.enc`,
  ]).stdout.trim()
  const exportArchive = exportArchives.split('\n').at(-1) ?? ''
  assert(existsSync(exportArchive), 'export arşivi üretilmedi')
  const listing = run('sh', [
    '-c',
    `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass file:${join(lifecycleDir, 'backup-key.tmp')} -in '${exportArchive}' | tar -t`,
  ])
  assert(
    listing.stdout.includes('database.dump'),
    'export arşivi database.dump içermiyor',
  )
  runtimeSources.push({
    name: 'export-archive-listing',
    content: listing.stdout,
  })
  const rawExport = run('sh', [
    '-c',
    `cat '${exportArchive}' | head -c 1048576 | base64`,
  ])
  runtimeSources.push({
    name: 'export-archive-ciphertext-sample-base64',
    content: rawExport.stdout,
  })
  run('sh', ['-c', `rm -f ${join(lifecycleDir, 'backup-key.tmp')}`])
  const leftover = labeledResources().length
  assert.equal(leftover, 0, 'uninstall sonrası etiketli kaynak kaldı')

  const runtimeScan = scanForCredentials(runtimeSources)
  writeFileSync(
    join(lifecycleDir, 'runtime-scan.json'),
    stableJson({
      gate: 'wp32:lifecycle',
      sources: runtimeSources.map((source) => source.name),
      findings: runtimeScan,
      passed: runtimeScan.length === 0,
    }),
  )
  writeFileSync(
    join(lifecycleDir, 'compose-logs.redacted.log'),
    redactWp30Evidence(runtimeSources[0]?.content ?? ''),
  )

  emit({
    accepted: runtimeScan.length === 0,
    status: runtimeScan.length === 0 ? 'passed' : 'failed',
    sessionSurvived: {
      restart: true,
      backupRestore: true,
      upgrade: true,
      rollback: true,
    },
    exportContainsDatabaseDump: true,
    uninstallCleanupVerified: true,
    runtimeCredentialFindings: runtimeScan.length,
  })
  if (runtimeScan.length > 0) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// wp32:credential-scan — statik dağıtım taraması + lifecycle runtime kanıtı
// ---------------------------------------------------------------------------
const credentialScan = () => {
  const staticSources: Wp32ScanSource[] = [
    ...WP32_REQUIRED_FILES,
    'scripts/wp32-lib.ts',
    'scripts/wp32-gate.ts',
    'scripts/wp32-test-gate.ts',
    'scripts/wp32-accept.ts',
  ].map((path) => ({
    name: path,
    content: readFileSync(join(root, path), 'utf8'),
  }))
  const staticFindings = scanForCredentials(staticSources, wp32StaticScanPolicy)
  const staticRecord = {
    staticSourcesScanned: staticSources.length,
    staticFindings: staticFindings.length,
    staticFindingDetails: staticFindings,
  }
  if (staticFindings.length > 0) {
    emit({ accepted: false, status: 'failed', ...staticRecord })
    process.exitCode = 1
    return
  }
  const runtimePath = join(lifecycleDir, 'runtime-scan.json')
  if (!existsSync(runtimePath)) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(
      join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
      stableJson({
        gate,
        accepted: false,
        status: 'not-run',
        ...staticRecord,
        missing: ['lifecycle-runtime-evidence (pnpm wp32:lifecycle)'],
      }),
    )
    failNotRun(gate, ['lifecycle-runtime-evidence (pnpm wp32:lifecycle)'])
  }
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8')) as {
    passed: boolean
    findings: unknown[]
    sources: string[]
  }
  emit({
    accepted: runtime.passed,
    status: runtime.passed ? 'passed' : 'failed',
    ...staticRecord,
    runtimeSources: runtime.sources,
    runtimeFindings: runtime.findings.length,
  })
  if (!runtime.passed) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// wp32:golden — self-hosted kurulum üzerinde PWA golden senaryosu
// (telefon viewport'u, detached task, kapat/yeniden aç replay, reconnect)
// ---------------------------------------------------------------------------
const golden = async () => {
  const required = [
    'WP32_GOLDEN_URL',
    'WP32_BROWSER_SESSION',
    'WP32_GOLDEN_READY_SELECTOR',
    'WP32_GOLDEN_TASK_START_BUTTON',
    'WP32_GOLDEN_TASK_RUNNING_SELECTOR',
    'WP32_GOLDEN_TASK_DONE_SELECTOR',
  ] as const
  const missingEnv = required.filter((name) => !process.env[name])
  const missing: string[] = [...missingEnv]
  if (!has('agent-browser')) missing.push('agent-browser-cli')
  if (missing.length > 0) failNotRun(gate, missing)

  const exec = promisify(execFile)
  const browser = async (...args: string[]) =>
    (
      await exec('agent-browser', args, {
        env: {
          ...process.env,
          AGENT_BROWSER_SESSION: process.env.WP32_BROWSER_SESSION,
        },
        maxBuffer: 20 * 1024 * 1024,
      })
    ).stdout.trim()

  const url = new URL(process.env.WP32_GOLDEN_URL!)
  assert.equal(url.protocol, 'https:', 'golden URL https olmalı (TLS zorunlu)')
  assert(
    !url.username && !url.password && !url.search,
    'golden URL credential/query içeremez',
  )
  const evalJson = async (expression: string) => {
    const raw = await browser('eval', expression)
    const parsed: unknown = JSON.parse(raw)
    return (typeof parsed === 'string' ? JSON.parse(parsed) : parsed) as Record<
      string,
      unknown
    >
  }
  try {
    await browser('open', url.toString())
    await browser('wait', process.env.WP32_GOLDEN_READY_SELECTOR!)

    // PWA yüzeyi: manifest + service worker kaydı (telefon kurulum yolu).
    const pwa = await evalJson(
      `fetch('/manifest.webmanifest',{cache:'no-store'}).then((r)=>r.ok).then((manifestOk)=>navigator.serviceWorker.getRegistration().then((registration)=>JSON.stringify({manifestOk,serviceWorker:Boolean(registration)})))`,
    )
    assert.equal(pwa.manifestOk, true, 'PWA manifest sunulmuyor')
    assert.equal(pwa.serviceWorker, true, 'service worker kayıtlı değil')

    // Telefon viewport'u: yatay taşma yok, arayüz hazır.
    await browser('set', 'viewport', '390', '844')
    const layout = await evalJson(
      `JSON.stringify({overflow:document.documentElement.scrollWidth>innerWidth,ready:Boolean(document.querySelector(${JSON.stringify(process.env.WP32_GOLDEN_READY_SELECTOR)}))})`,
    )
    assert.equal(layout.overflow, false)
    assert.equal(layout.ready, true)

    // Detached task: başlat, çalıştığını gör, istemciyi kapat.
    await browser('click', process.env.WP32_GOLDEN_TASK_START_BUTTON!)
    await browser('wait', process.env.WP32_GOLDEN_TASK_RUNNING_SELECTOR!)
    const pathBefore = (await browser('eval', 'location.pathname')).trim()
    await browser('close')

    // İstemci kapalıyken task sunucuda sürer; yeniden bağlan ve replay doğrula.
    await new Promise((resolveWait) => setTimeout(resolveWait, 15_000))
    await browser('open', `${url.origin}${JSON.parse(pathBefore)}`)
    await browser('wait', process.env.WP32_GOLDEN_READY_SELECTOR!)
    await browser(
      'wait',
      `${process.env.WP32_GOLDEN_TASK_DONE_SELECTOR!}, ${process.env.WP32_GOLDEN_TASK_RUNNING_SELECTOR!}`,
    )
    const replay = await evalJson(
      `JSON.stringify({path:location.pathname,done:Boolean(document.querySelector(${JSON.stringify(process.env.WP32_GOLDEN_TASK_DONE_SELECTOR)})),running:Boolean(document.querySelector(${JSON.stringify(process.env.WP32_GOLDEN_TASK_RUNNING_SELECTOR)}))})`,
    )
    assert.equal(replay.path, JSON.parse(pathBefore))
    assert.equal(
      Boolean(replay.done) || Boolean(replay.running),
      true,
      'replay sonrası task durumu görünmüyor',
    )
    emit({
      accepted: true,
      status: 'passed',
      selfHostedTarget: true,
      pwaManifest: true,
      serviceWorkerRegistered: true,
      mobileViewport: '390x844',
      detachedTaskStarted: true,
      clientClosedDuringTask: true,
      replayAfterReconnect: true,
    })
  } finally {
    await browser('close').catch(() => undefined)
  }
}

switch (gate) {
  case 'wp32:preflight':
    preflight()
    break
  case 'wp32:install-smoke':
    installSmoke()
    break
  case 'wp32:lifecycle':
    lifecycle()
    break
  case 'wp32:credential-scan':
    credentialScan()
    break
  case 'wp32:golden':
    await golden()
    break
  default:
    throw new Error(`unknown wp32 gate: ${gate}`)
}
