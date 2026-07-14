import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const linkedConfigurationFiles = ['auth.json', 'config.toml'] as const

export interface IsolatedCodexHome {
  path: string
  sourceHome: string
  linkedFiles: string[]
  cleanup(): void
}

/** Creates a disposable real-smoke home without linking task/session state. */
export function createIsolatedCodexHome(
  options: {
    sourceHome?: string
    temporaryRoot?: string
  } = {},
): IsolatedCodexHome {
  const sourceHome = resolve(
    options.sourceHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  )
  const temporaryRoot = resolve(options.temporaryRoot ?? tmpdir())
  const path = mkdtempSync(join(temporaryRoot, 'persistent-codex-smoke-'))
  const linkedFiles: string[] = []
  try {
    for (const filename of linkedConfigurationFiles) {
      const source = join(sourceHome, filename)
      if (!existsSync(source)) continue
      const stat = lstatSync(source)
      if (!stat.isFile() && !stat.isSymbolicLink()) continue
      symlinkSync(source, join(path, filename), 'file')
      linkedFiles.push(filename)
    }
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  let cleaned = false
  return {
    path,
    sourceHome,
    linkedFiles,
    cleanup() {
      if (cleaned) return
      cleaned = true
      if (
        resolve(path).startsWith(`${temporaryRoot}/`) &&
        basename(path).startsWith('persistent-codex-smoke-')
      ) {
        rmSync(path, { recursive: true, force: true })
      }
    },
  }
}
