import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SECRET_PATH_PROBES } from './wp31-release-lib'
import {
  WP35_GATES,
  WP35_REQUIRED_FILES,
  WP35_TEST_FILES,
  checkWp35Adr,
  checkWp35Migration,
  summarizeWp35Gates,
} from './wp35-lib'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('wp35 teslimat sözleşmesi', () => {
  it('zorunlu dosyalar ve package gate scriptleri mevcuttur', () => {
    for (const path of WP35_REQUIRED_FILES)
      expect(read(path).length, path).toBeGreaterThan(200)
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    for (const gate of WP35_GATES)
      expect(packageJson.scripts[gate], gate).toBeDefined()
    for (const path of WP35_TEST_FILES)
      expect(read(path)).toContain('describe(')
  })

  it('0037 migration tenant/RLS/billing değişmezlerini taşır', () => {
    const migration = read(
      'infra/postgres/migrations/0037_wp35_managed_cloud_beta.sql',
    )
    expect(checkWp35Migration(migration)).toEqual([])
    expect(checkWp35Migration('access_token text')).toContain(
      'forbidden:access_token text',
    )
    expect(
      read('infra/postgres/migrations/0036_wp34_provider_auth_profiles.sql'),
    ).not.toContain('managed_cloud_onboardings')
  })

  it('ADR bütün mevcut otoritelere ve maliyet ayrımına bağlanır', () => {
    expect(
      checkWp35Adr(
        read(
          'docs/architecture/adr-0035-managed-cloud-onboarding-billing-and-beta.md',
        ),
      ),
    ).toEqual([])
  })

  it('evidence gitignored ve secret probe kapsamındadır', () => {
    expect(SECRET_PATH_PROBES).toContain('.wp35/evidence/report.json')
    expect(
      spawnSync('git', ['check-ignore', '-q', '.wp35/evidence/report.json'], {
        cwd: root,
      }).status,
    ).toBe(0)
  })

  it('not-run acceptance sonucuna terfi etmez', () => {
    expect(
      summarizeWp35Gates([
        { gate: 'wp35:test', accepted: true, status: 'passed' },
        { gate: 'wp35:onboarding', accepted: false, status: 'not-run' },
      ]),
    ).toMatchObject({ accepted: false, notRun: 1 })
  })
})
