import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WP34_GATES,
  WP34_REQUIRED_FILES,
  checkTermsWatchList,
  checkWp34Migration,
  summarizeWp34Gates,
} from './wp34-lib'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('wp34 teslimat sözleşmesi', () => {
  it('zorunlu dosyalar mevcut ve gate scriptleri tanımlıdır', () => {
    for (const path of WP34_REQUIRED_FILES)
      expect(read(path).length, path).toBeGreaterThan(200)
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    for (const gate of WP34_GATES)
      expect(packageJson.scripts[gate], gate).toBeDefined()
  })

  it('0036 migration FORCE RLS/envelope/digest/crypto-erasure sınırlarını taşır', () => {
    const migration = read(
      'infra/postgres/migrations/0036_wp34_provider_auth_profiles.sql',
    )
    expect(checkWp34Migration(migration)).toEqual([])
    expect(checkWp34Migration('access_token text')).toContain(
      'forbidden:access_token text',
    )
    expect(
      read('infra/postgres/migrations/0035_wp33_managed_tenant_runtime.sql'),
    ).not.toContain('provider_auth_profiles')
  })

  it('terms watch list zorunlu evidence alanlarını taşır', () => {
    expect(
      checkTermsWatchList(
        JSON.parse(read('docs/security/provider-terms-watch-list.json')),
      ),
    ).toEqual([])
  })

  it('not-run acceptance sonucuna terfi ettirilmez', () => {
    expect(
      summarizeWp34Gates([
        { gate: 'wp34:test', accepted: true, status: 'passed' },
        { gate: 'wp34:vault', accepted: false, status: 'not-run' },
      ]),
    ).toMatchObject({ accepted: false, notRun: 1 })
  })

  it('.wp34 evidence dizini gitignored', () => {
    expect(read('.gitignore')).toContain('.wp34/')
    expect(
      spawnSync('git', ['check-ignore', '-q', '.wp34/evidence/report.json'], {
        cwd: root,
      }).status,
    ).toBe(0)
  })
})
