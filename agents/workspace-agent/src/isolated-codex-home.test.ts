import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIsolatedCodexHome } from './isolated-codex-home'

describe('isolated real-smoke CODEX_HOME', () => {
  it('links only auth/config, excludes task state, and removes the temp home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'isolated-codex-home-test-'))
    const source = join(root, 'source')
    const temporaryRoot = join(root, 'temporary')
    mkdirSync(source)
    mkdirSync(temporaryRoot)
    writeFileSync(join(source, 'auth.json'), 'fixture-secret-never-read')
    writeFileSync(join(source, 'config.toml'), 'model = "fixture"')
    writeFileSync(join(source, 'state_5.sqlite'), 'task-state')
    writeFileSync(join(source, 'session_index.jsonl'), 'task-index')
    const isolated = createIsolatedCodexHome({
      sourceHome: source,
      temporaryRoot,
    })
    const isolatedPath = isolated.path
    try {
      expect(isolatedPath.startsWith(`${temporaryRoot}/`)).toBe(true)
      expect(isolated.linkedFiles).toEqual(['auth.json', 'config.toml'])
      expect(lstatSync(join(isolatedPath, 'auth.json')).isSymbolicLink()).toBe(
        true,
      )
      expect(
        lstatSync(join(isolatedPath, 'config.toml')).isSymbolicLink(),
      ).toBe(true)
      expect(existsSync(join(isolatedPath, 'state_5.sqlite'))).toBe(false)
      expect(existsSync(join(isolatedPath, 'session_index.jsonl'))).toBe(false)
    } finally {
      isolated.cleanup()
      isolated.cleanup()
      expect(existsSync(isolatedPath)).toBe(false)
      await rm(root, { recursive: true, force: true })
    }
  })
})
