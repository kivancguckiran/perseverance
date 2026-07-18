import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeterministicIgnorePolicy,
  WorkspaceCorpusWatcher,
} from './workspace-corpus-watcher'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function watcher(maxBacklog = 8) {
  const root = mkdtempSync(join(tmpdir(), 'wp22-watcher-'))
  roots.push(root)
  return new WorkspaceCorpusWatcher({
    root,
    scope: {
      tenantId: 'tenant_a',
      organizationId: 'tenant_a',
      workspaceId: 'workspace_a',
    },
    ignorePolicy: new DeterministicIgnorePolicy({
      gitignore: 'dist/\n*.log',
      codexignore: 'private/**',
      indexIgnore: 'generated/**\n!generated/keep.md',
    }),
    debounceMs: 20,
    maxBacklog,
  })
}

describe('WP22 deterministic workspace watcher', () => {
  it('debounces and idempotently emits create/update/rename/delete jobs', () => {
    const value = watcher()
    value.enqueue(
      {
        operation: 'create',
        path: 'docs/a.md',
        observedAt: '2026-07-18T00:00:00.000Z',
      },
      0,
    )
    value.enqueue(
      {
        operation: 'update',
        path: 'docs/a.md',
        contentHash: 'sha256:new',
        observedAt: '2026-07-18T00:00:01.000Z',
      },
      1,
    )
    value.enqueue(
      {
        operation: 'rename',
        previousPath: 'docs/b.md',
        path: 'docs/c.md',
        observedAt: '2026-07-18T00:00:02.000Z',
      },
      2,
    )
    value.enqueue(
      {
        operation: 'delete',
        path: 'docs/d.md',
        observedAt: '2026-07-18T00:00:03.000Z',
      },
      3,
    )
    const jobs = value.flush(30)
    expect(jobs.map((job) => job.operation)).toEqual([
      'create',
      'rename',
      'delete',
    ])
    expect(new Set(jobs.map((job) => job.idempotencyKey)).size).toBe(3)
    expect(value.flush(30)).toEqual([])
  })

  it('applies all ignore sources in deterministic order and maps rename across ignore boundary', () => {
    const value = watcher()
    expect(
      value.enqueue(
        {
          operation: 'create',
          path: 'dist/a.js',
          observedAt: '2026-07-18T00:00:00.000Z',
        },
        0,
      ),
    ).toBe(false)
    expect(
      value.enqueue(
        {
          operation: 'create',
          path: 'private/a.md',
          observedAt: '2026-07-18T00:00:00.000Z',
        },
        0,
      ),
    ).toBe(false)
    expect(
      value.enqueue(
        {
          operation: 'create',
          path: 'generated/keep.md',
          observedAt: '2026-07-18T00:00:00.000Z',
        },
        0,
      ),
    ).toBe(true)
    value.enqueue(
      {
        operation: 'rename',
        previousPath: 'docs/live.md',
        path: 'dist/live.md',
        observedAt: '2026-07-18T00:00:01.000Z',
      },
      0,
    )
    expect(value.flush(30).map((job) => [job.operation, job.path])).toEqual([
      ['delete', 'docs/live.md'],
      ['create', 'generated/keep.md'],
    ])
  })

  it('fails with bounded backpressure and rejects workspace escape', () => {
    const value = watcher(1)
    value.enqueue(
      {
        operation: 'create',
        path: 'a.md',
        observedAt: '2026-07-18T00:00:00.000Z',
      },
      0,
    )
    expect(() =>
      value.enqueue(
        {
          operation: 'create',
          path: 'b.md',
          observedAt: '2026-07-18T00:00:00.000Z',
        },
        0,
      ),
    ).toThrowError(/backlog/i)
    expect(() =>
      value.enqueue(
        {
          operation: 'create',
          path: '../escape.md',
          observedAt: '2026-07-18T00:00:00.000Z',
        },
        0,
      ),
    ).toThrowError(/escapes workspace/i)
  })
})
