import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistentCodexHomeManager } from './persistent-codex-home'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)

describe('PersistentCodexHomeManager', () => {
  it('is deterministic per scope, isolated across scopes and private', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-homes-'))
    roots.push(root)
    const homes = new PersistentCodexHomeManager(root)
    const first = homes.homeFor('tenant/a', '../workspace')
    expect(homes.homeFor('tenant/a', '../workspace')).toBe(first)
    expect(homes.homeFor('tenant/b', '../workspace')).not.toBe(first)
    expect(lstatSync(first).mode & 0o777).toBe(0o700)
    expect(first.startsWith(realpathSync(root))).toBe(true)
  })

  it('rejects a symlink component instead of escaping the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-homes-'))
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'))
    roots.push(root, outside)
    const digest = createHash('sha256')
      .update(JSON.stringify(['tenant', 'workspace']))
      .digest('hex')
    mkdirSync(root, { recursive: true })
    symlinkSync(outside, join(root, digest.slice(0, 2)), 'dir')
    const homes = new PersistentCodexHomeManager(root)
    expect(() => homes.homeFor('tenant', 'workspace')).toThrow(
      /unsafe path component/,
    )
  })

  it('provisions only allowlisted auth/config without copying secret state', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-homes-'))
    const source = mkdtempSync(join(tmpdir(), 'codex-provision-'))
    roots.push(root, source)
    writeFileSync(join(source, 'auth.json'), 'fixture-secret', { mode: 0o600 })
    writeFileSync(join(source, 'config.toml'), 'model = "test"', {
      mode: 0o600,
    })
    writeFileSync(join(source, 'history.jsonl'), 'must-not-link')
    mkdirSync(join(source, 'sessions'))
    const homes = new PersistentCodexHomeManager(root, {
      provisioningSource: source,
    })
    const first = homes.homeFor('tenant-a', 'workspace-a')
    const second = homes.homeFor('tenant-b', 'workspace-b')
    for (const home of [first, second]) {
      expect(realpathSync(join(home, 'auth.json'))).toBe(
        realpathSync(join(source, 'auth.json')),
      )
      expect(realpathSync(join(home, 'config.toml'))).toBe(
        realpathSync(join(source, 'config.toml')),
      )
      expect(existsSync(join(home, 'history.jsonl'))).toBe(false)
      expect(existsSync(join(home, 'sessions'))).toBe(false)
      expect(JSON.stringify({ home })).not.toContain('fixture-secret')
    }
  })
})
