import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

export const PINNED_CODEX_VERSION = '0.144.2'

export interface AlphaConfig {
  workspaceCwd: string
  databasePath: string
  artifactRoot: string
  codexHomeRoot: string
  provisioningSource?: string
  codexBin: string
}

export interface PreflightCheck {
  name:
    | 'codex'
    | 'workspace'
    | 'database'
    | 'artifacts'
    | 'codexHome'
    | 'provisioning'
  status: 'ready' | 'failed'
  code: string | null
}

export class AlphaPreflightError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AlphaPreflightError'
    this.code = code
  }
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path)
  const anchors = [
    resolve(process.cwd()),
    resolve(tmpdir()),
    resolve(homedir()),
  ]
    .filter(
      (candidate) =>
        absolute === candidate || absolute.startsWith(`${candidate}${sep}`),
    )
    .sort((left, right) => right.length - left.length)
  let current: string = anchors[0] ?? sep
  const tail = relative(current, absolute)
  const parts = tail ? tail.split(sep).filter(Boolean) : []
  for (const part of parts) {
    current = resolve(current, part)
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new AlphaPreflightError('PATH_SYMLINK_COMPONENT')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function safeDirectory(path: string, create = false): string {
  const target = resolve(path)
  if (
    target === '/proc' ||
    target.startsWith('/proc/') ||
    target === '/sys' ||
    target.startsWith('/sys/')
  )
    throw new AlphaPreflightError('UNSAFE_RUNTIME_PATH')
  assertNoSymlinkComponents(target)
  if (create) mkdirSync(target, { recursive: true, mode: 0o700 })
  const stat = lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new AlphaPreflightError('UNSAFE_RUNTIME_PATH')
  const canonical = realpathSync(target)
  const mode = stat.mode & 0o777
  if ((mode & 0o222) === 0) throw new AlphaPreflightError('PATH_NOT_WRITABLE')
  accessSync(canonical, constants.R_OK | constants.W_OK | constants.X_OK)
  return canonical
}

export function validateProvisioningSource(path: string): string {
  let source: string
  try {
    source = safeDirectory(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AlphaPreflightError('PROVISIONING_SOURCE_MISSING')
    throw error
  }
  let found = false
  for (const filename of ['auth.json', 'config.toml']) {
    try {
      const candidate = resolve(source, filename)
      const canonical = realpathSync(candidate)
      const rel = relative(source, canonical)
      if (rel === '..' || rel.startsWith(`..${sep}`))
        throw new AlphaPreflightError('PROVISIONING_SYMLINK_ESCAPE')
      const stat = lstatSync(candidate)
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new AlphaPreflightError('PROVISIONING_TARGET_NOT_FILE')
      found = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!found) throw new AlphaPreflightError('AUTH_CONFIG_MISSING')
  return source
}

export function runAlphaPreflight(config: AlphaConfig): PreflightCheck[] {
  const checks: PreflightCheck[] = []
  const check = (name: PreflightCheck['name'], operation: () => void) => {
    try {
      operation()
      checks.push({ name, status: 'ready', code: null })
    } catch (error) {
      checks.push({
        name,
        status: 'failed',
        code:
          error instanceof AlphaPreflightError
            ? error.code
            : `PREFLIGHT_${name.toUpperCase()}_FAILED`,
      })
    }
  }
  check('codex', () => {
    const output = execFileSync(config.codexBin, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    if (
      !new RegExp(
        `(?:^|\\s)${PINNED_CODEX_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`,
      ).test(output.trim())
    )
      throw new AlphaPreflightError('CODEX_VERSION_MISMATCH')
  })
  check('workspace', () => {
    safeDirectory(config.workspaceCwd)
  })
  check('database', () => {
    safeDirectory(dirname(resolve(config.databasePath)), true)
  })
  check('artifacts', () => {
    safeDirectory(config.artifactRoot, true)
  })
  check('codexHome', () => {
    safeDirectory(config.codexHomeRoot, true)
  })
  if (config.provisioningSource)
    check('provisioning', () => {
      validateProvisioningSource(config.provisioningSource!)
    })
  return checks
}
