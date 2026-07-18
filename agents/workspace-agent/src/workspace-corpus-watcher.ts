import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const WORKSPACE_CORPUS_WATCHER_VERSION = 1 as const

export type WorkspaceFileOperation = 'create' | 'update' | 'rename' | 'delete'

export interface WorkspaceFileEvent {
  operation: WorkspaceFileOperation
  path: string
  previousPath?: string
  contentHash?: string
  observedAt: string
}

export interface WorkspaceWatchJob extends WorkspaceFileEvent {
  version: typeof WORKSPACE_CORPUS_WATCHER_VERSION
  idempotencyKey: string
}

export class WorkspaceWatcherError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceWatcherError'
    this.code = code
  }
}

interface IgnoreRule {
  negated: boolean
  directoryOnly: boolean
  expression: RegExp
}

function globExpression(pattern: string) {
  let result = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        result += '.*'
        index++
      } else result += '[^/]*'
    } else if (character === '?') result += '[^/]'
    else result += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return result
}

function compileIgnore(text: string) {
  if (Buffer.byteLength(text) > 256 * 1024)
    throw new WorkspaceWatcherError(
      'IGNORE_FILE_TOO_LARGE',
      'Ignore policy exceeds byte limit',
    )
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const negated = trimmed.startsWith('!')
    const value = negated ? trimmed.slice(1) : trimmed
    if (!value || value.includes('\0') || value.split('/').includes('..'))
      throw new WorkspaceWatcherError(
        'INVALID_IGNORE_RULE',
        'Ignore policy contains an unsafe rule',
      )
    const directoryOnly = value.endsWith('/')
    const normalized = value.replace(/^\//, '').replace(/\/$/, '')
    const anchored = value.startsWith('/')
    const prefix = anchored ? '^' : '(^|/)'
    const suffix = directoryOnly ? '(/|$)' : '$'
    rules.push({
      negated,
      directoryOnly,
      expression: new RegExp(`${prefix}${globExpression(normalized)}${suffix}`),
    })
  }
  return rules
}

export class DeterministicIgnorePolicy {
  readonly #rules: IgnoreRule[]

  constructor(input: {
    gitignore?: string
    codexignore?: string
    indexIgnore?: string
  }) {
    const defaults =
      '.git/\nnode_modules/\n.runtime/\n.env\n.env.*\n.gitignore\n.codexignore\nindex.ignore\n'
    this.#rules = [
      ...compileIgnore(defaults),
      ...compileIgnore(input.gitignore ?? ''),
      ...compileIgnore(input.codexignore ?? ''),
      ...compileIgnore(input.indexIgnore ?? ''),
    ]
  }

  ignores(path: string, isDirectory = false) {
    let ignored = false
    for (const rule of this.#rules) {
      if (rule.directoryOnly && !isDirectory && !path.includes('/')) continue
      if (rule.expression.test(path)) ignored = !rule.negated
    }
    return ignored
  }
}

function readIgnore(root: string, name: string) {
  const path = resolve(root, name)
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new WorkspaceWatcherError(
        'UNSAFE_IGNORE_FILE',
        'Ignore file must be a regular file',
      )
    if (stat.size > 256 * 1024)
      throw new WorkspaceWatcherError(
        'IGNORE_FILE_TOO_LARGE',
        'Ignore policy exceeds byte limit',
      )
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export function loadWorkspaceIgnorePolicy(rootInput: string) {
  const root = realpathSync(rootInput)
  return new DeterministicIgnorePolicy({
    gitignore: readIgnore(root, '.gitignore'),
    codexignore: readIgnore(root, '.codexignore'),
    indexIgnore: readIgnore(root, 'index.ignore'),
  })
}

export class WorkspaceCorpusWatcher {
  readonly version = WORKSPACE_CORPUS_WATCHER_VERSION
  readonly #root: string
  readonly #scopeKey: string
  readonly #policy: DeterministicIgnorePolicy
  readonly #debounceMs: number
  readonly #maxBacklog: number
  readonly #pending = new Map<
    string,
    { event: WorkspaceFileEvent; dueAt: number }
  >()
  readonly #emitted = new Set<string>()
  readonly #emittedOrder: string[] = []

  constructor(input: {
    root: string
    scope: { tenantId: string; organizationId: string; workspaceId: string }
    ignorePolicy?: DeterministicIgnorePolicy
    debounceMs?: number
    maxBacklog?: number
  }) {
    this.#root = realpathSync(input.root)
    this.#scopeKey = JSON.stringify([
      input.scope.tenantId,
      input.scope.organizationId,
      input.scope.workspaceId,
    ])
    this.#policy = input.ignorePolicy ?? loadWorkspaceIgnorePolicy(this.#root)
    this.#debounceMs = input.debounceMs ?? 250
    this.#maxBacklog = input.maxBacklog ?? 1_024
    if (this.#debounceMs < 10 || this.#debounceMs > 60_000)
      throw new WorkspaceWatcherError(
        'INVALID_DEBOUNCE',
        'Watcher debounce is out of bounds',
      )
    if (this.#maxBacklog < 1 || this.#maxBacklog > 100_000)
      throw new WorkspaceWatcherError(
        'INVALID_BACKLOG',
        'Watcher backlog is out of bounds',
      )
  }

  get backlogSize() {
    return this.#pending.size
  }

  #relative(pathInput: string) {
    const absolute = isAbsolute(pathInput)
      ? resolve(pathInput)
      : resolve(this.#root, pathInput)
    const path = relative(this.#root, absolute)
    if (
      !path ||
      path === '..' ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path)
    )
      throw new WorkspaceWatcherError(
        'WATCH_PATH_ESCAPE',
        'Watcher path escapes workspace',
      )
    return path.split(sep).join('/')
  }

  enqueue(event: WorkspaceFileEvent, now = Date.now()) {
    let path = this.#relative(event.path)
    const previousPath = event.previousPath
      ? this.#relative(event.previousPath)
      : undefined
    let operation = event.operation
    const ignored = this.#policy.ignores(path)
    const previousIgnored = previousPath
      ? this.#policy.ignores(previousPath)
      : false
    if (operation === 'rename' && previousIgnored && !ignored)
      operation = 'create'
    else if (operation === 'rename' && !previousIgnored && ignored) {
      operation = 'delete'
      path = previousPath!
    } else if (ignored) return false
    const key = operation === 'rename' ? `${previousPath}\0${path}` : path
    if (!this.#pending.has(key) && this.#pending.size >= this.#maxBacklog)
      throw new WorkspaceWatcherError(
        'WATCH_BACKPRESSURE',
        'Watcher backlog is full',
      )
    const previous = this.#pending.get(key)?.event
    const collapsed: WorkspaceFileEvent = {
      ...event,
      operation:
        previous?.operation === 'create' && operation === 'update'
          ? 'create'
          : operation,
      path,
      ...(previousPath ? { previousPath } : {}),
    }
    this.#pending.set(key, { event: collapsed, dueAt: now + this.#debounceMs })
    return true
  }

  flush(now = Date.now()) {
    const ready = [...this.#pending.entries()]
      .filter(([, pending]) => pending.dueAt <= now)
      .sort(([left], [right]) => left.localeCompare(right))
    const jobs: WorkspaceWatchJob[] = []
    for (const [key, pending] of ready) {
      this.#pending.delete(key)
      const idempotencyKey = `watch:${createHash('sha256')
        .update(
          JSON.stringify([
            this.#scopeKey,
            pending.event.operation,
            pending.event.previousPath ?? null,
            pending.event.path,
            pending.event.contentHash ?? null,
          ]),
        )
        .digest('hex')}`
      if (this.#emitted.has(idempotencyKey)) continue
      this.#emitted.add(idempotencyKey)
      this.#emittedOrder.push(idempotencyKey)
      while (this.#emittedOrder.length > this.#maxBacklog * 4) {
        const expired = this.#emittedOrder.shift()
        if (expired) this.#emitted.delete(expired)
      }
      jobs.push({ version: 1, ...pending.event, idempotencyKey })
    }
    return jobs
  }
}
