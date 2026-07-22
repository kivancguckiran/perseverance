import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const WP30_LOCAL_ROOT = resolve(import.meta.dirname, '..')
export const WP30_LOCAL_STATE = join(WP30_LOCAL_ROOT, '.wp30')
export const WP30_LOCAL_ENV = join(WP30_LOCAL_STATE, 'local.env')
export const WP30_LOCAL_COMPOSE = join(
  WP30_LOCAL_ROOT,
  'infra/wp30-local/compose.yml',
)
export const WP30_LOCAL_IMAGES = join(
  WP30_LOCAL_ROOT,
  'infra/wp30-local/images.env',
)
export const WP30_LOCAL_LABEL = 'persistent.wp30.local=true'

export const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')

export const parseEnv = (content: string) =>
  Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=')
        assert(separator > 0, `invalid environment line: ${line}`)
        return [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )

export const readLocalEnv = () => parseEnv(readFileSync(WP30_LOCAL_ENV, 'utf8'))
export const readPinnedImages = () =>
  parseEnv(readFileSync(WP30_LOCAL_IMAGES, 'utf8'))

export const isAllowedLocalHostname = (hostname: string) =>
  hostname === '127.0.0.1' ||
  hostname === 'localhost' ||
  [
    'control-plane',
    'web',
    'postgres',
    'cache',
    'object-storage',
    'workspace-agent',
  ].includes(hostname)

export const assertLocalUrl = (name: string, value: string) => {
  const url = new URL(value)
  assert(
    ['http:', 'https:', 'ws:', 'wss:', 'postgresql:'].includes(url.protocol),
  )
  assert(
    isAllowedLocalHostname(url.hostname),
    `${name} is not loopback/internal`,
  )
  assert(!url.username && !url.password, `${name} must not contain userinfo`)
  return url
}

export const assertLocalInvariant = (env: Record<string, string>) => {
  assert.equal(env.WP30_EVIDENCE_CLASS, 'local-operator')
  assert.equal(env.WP30_EXTERNAL_PRODUCTION_READY, 'false')
  assert.equal(env.WP30_TARGET_SCOPE, 'loopback-only')
}

export const assertEnvFileSecurity = () => {
  assert.equal(statSync(WP30_LOCAL_ENV).mode & 0o777, 0o600)
  const ignored = spawnSync('git', ['check-ignore', '-q', WP30_LOCAL_ENV], {
    cwd: WP30_LOCAL_ROOT,
  })
  assert.equal(ignored.status, 0, '.wp30/local.env must be gitignored')
}

export const randomSecret = () => randomBytes(32).toString('base64url')

export const composeArgs = (...args: string[]) => [
  'compose',
  '--project-name',
  'persistent-wp30-local',
  '--env-file',
  WP30_LOCAL_ENV,
  '-f',
  WP30_LOCAL_COMPOSE,
  ...args,
]

export const run = (
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean
    input?: string
    env?: NodeJS.ProcessEnv
  } = {},
) => {
  const result = spawnSync(command, args, {
    cwd: WP30_LOCAL_ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    input: options.input,
    env: options.env ?? process.env,
  })
  if (!options.allowFailure && result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n')
    throw new Error(`${command} failed with status ${result.status}: ${output}`)
  }
  return result
}

export const assertPinnedImage = (image: string) => {
  assert.match(image, /^[^\s@]+:[^\s@]+@sha256:[a-f0-9]{64}$/)
  const expected = image.slice(image.indexOf('@') + 1)
  const inspected = run(
    'docker',
    ['image', 'inspect', image, '--format', '{{join .RepoDigests "\\n"}}'],
    { allowFailure: true },
  )
  assert.equal(
    inspected.status,
    0,
    `pinned image unavailable: ${image.split('@')[0]}`,
  )
  assert(
    inspected.stdout.includes(expected),
    `image digest mismatch: ${image.split('@')[0]}`,
  )
}

export const redactInventoryName = (name: string) =>
  name.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted-id]')

export const assertAbsoluteCodex = (value: string) => {
  assert(isAbsolute(value), 'WP30_CODEX_BIN must be absolute')
  const version = run(value, ['--version'])
  assert.match(version.stdout, /(?:^|\s)0\.144\.2(?:\s|$)/)
}
