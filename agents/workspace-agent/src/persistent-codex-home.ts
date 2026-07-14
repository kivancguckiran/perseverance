import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export class CodexHomePathError extends Error {
  readonly code = 'INVALID_CODEX_HOME_PATH'
}

export class PersistentCodexHomeManager {
  readonly #root: string
  readonly #provisioningSource: string | undefined

  constructor(root: string, options: { provisioningSource?: string } = {}) {
    if (!root || root.includes('\0'))
      throw new CodexHomePathError('Invalid root')
    mkdirSync(resolve(root), { recursive: true, mode: 0o700 })
    this.#root = realpathSync(resolve(root))
    chmodSync(this.#root, 0o700)
    this.#provisioningSource = options.provisioningSource
      ? realpathSync(resolve(options.provisioningSource))
      : undefined
  }

  homeFor(tenantId: string, workspaceId: string): string {
    if (!tenantId || !workspaceId)
      throw new CodexHomePathError('Identity required')
    const digest = createHash('sha256')
      .update(JSON.stringify([tenantId, workspaceId]))
      .digest('hex')
    const parent = join(this.#root, digest.slice(0, 2))
    const home = join(parent, digest.slice(2))
    this.#ensureDirectory(parent)
    this.#ensureDirectory(home)
    const canonical = realpathSync(home)
    const rel = relative(this.#root, canonical)
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      resolve(canonical) === resolve('/proc') ||
      resolve(canonical) === resolve('/sys')
    ) {
      throw new CodexHomePathError('Codex home escaped its server-owned root')
    }
    this.#provision(canonical)
    return canonical
  }

  #provision(home: string): void {
    if (!this.#provisioningSource) return
    for (const filename of ['auth.json', 'config.toml'] as const) {
      const source = join(this.#provisioningSource, filename)
      const target = join(home, filename)
      if (!existsSync(source)) {
        if (existsSync(target)) {
          if (!lstatSync(target).isSymbolicLink())
            throw new CodexHomePathError(`Provisioned ${filename} was replaced`)
          unlinkSync(target)
        }
        continue
      }
      const sourceStat = lstatSync(source)
      if (!sourceStat.isFile() && !sourceStat.isSymbolicLink())
        throw new CodexHomePathError(
          `Provisioning source ${filename} is unsafe`,
        )
      const canonicalSource = realpathSync(source)
      const sourceRelative = relative(this.#provisioningSource, canonicalSource)
      if (
        sourceRelative === '..' ||
        sourceRelative.startsWith(`..${sep}`) ||
        canonicalSource.startsWith(`/proc${sep}`) ||
        canonicalSource.startsWith(`/sys${sep}`)
      )
        throw new CodexHomePathError(
          `Provisioning source ${filename} escaped its root`,
        )
      if (existsSync(target)) {
        const targetStat = lstatSync(target)
        if (
          !targetStat.isSymbolicLink() ||
          realpathSync(target) !== canonicalSource ||
          resolve(home, readlinkSync(target)) === home
        )
          throw new CodexHomePathError(`Provisioned ${filename} was replaced`)
        continue
      }
      symlinkSync(canonicalSource, target, 'file')
    }
  }

  #ensureDirectory(path: string): void {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new CodexHomePathError(
          'Codex home contains an unsafe path component',
        )
    } catch (error) {
      if (error instanceof CodexHomePathError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      mkdirSync(path, { mode: 0o700 })
    }
    chmodSync(path, 0o700)
  }
}
