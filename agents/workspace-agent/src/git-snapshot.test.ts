import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitSnapshotReader } from './git-snapshot'

const roots: string[] = []
function temp(name: string) {
  const path = mkdtempSync(join(tmpdir(), name))
  roots.push(path)
  return path
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
function repository(name = 'git-snapshot-') {
  const cwd = temp(name)
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  git(cwd, 'config', 'user.name', 'Fixture')
  writeFileSync(join(cwd, 'tracked.txt'), 'initial\n')
  git(cwd, 'add', 'tracked.txt')
  git(cwd, 'commit', '-qm', 'initial')
  return cwd
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('GitSnapshotReader', () => {
  it('reports clean, staged, unstaged, untracked, rename and binary states', async () => {
    const cwd = repository()
    const clean = await new GitSnapshotReader(cwd).capture()
    expect(clean).toMatchObject({ repositoryKind: 'repository', clean: true })
    expect(clean.headOid).toBe(git(cwd, 'rev-parse', 'HEAD'))

    writeFileSync(join(cwd, 'tracked.txt'), 'unstaged\n')
    writeFileSync(join(cwd, 'staged.txt'), 'staged\n')
    writeFileSync(join(cwd, 'untracked.txt'), 'untracked\n')
    writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 0, 255]))
    git(cwd, 'add', 'staged.txt', 'binary.bin')
    git(cwd, 'mv', 'tracked.txt', 'renamed.txt')
    writeFileSync(join(cwd, 'renamed.txt'), 'renamed and unstaged\n')
    const snapshot = await new GitSnapshotReader(cwd).capture()

    expect(snapshot.clean).toBe(false)
    expect(
      snapshot.changes.some((change) => change.areas.includes('staged')),
    ).toBe(true)
    expect(
      snapshot.changes.some((change) => change.areas.includes('unstaged')),
    ).toBe(true)
    expect(
      snapshot.changes.some((change) => change.areas.includes('untracked')),
    ).toBe(true)
    expect(snapshot.changes.some((change) => change.renamed)).toBe(true)
    expect(snapshot.changes.some((change) => change.binary)).toBe(true)
    expect(snapshot.diff.preview).toContain('diff --git')
    expect(snapshot.log[0]?.subject).toBe('initial')
  })

  it('returns typed no-repo, worktree and submodule results', async () => {
    const plain = temp('git-none-')
    expect(await new GitSnapshotReader(plain).capture()).toMatchObject({
      repositoryKind: 'none',
      headOid: null,
    })

    const repo = repository('git-kinds-')
    const worktree = temp('git-worktree-')
    rmSync(worktree, { recursive: true })
    git(repo, 'worktree', 'add', '-q', worktree)
    expect(await new GitSnapshotReader(worktree).capture()).toMatchObject({
      repositoryKind: 'worktree',
    })

    const child = repository('git-child-')
    const parent = repository('git-parent-')
    git(
      parent,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      child,
      'vendor/child',
    )
    git(parent, 'commit', '-qm', 'submodule')
    expect(
      await new GitSnapshotReader(join(parent, 'vendor/child')).capture(),
    ).toMatchObject({ repositoryKind: 'submodule' })
  }, 20_000)

  it('rejects symlink workspace escapes and exposes no arbitrary operation API', () => {
    const root = temp('git-symlink-')
    const target = join(root, 'target')
    mkdirSync(target)
    const link = join(root, 'escape')
    symlinkSync(target, link)
    expect(() => new GitSnapshotReader(link)).toThrow(/canonical server-owned/)
    expect('run' in new GitSnapshotReader(target)).toBe(false)
    expect('checkout' in new GitSnapshotReader(target)).toBe(false)
  })
})
