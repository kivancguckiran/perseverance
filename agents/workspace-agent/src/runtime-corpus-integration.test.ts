import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkspaceCorpusRuntimeServices,
  type RuntimeCorpusCredentialPort,
  type RuntimeCorpusWatchSink,
} from './runtime-corpus-integration'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('runtime corpus integration timed out')
}

describe('workspace corpus runtime integration', () => {
  it('manages config, rotates credentials and consumes real filesystem lifecycle events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-corpus-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const home = join(root, 'home')
    const source = join(root, 'source')
    mkdirSync(workspace)
    mkdirSync(home)
    mkdirSync(source)
    writeFileSync(join(source, 'config.toml'), 'model = "fixture"\n')
    symlinkSync(join(source, 'config.toml'), join(home, 'config.toml'))
    writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(workspace, 'initial.md'), 'initial')
    writeFileSync(join(workspace, 'ignored.txt'), 'ignored')
    symlinkSync(join(source, 'config.toml'), join(workspace, 'escape.md'))
    const issued: string[] = []
    const revoked: string[] = []
    const credentialPort: RuntimeCorpusCredentialPort = {
      issue({ processGeneration }) {
        const credentialId = `credential-${processGeneration}`
        issued.push(credentialId)
        return {
          credentialId,
          accessToken: `token-${processGeneration}`,
          proofKey: `proof-${processGeneration}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      },
      revoke(id) {
        revoked.push(id)
      },
    }
    const jobs: string[] = []
    const watchSink: RuntimeCorpusWatchSink = {
      async persistAndApply(input) {
        jobs.push(...input.jobs.map((job) => `${job.operation}:${job.path}`))
      },
    }
    const runtime = new WorkspaceCorpusRuntimeServices({
      identity: {
        tenantId: 'tenant-a',
        organizationId: 'tenant-a',
        workspaceId: 'workspace-a',
        cwd: workspace,
        codexHome: home,
      },
      credentialPort,
      watchSink,
      endpoint: 'http://127.0.0.1:3999',
      mcpCommand: process.execPath,
      mcpArgs: ['mcp.js'],
      mcpCwd: root,
      scanIntervalMs: 30,
    })
    try {
      await runtime.start()
      expect(readFileSync(join(source, 'config.toml'), 'utf8')).toBe(
        'model = "fixture"\n',
      )
      const managed = readFileSync(join(home, 'config.toml'), 'utf8')
      expect(managed).toContain('required = true')
      expect(managed).not.toContain('token-')
      expect(jobs).toContain('create:initial.md')
      expect(jobs.some((job) => job.includes('ignored.txt'))).toBe(false)
      expect(jobs.some((job) => job.includes('escape.md'))).toBe(false)
      const firstEnv = await runtime.prepareLaunch({ processGeneration: 1 })
      const secondEnv = await runtime.prepareLaunch({ processGeneration: 2 })
      expect(firstEnv?.CORPUS_WORKLOAD_ACCESS_TOKEN).toBe('token-1')
      expect(secondEnv?.CORPUS_WORKLOAD_ACCESS_TOKEN).toBe('token-2')
      expect(revoked).toContain('credential-1')
      writeFileSync(join(workspace, 'initial.md'), 'updated')
      await waitFor(() => jobs.includes('update:initial.md'))
      renameSync(join(workspace, 'initial.md'), join(workspace, 'renamed.md'))
      await waitFor(() => jobs.includes('rename:renamed.md'))
      rmSync(join(workspace, 'renamed.md'))
      await waitFor(() => jobs.includes('delete:renamed.md'))
    } finally {
      await runtime.stop()
    }
    expect(revoked).toContain('credential-2')
    expect(existsSync(join(home, 'config.toml'))).toBe(true)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(
      'model = "fixture"\n',
    )
    rmSync(join(home, 'config.toml'))
    writeFileSync(
      join(home, 'config.toml'),
      'model = "fixture"\n# persistent-codex managed workspace corpus MCP v1\n[stale]\n',
    )
    const restarted = new WorkspaceCorpusRuntimeServices({
      identity: {
        tenantId: 'tenant-a',
        organizationId: 'tenant-a',
        workspaceId: 'workspace-a',
        cwd: workspace,
        codexHome: home,
      },
      credentialPort,
      watchSink,
      endpoint: 'http://127.0.0.1:3999',
      mcpCommand: process.execPath,
      mcpArgs: ['mcp.js'],
      mcpCwd: root,
      scanIntervalMs: 30,
    })
    await restarted.start()
    expect(
      readFileSync(join(home, 'config.toml'), 'utf8').match(
        /persistent-codex managed workspace corpus MCP v1/g,
      ),
    ).toHaveLength(1)
    await restarted.stop()
  })
})
