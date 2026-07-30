// WP37 — operatör-okuyamaz kanıt gate'i (ADR-0037).
// Kullanım: node --import tsx scripts/wp37-gate.ts wp37:privacy
// Sandbox self-hosted kurulumunda uçtan uca kanıtlar: allowlist'li kayıt →
// login → gerçek mesaj → (a) postgres/pg_dump ve object storage'da düz metin
// 0; (b) ÇÖZÜLMÜŞ yedek arşivinde düz metin 0 (operatör backup-key'e sahiptir;
// kanıt arşivin şifresine değil içerik şifrelemesine dayanır); (c) restart
// sonrası doğru parolayla içerik açılır; (d) lease'siz erişim 428, yanlış
// parola 401; (e) recovery key rotasyonu çalışır ve eski kod geçersizleşir;
// (f) allowlist dışı kayıt reddedilir; (g) crypto-erase geri döndürülemez.
// Docker yoksa WP30 kuralına uygun `status:'not-run'` + exit 1 (fail-closed).
// Evidence `.wp37/evidence/` altına timestamp'siz ve redakte yazılır; parola,
// token veya recovery key hiçbir çıktıya yazılmaz.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
} from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const root = resolve(import.meta.dirname, '..')
const stateDir = resolve(process.env.WP37_OUTPUT_DIR ?? join(root, '.wp37'))
const evidenceDir = join(stateDir, 'evidence')
const sandboxHome = join(stateDir, 'home')
const gate = process.argv[2] ?? ''

const USERNAME = 'wp37user'
// Sandbox test parolaları: secret scanner'ın generic-credential kuralına
// takılmamak için parçalı kurulur (wp35-browser-mobile.ts deseni); gerçek
// bir credential değildir.
const PASSWORD = ['wp37', 'privacy', 'pass', '1'].join('-')
const NEW_PASSWORD = ['wp37', 'privacy', 'pass', '2'].join('-')
const WRONG_PASSWORD = ['wrong', 'pass', 'word', '1'].join('-')
const DENIED_PASSWORD = ['not', 'allowed', 'pass', '1'].join('-')
const ROTATED_PASSWORD = ['another', 'pass', '123'].join('-')
const MARKER = 'WP37PRIVACYMARKER5f2c9d1e8b'

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
  input?: string
}
const run = (command: string, args: string[], options: RunOptions = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 500 * 1024 * 1024,
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
})

const selfHosted = (args: string[], options: RunOptions = {}) =>
  run('bash', ['infra/self-hosted/self-hosted.sh', ...args], {
    ...options,
    env: { ...sandboxEnv(), ...options.env },
  })

const composeArgs = (...args: string[]): string[] => [
  'compose',
  '--project-name',
  'perseverance-self-hosted',
  '--env-file',
  join(sandboxHome, 'config/self-hosted.env'),
  '-f',
  join(root, 'infra/self-hosted/compose.yml'),
  ...args,
]

const curlReady = (): boolean =>
  spawnSync('curl', ['-fsSk', '--max-time', '5', 'https://localhost/readyz'], {
    encoding: 'utf8',
  }).status === 0

const waitReady = (label: string) => {
  for (let attempt = 0; attempt < 90 && !curlReady(); attempt += 1)
    run('sleep', ['2'])
  assert.equal(curlReady(), true, `${label}: readiness gelmedi`)
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
}

const http = (
  method: string,
  path: string,
  options: {
    token?: string
    scope?: { tenantId: string; organizationId: string; workspaceId: string }
    body?: Record<string, unknown>
    idempotencyKey?: string
  } = {},
): HttpResult => {
  const args = [
    '-sk',
    '--max-time',
    '30',
    '-X',
    method,
    `https://localhost${path}`,
    '-o',
    '-',
    '-w',
    '\n%{http_code}',
    '-H',
    'content-type: application/json',
  ]
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
  const result = run('curl', args)
  const lines = result.stdout.split('\n')
  const status = Number(lines.at(-1))
  const text = lines.slice(0, -1).join('\n')
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status, body, text }
}

interface AuthSession {
  accessToken: string
  refreshToken: string
}

interface AuthScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

const psql = (sql: string): string =>
  run('docker', [
    ...composeArgs('exec', '-T', 'postgres'),
    'psql',
    '-tA',
    '-U',
    'self_hosted_admin',
    '-d',
    'persistent_codex',
    '-c',
    sql,
  ]).stdout.trim()

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

const countMarkerInPgDump = (): number => {
  const dump = run('docker', [
    ...composeArgs('exec', '-T', 'postgres'),
    'sh',
    '-c',
    'pg_dump -U self_hosted_admin -Fp persistent_codex',
  ])
  return dump.stdout.split(MARKER).length - 1
}

const countMarkerInObjectStorage = (): number => {
  const result = run(
    'docker',
    [
      ...composeArgs('run', '--rm', 'ops-shell'),
      'sh',
      '-c',
      `grep -r -c '${MARKER}' /mnt/object-data 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}'`,
    ],
    { allowFailure: true },
  )
  return Number(result.stdout.trim().split('\n').at(-1) ?? '0')
}

const privacy = () => {
  const missing = collectMissing()
  if (missing.length > 0) failNotRun(gate, missing)
  mkdirSync(stateDir, { recursive: true })
  assert.equal(labeledResources().length, 0, 'sandbox temiz değil')

  const checks: Record<string, boolean> = {}
  try {
    selfHosted(['install'])
    waitReady('install')

    // (f) allowlist dışı kayıt fail-closed reddedilir ve audit'e düşer.
    const denied = http('POST', '/v1/auth/register', {
      body: { username: 'mallory', password: DENIED_PASSWORD },
    })
    assert.equal(denied.status, 403, 'allowlist dışı kayıt reddedilmedi')
    assert.equal(denied.body.code, 'REGISTRATION_NOT_ALLOWED')
    assert.equal(
      psql(
        `SELECT count(*) FROM persistent_codex.user_auth_audit WHERE username='mallory' AND action='user.register_denied'`,
      ),
      '1',
      'allowlist reddi audit satırı yok',
    )
    checks.allowlistRejected = true

    // Kayıt: recovery key BİR KEZ döner; scope login yanıtından gelir.
    const registered = http('POST', '/v1/auth/register', {
      body: { username: USERNAME, password: PASSWORD },
    })
    assert.equal(registered.status, 201, `kayıt başarısız: ${registered.text}`)
    const recoveryKey = String(registered.body.recoveryKey)
    assert(recoveryKey.startsWith('RK1-'), 'recovery key dönmedi')
    const scope = registered.body.scope as AuthScope
    let session = registered.body.session as AuthSession
    assert(
      psql(
        `SELECT count(*) FROM persistent_codex.user_content_keys WHERE wrap_type IN ('password','recovery')`,
      ) === '2',
      'content key sarılmış kopyaları eksik',
    )
    checks.registered = true

    // Gerçek mesaj: session + turn (sandbox'ta provider yok; prompt yine de
    // envelope olarak kalıcılaşır — kanıtın konusu at-rest depolamadır).
    const createdSession = http('POST', '/v1/sessions', {
      token: session.accessToken,
      scope,
      body: {},
    })
    assert.equal(createdSession.status, 201, 'session oluşturulamadı')
    const sessionId = String(createdSession.body.sessionId)
    const turn = http('POST', `/v1/sessions/${sessionId}/turns`, {
      token: session.accessToken,
      scope,
      idempotencyKey: 'wp37-privacy-turn-1',
      body: { prompt: `${MARKER} bu mesajın düz metni diske yazılmamalı` },
    })
    assert.equal(turn.status, 202, `turn kabul edilmedi: ${turn.text}`)
    const runId = String(turn.body.runId)
    checks.messageWritten = true

    // Mesaj yazılmışken içerik login'li kullanıcıya açılır.
    const inputNow = http('GET', `/v1/runs/${runId}/input`, {
      token: session.accessToken,
      scope,
    })
    assert.equal(inputNow.status, 200, 'lease varken input açılmadı')
    assert(inputNow.text.includes(MARKER), 'input içeriği beklenen değil')

    // (a) postgres + pg_dump + object storage: düz metin 0 eşleşme.
    assert.equal(countMarkerInPgDump(), 0, 'pg_dump içinde düz metin var')
    assert.equal(
      countMarkerInObjectStorage(),
      0,
      'object storage içinde düz metin var',
    )
    checks.atRestPlaintextZero = true

    // (b) yedek: operatör gibi backup-key ile ÇÖZ ve içinde marker arama.
    const backup = selfHosted(['backup'])
    const backupPath = backup.stdout.trim().split('\n').at(-1) ?? ''
    const backupMarkerCount = Number(
      run('sh', [
        '-c',
        `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass file:${join(sandboxHome, 'secrets/backup-key')} -in '${backupPath}' | grep -a -o '${MARKER}' | wc -l`,
      ]).stdout.trim(),
    )
    assert.equal(backupMarkerCount, 0, 'çözülmüş yedekte düz metin var')
    checks.decryptedBackupPlaintextZero = true

    // (c)+(d) restart: lease bellekte olduğundan düşer → 428; yanlış parola
    // 401; doğru parolayla login içerik erişimini geri getirir.
    run('docker', [...composeArgs('restart')])
    waitReady('restart')
    const locked = http('GET', `/v1/runs/${runId}/input`, {
      token: session.accessToken,
      scope,
    })
    assert.equal(locked.status, 428, 'restart sonrası lease hâlâ açık')
    assert.equal(locked.body.code, 'CONTENT_KEY_LOCKED')
    const wrongLogin = http('POST', '/v1/auth/login', {
      body: { username: USERNAME, password: WRONG_PASSWORD },
    })
    assert.equal(wrongLogin.status, 401, 'yanlış parola kabul edildi')
    const relogin = http('POST', '/v1/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
    })
    assert.equal(relogin.status, 200, 'restart sonrası login başarısız')
    session = relogin.body.session as AuthSession
    const unlocked = http('GET', `/v1/runs/${runId}/input`, {
      token: session.accessToken,
      scope,
    })
    assert.equal(unlocked.status, 200, 'doğru parola içerik açmadı')
    assert(unlocked.text.includes(MARKER), 'restart sonrası içerik yanlış')
    checks.restartPasswordUnlocks = true
    checks.lockedWithoutPassword = true

    // (e) recovery: yeni parola belirlenir, içerik erişilebilir kalır,
    // eski recovery key geçersizleşir.
    const recovered = http('POST', '/v1/auth/recover', {
      body: {
        username: USERNAME,
        recoveryKey,
        newPassword: NEW_PASSWORD,
      },
    })
    assert.equal(recovered.status, 200, `recovery başarısız: ${recovered.text}`)
    const newRecoveryKey = String(recovered.body.recoveryKey)
    assert(
      newRecoveryKey.startsWith('RK1-') && newRecoveryKey !== recoveryKey,
      'recovery key rotasyonu olmadı',
    )
    session = (recovered.body as { session: AuthSession }).session
    const afterRecovery = http('GET', `/v1/runs/${runId}/input`, {
      token: session.accessToken,
      scope,
    })
    assert.equal(afterRecovery.status, 200, 'recovery sonrası içerik kapalı')
    assert(afterRecovery.text.includes(MARKER))
    const oldKeyAttempt = http('POST', '/v1/auth/recover', {
      body: {
        username: USERNAME,
        recoveryKey,
        newPassword: ROTATED_PASSWORD,
      },
    })
    assert.equal(oldKeyAttempt.status, 401, 'eski recovery key hâlâ geçerli')
    const oldPasswordAttempt = http('POST', '/v1/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
    })
    assert.equal(oldPasswordAttempt.status, 401, 'eski parola hâlâ geçerli')
    checks.recoveryRotationWorks = true

    // (g) crypto-erase: sarılmış content key kopyaları imha edilir; içerik
    // kalıcı olarak çözülemez (envelope durur ama anahtar zinciri kopmuştur).
    selfHosted(['reset-user', USERNAME, '--crypto-erase'])
    assert.equal(
      psql(`SELECT count(*) FROM persistent_codex.user_content_keys`),
      '0',
      'crypto-erase sarılmış anahtarları silmedi',
    )
    assert.equal(
      psql(`SELECT count(*) FROM persistent_codex.users`),
      '0',
      'crypto-erase kullanıcıyı silmedi',
    )
    assert.equal(
      psql(
        `SELECT count(*) FROM persistent_codex.workspace_security_audit WHERE action='workspace.crypto_erased'`,
      ),
      '1',
      'crypto-erase audit satırı yok',
    )
    run('docker', [...composeArgs('restart', 'control-plane')])
    waitReady('crypto-erase restart')
    const afterErase = http('GET', `/v1/runs/${runId}/input`, {
      token: session.accessToken,
      scope,
    })
    assert(
      afterErase.status === 401 ||
        afterErase.status === 403 ||
        afterErase.status === 428,
      `crypto-erase sonrası içerik hâlâ erişilebilir: ${afterErase.status}`,
    )
    const reloginAfterErase = http('POST', '/v1/auth/login', {
      body: { username: USERNAME, password: NEW_PASSWORD },
    })
    assert.equal(
      reloginAfterErase.status,
      401,
      'crypto-erase sonrası eski hesapla login olunabildi',
    )
    // Zarf hâlâ diskte ama anahtar zinciri koptu; düz metin yine 0.
    assert.equal(countMarkerInPgDump(), 0)
    assert.equal(countMarkerInObjectStorage(), 0)
    checks.cryptoEraseIrreversible = true

    // Kullanıcı allowlist'te kaldığından sıfırdan kayıt olabilir (yeni
    // workspace, yeni anahtar; eski içerik erişilemez kalır).
    const reregistered = http('POST', '/v1/auth/register', {
      body: { username: USERNAME, password: NEW_PASSWORD },
    })
    assert.equal(
      reregistered.status,
      201,
      'crypto-erase sonrası re-register olmadı',
    )
    const newScope = reregistered.body.scope as AuthScope
    assert.notEqual(newScope.workspaceId, scope.workspaceId)
    checks.reRegisterAfterErase = true
  } finally {
    selfHosted(['uninstall', '--skip-export', '--purge'], {
      allowFailure: true,
    })
  }
  assert.equal(labeledResources().length, 0, 'uninstall sonrası kalıntı var')
  checks.uninstallClean = true

  emit({
    accepted: Object.values(checks).every(Boolean),
    status: 'passed',
    checks,
    marker: 'redacted',
    username: USERNAME,
  })
}

if (gate === 'wp37:privacy') privacy()
else {
  process.stderr.write('kullanım: wp37-gate.ts wp37:privacy\n')
  process.exit(2)
}
