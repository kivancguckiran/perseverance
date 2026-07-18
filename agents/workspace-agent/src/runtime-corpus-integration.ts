import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  WorkspaceCorpusWatcher,
  DeterministicIgnorePolicy,
  loadWorkspaceIgnorePolicy,
  type WorkspaceWatchJob,
} from './workspace-corpus-watcher'
import type {
  WorkspaceRuntimeIdentity,
  WorkspaceRuntimeServices,
} from './index'

export const WORKSPACE_CORPUS_RUNTIME_VERSION = 1 as const

export interface RuntimeCorpusCredential {
  accessToken: string
  proofKey: string
  credentialId: string
  expiresAt: string
}

export interface RuntimeCorpusCredentialPort {
  issue(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    processGeneration: number
  }): Promise<RuntimeCorpusCredential> | RuntimeCorpusCredential
  revoke(credentialId: string): Promise<void> | void
}

export interface RuntimeCorpusWatchSink {
  persistAndApply(input: {
    scope: { tenantId: string; organizationId: string; workspaceId: string }
    root: string
    jobs: WorkspaceWatchJob[]
  }): Promise<void>
}

export class WorkspaceCorpusRuntimeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceCorpusRuntimeError'
    this.code = code
  }
}

interface FileState {
  hash: string
  size: number
}

class ManagedCorpusMcpConfig {
  static readonly marker = '# persistent-codex managed workspace corpus MCP v1'
  readonly #home: string
  readonly #configPath: string
  readonly #command: string
  readonly #args: string[]
  readonly #cwd: string
  #originalTarget: string | undefined
  #installed = false

  constructor(input: {
    codexHome: string
    command: string
    args: string[]
    cwd: string
  }) {
    this.#home = realpathSync(input.codexHome)
    this.#configPath = join(this.#home, 'config.toml')
    this.#command = input.command
    this.#args = [...input.args]
    this.#cwd = input.cwd
  }

  install() {
    if (this.#installed) return
    let base = ''
    if (existsSync(this.#configPath)) {
      const stat = lstatSync(this.#configPath)
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new WorkspaceCorpusRuntimeError(
          'CORPUS_MCP_CONFIG_UNSAFE',
          'Managed corpus MCP configuration path is unsafe',
        )
      if (stat.isSymbolicLink())
        this.#originalTarget = realpathSync(this.#configPath)
      base = readFileSync(this.#configPath, 'utf8')
      const previousManaged = base.indexOf(ManagedCorpusMcpConfig.marker)
      if (previousManaged >= 0) base = base.slice(0, previousManaged)
      unlinkSync(this.#configPath)
    }
    const managed = [
      base.trimEnd(),
      '',
      ManagedCorpusMcpConfig.marker,
      '[mcp_servers.workspace_corpus]',
      'enabled = true',
      'required = true',
      `command = ${JSON.stringify(this.#command)}`,
      `args = ${JSON.stringify(this.#args)}`,
      `cwd = ${JSON.stringify(this.#cwd)}`,
      'env_vars = ["CORPUS_RETRIEVAL_ENDPOINT", "CORPUS_WORKLOAD_TENANT_ID", "CORPUS_WORKLOAD_ORGANIZATION_ID", "CORPUS_WORKLOAD_WORKSPACE_ID", "CORPUS_WORKLOAD_ACCESS_TOKEN", "CORPUS_WORKLOAD_PROOF_KEY"]',
      'startup_timeout_sec = 15',
      'tool_timeout_sec = 15',
      'enabled_tools = ["search_corpus", "get_citation"]',
      '',
    ].join('\n')
    const temporary = `${this.#configPath}.managed.tmp`
    writeFileSync(temporary, managed, { mode: 0o600 })
    renameSync(temporary, this.#configPath)
    chmodSync(this.#configPath, 0o600)
    this.#installed = true
  }

  cleanup() {
    if (!this.#installed) return
    if (existsSync(this.#configPath)) rmSync(this.#configPath)
    if (this.#originalTarget)
      symlinkSync(this.#originalTarget, this.#configPath, 'file')
    this.#installed = false
  }
}

export class WorkspaceCorpusRuntimeServices implements WorkspaceRuntimeServices {
  readonly version = WORKSPACE_CORPUS_RUNTIME_VERSION
  readonly #identity: WorkspaceRuntimeIdentity
  readonly #scope: {
    tenantId: string
    organizationId: string
    workspaceId: string
  }
  readonly #root: string
  readonly #credentialPort: RuntimeCorpusCredentialPort
  readonly #watchSink: RuntimeCorpusWatchSink
  readonly #endpoint: string
  readonly #config: ManagedCorpusMcpConfig
  readonly #watcher: WorkspaceCorpusWatcher
  readonly #ignorePolicy: DeterministicIgnorePolicy
  readonly #scanIntervalMs: number
  readonly #maxFiles: number
  readonly #maxBytes: number
  #fsWatcher: FSWatcher | undefined
  #scanTimer: ReturnType<typeof setInterval> | undefined
  #scanInFlight: Promise<void> = Promise.resolve()
  #state = new Map<string, FileState>()
  #credential: RuntimeCorpusCredential | undefined
  #stopped = false

  constructor(input: {
    identity: WorkspaceRuntimeIdentity
    credentialPort: RuntimeCorpusCredentialPort
    watchSink: RuntimeCorpusWatchSink
    endpoint: string
    mcpCommand: string
    mcpArgs: string[]
    mcpCwd: string
    scanIntervalMs?: number
    maxFiles?: number
    maxBytes?: number
  }) {
    if (!input.identity.codexHome)
      throw new WorkspaceCorpusRuntimeError(
        'CORPUS_MCP_HOME_REQUIRED',
        'Workspace corpus MCP requires a managed Codex home',
      )
    this.#identity = input.identity
    this.#scope = {
      tenantId: input.identity.tenantId,
      organizationId: input.identity.organizationId ?? input.identity.tenantId,
      workspaceId: input.identity.workspaceId,
    }
    this.#root = realpathSync(input.identity.cwd)
    this.#credentialPort = input.credentialPort
    this.#watchSink = input.watchSink
    this.#endpoint = new URL(input.endpoint).toString()
    this.#config = new ManagedCorpusMcpConfig({
      codexHome: input.identity.codexHome,
      command: input.mcpCommand,
      args: input.mcpArgs,
      cwd: input.mcpCwd,
    })
    this.#ignorePolicy = loadWorkspaceIgnorePolicy(this.#root)
    this.#watcher = new WorkspaceCorpusWatcher({
      root: this.#root,
      scope: this.#scope,
      ignorePolicy: this.#ignorePolicy,
      debounceMs: 50,
      maxBacklog: 2_048,
    })
    this.#scanIntervalMs = input.scanIntervalMs ?? 250
    this.#maxFiles = input.maxFiles ?? 20_000
    this.#maxBytes = input.maxBytes ?? 16 * 1024 * 1024
  }

  async start() {
    this.#config.install()
    await this.#reconcile(true)
    try {
      this.#fsWatcher = watch(this.#root, () => this.#scheduleScan())
      this.#fsWatcher.on('error', () => {
        this.#fsWatcher?.close()
        this.#fsWatcher = undefined
      })
    } catch (error) {
      this.#config.cleanup()
      throw new WorkspaceCorpusRuntimeError(
        'CORPUS_WATCHER_UNAVAILABLE',
        error instanceof Error
          ? error.message
          : 'Workspace watcher unavailable',
      )
    }
    this.#scanTimer = setInterval(
      () => this.#scheduleScan(),
      this.#scanIntervalMs,
    )
    this.#scanTimer.unref()
  }

  async prepareLaunch(input: { processGeneration: number }) {
    if (this.#stopped)
      throw new WorkspaceCorpusRuntimeError(
        'CORPUS_MCP_UNAVAILABLE',
        'Workspace corpus MCP runtime is stopped',
      )
    if (this.#credential)
      await this.#credentialPort.revoke(this.#credential.credentialId)
    const credential = await this.#credentialPort.issue({
      ...this.#scope,
      processGeneration: input.processGeneration,
    })
    this.#credential = credential
    return {
      ...process.env,
      ...(this.#identity.codexHome
        ? { CODEX_HOME: this.#identity.codexHome }
        : {}),
      CORPUS_RETRIEVAL_ENDPOINT: this.#endpoint,
      CORPUS_WORKLOAD_TENANT_ID: this.#scope.tenantId,
      CORPUS_WORKLOAD_ORGANIZATION_ID: this.#scope.organizationId,
      CORPUS_WORKLOAD_WORKSPACE_ID: this.#scope.workspaceId,
      CORPUS_WORKLOAD_ACCESS_TOKEN: credential.accessToken,
      CORPUS_WORKLOAD_PROOF_KEY: credential.proofKey,
    }
  }

  async stop() {
    if (this.#stopped) return
    this.#stopped = true
    this.#fsWatcher?.close()
    if (this.#scanTimer) clearInterval(this.#scanTimer)
    await this.#scanInFlight.catch(() => undefined)
    if (this.#credential)
      await this.#credentialPort.revoke(this.#credential.credentialId)
    this.#credential = undefined
    this.#config.cleanup()
  }

  #scheduleScan() {
    this.#scanInFlight = this.#scanInFlight
      .catch(() => undefined)
      .then(() => this.#reconcile(false))
  }

  #snapshot() {
    const result = new Map<string, FileState>()
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name)
        const relativePath = relative(this.#root, absolute).split(sep).join('/')
        if (this.#watcherIgnores(relativePath, entry.isDirectory())) continue
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          visit(absolute)
          continue
        }
        if (!stat.isFile() || stat.size > this.#maxBytes) continue
        const canonical = realpathSync(absolute)
        const rel = relative(this.#root, canonical)
        if (rel === '..' || rel.startsWith(`..${sep}`)) continue
        if (result.size >= this.#maxFiles)
          throw new WorkspaceCorpusRuntimeError(
            'CORPUS_WATCHER_BACKPRESSURE',
            'Workspace corpus file limit was reached',
          )
        result.set(relativePath, {
          hash: `sha256:${createHash('sha256').update(readFileSync(canonical)).digest('hex')}`,
          size: stat.size,
        })
      }
    }
    visit(this.#root)
    return result
  }

  #watcherIgnores(path: string, isDirectory: boolean) {
    return this.#ignorePolicy.ignores(path, isDirectory)
  }

  async #reconcile(startup: boolean) {
    const next = this.#snapshot()
    const deleted = [...this.#state.entries()].filter(
      ([path]) => !next.has(path),
    )
    const created = [...next.entries()].filter(
      ([path]) => !this.#state.has(path),
    )
    const consumedCreated = new Set<string>()
    for (const [oldPath, oldState] of deleted) {
      const renamed = created.find(
        ([newPath, newState]) =>
          !consumedCreated.has(newPath) && newState.hash === oldState.hash,
      )
      if (renamed) {
        consumedCreated.add(renamed[0])
        this.#watcher.enqueue(
          {
            operation: 'rename',
            path: renamed[0],
            previousPath: oldPath,
            contentHash: renamed[1].hash,
            observedAt: new Date().toISOString(),
          },
          0,
        )
      } else {
        this.#watcher.enqueue(
          {
            operation: 'delete',
            path: oldPath,
            observedAt: new Date().toISOString(),
          },
          0,
        )
      }
    }
    for (const [path, state] of created) {
      if (consumedCreated.has(path)) continue
      this.#watcher.enqueue(
        {
          operation: 'create',
          path,
          contentHash: state.hash,
          observedAt: new Date().toISOString(),
        },
        0,
      )
    }
    for (const [path, state] of next) {
      const previous = this.#state.get(path)
      if (previous && previous.hash !== state.hash)
        this.#watcher.enqueue(
          {
            operation: 'update',
            path,
            contentHash: state.hash,
            observedAt: new Date().toISOString(),
          },
          0,
        )
    }
    this.#state = next
    const jobs = this.#watcher.flush(Number.MAX_SAFE_INTEGER)
    await this.#watchSink.persistAndApply({
      scope: this.#scope,
      root: this.#root,
      jobs,
    })
    if (startup && jobs.length === 0) return
  }
}
