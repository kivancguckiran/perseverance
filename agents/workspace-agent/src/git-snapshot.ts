import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const GIT_DIFF_PREVIEW_BYTES = 64 * 1024
export const GIT_DIFF_OUTPUT_BYTES = 8 * 1024 * 1024
export const GIT_COMMAND_TIMEOUT_MS = 5_000

export type GitRepositoryKind = 'repository' | 'worktree' | 'submodule' | 'none'
export type GitChangeArea = 'staged' | 'unstaged' | 'untracked'

export interface GitChange {
  path: string
  previousPath: string | null
  areas: GitChangeArea[]
  stagedStatus: string | null
  unstagedStatus: string | null
  renamed: boolean
  binary: boolean
  submodule: boolean
}

export interface GitLogEntry {
  oid: string
  shortOid: string
  authoredAt: string
  authorName: string
  subject: string
}

export interface GitSnapshotResult {
  repositoryKind: GitRepositoryKind
  branch: string | null
  headOid: string | null
  detached: boolean
  clean: boolean
  changes: GitChange[]
  diff: {
    preview: string
    byteLength: number
    truncated: boolean
    /** Transient handoff only. Never serialize this field into an API response. */
    content?: string
  }
  log: GitLogEntry[]
  capturedAt: string
}

class GitCommandError extends Error {
  readonly code: 'NOT_REPOSITORY' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'FAILED'

  constructor(
    code: 'NOT_REPOSITORY' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'FAILED',
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

function utf8Tail(value: string, limit: number): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= limit) return value
  let start = bytes.length - limit
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

function parseStatus(value: string): GitChange[] {
  const fields = value.split('\0')
  const changes: GitChange[] = []
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index]
    if (!line || line.startsWith('# ')) continue
    if (line.startsWith('? ')) {
      changes.push({
        path: line.slice(2),
        previousPath: null,
        areas: ['untracked'],
        stagedStatus: null,
        unstagedStatus: null,
        renamed: false,
        binary: false,
        submodule: false,
      })
      continue
    }
    if (!line.startsWith('1 ') && !line.startsWith('2 ')) continue
    const tokens = line.split(' ')
    const xy = tokens[1] ?? '..'
    const sub = tokens[2] ?? 'N...'
    const pathToken = line.startsWith('2 ')
      ? tokens.slice(9).join(' ')
      : tokens.slice(8).join(' ')
    const renamed = line.startsWith('2 ')
    const previousPath = renamed ? (fields[++index] ?? null) : null
    const areas: GitChangeArea[] = []
    if (xy[0] !== '.') areas.push('staged')
    if (xy[1] !== '.') areas.push('unstaged')
    changes.push({
      path: pathToken,
      previousPath,
      areas,
      stagedStatus: xy[0] === '.' ? null : xy[0]!,
      unstagedStatus: xy[1] === '.' ? null : xy[1]!,
      renamed,
      binary: false,
      submodule: sub !== 'N...',
    })
  }
  return changes
}

function markBinary(changes: GitChange[], numstat: string): void {
  const binaryPaths = new Set<string>()
  for (const record of numstat.split('\0')) {
    const match = /^-\t-\t(.+)$/.exec(record)
    if (match) binaryPaths.add(match[1]!)
  }
  for (const change of changes)
    change.binary =
      binaryPaths.has(change.path) ||
      (change.previousPath !== null && binaryPaths.has(change.previousPath))
}

function parseLog(value: string): GitLogEntry[] {
  return value
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [oid, shortOid, authoredAt, authorName, subject] =
        record.split('\x1f')
      return {
        oid: oid ?? '',
        shortOid: shortOid ?? '',
        authoredAt: authoredAt ?? '',
        authorName: authorName ?? '',
        subject: subject ?? '',
      }
    })
}

export class GitSnapshotReader {
  readonly #cwd: string

  constructor(serverOwnedWorkspace: string) {
    const configured = resolve(serverOwnedWorkspace)
    const stat = lstatSync(configured)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Workspace must be a canonical server-owned directory')
    const canonical = realpathSync(configured)
    this.#cwd = canonical
  }

  async #run(
    args: readonly string[],
    maxBuffer = 1024 * 1024,
  ): Promise<string> {
    try {
      const result = await execFileAsync('git', [...args], {
        cwd: this.#cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      })
      return result.stdout
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException & {
        killed?: boolean
        stderr?: string
      }
      if (error.killed)
        throw new GitCommandError('TIMEOUT', 'Git command timed out')
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new GitCommandError(
          'OUTPUT_LIMIT',
          'Git output exceeded its limit',
        )
      if (error.stderr?.includes('not a git repository'))
        throw new GitCommandError(
          'NOT_REPOSITORY',
          'Workspace is not a Git repository',
        )
      throw new GitCommandError('FAILED', 'Read-only Git command failed')
    }
  }

  async capture(now = new Date()): Promise<GitSnapshotResult> {
    try {
      await this.#run(['rev-parse', '--is-inside-work-tree'])
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'NOT_REPOSITORY')
        return {
          repositoryKind: 'none',
          branch: null,
          headOid: null,
          detached: false,
          clean: true,
          changes: [],
          diff: { preview: '', byteLength: 0, truncated: false },
          log: [],
          capturedAt: now.toISOString(),
        }
      throw error
    }

    const [topLevel, gitDir, superproject, status, branch, head] =
      await Promise.all([
        this.#run(['rev-parse', '--show-toplevel']),
        this.#run(['rev-parse', '--absolute-git-dir']),
        this.#run(['rev-parse', '--show-superproject-working-tree']),
        this.#run(['status', '--porcelain=v2', '-z', '--untracked-files=all']),
        this.#run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(
          () => '',
        ),
        this.#run(['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      ])
    const comparison = head.trim() ? ['HEAD', '--'] : ['--cached', '--']
    const [diff, numstat, log] = await Promise.all([
      this.#run(
        ['diff', '--binary', '--no-ext-diff', '--no-color', ...comparison],
        GIT_DIFF_OUTPUT_BYTES,
      ).catch((error) => {
        if (error instanceof GitCommandError && error.code === 'FAILED')
          return ''
        throw error
      }),
      this.#run(['diff', '--numstat', '-z', ...comparison]).catch(() => ''),
      this.#run([
        'log',
        '-n',
        '20',
        '--date=iso-strict',
        '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1e',
      ]).catch(() => ''),
    ])
    const changes = parseStatus(status)
    markBinary(changes, numstat)
    const bytes = Buffer.byteLength(diff)
    const canonicalTop = realpathSync(topLevel.trim())
    const isSubmodule = Boolean(superproject.trim())
    const isWorktree =
      !isSubmodule && !gitDir.trim().endsWith(`/${basename(canonicalTop)}/.git`)
    return {
      repositoryKind: isSubmodule
        ? 'submodule'
        : isWorktree
          ? 'worktree'
          : 'repository',
      branch: branch.trim() || null,
      headOid: head.trim() || null,
      detached: !branch.trim() && Boolean(head.trim()),
      clean: changes.length === 0,
      changes,
      diff: {
        preview: utf8Tail(diff, GIT_DIFF_PREVIEW_BYTES),
        byteLength: bytes,
        truncated: bytes > GIT_DIFF_PREVIEW_BYTES,
        ...(bytes > GIT_DIFF_PREVIEW_BYTES ? { content: diff } : {}),
      },
      log: parseLog(log),
      capturedAt: now.toISOString(),
    }
  }
}
