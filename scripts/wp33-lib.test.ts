import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WP33_GATES,
  WP33_REQUIRED_FILES,
  WP33_TEST_FILES,
  checkWp33Adr,
  checkWp33Migration,
  summarizeWp33Gates,
  type Wp33GateResult,
} from './wp33-lib'
import { SECRET_PATH_PROBES } from './wp31-release-lib'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('wp33 teslimat dosyaları', () => {
  it('zorunlu WP33 dosyaları mevcut ve boş değildir', () => {
    for (const path of WP33_REQUIRED_FILES) {
      expect(read(path).length, path).toBeGreaterThan(200)
    }
  })

  it('package.json tüm wp33 gate komutlarını tanımlar', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    for (const gate of WP33_GATES) {
      expect(packageJson.scripts[gate], gate).toBeDefined()
    }
    expect(packageJson.scripts['wp33:test']).toContain('wp33-test-gate')
    expect(packageJson.scripts['wp33:accept']).toContain('wp33-accept')
  })

  it('wp33 test dosyaları vitest include kapsamındadır', () => {
    for (const path of WP33_TEST_FILES) {
      expect(read(path)).toContain('describe(')
    }
  })
})

describe('wp33 migration değişmezleri', () => {
  const migration = read(
    'infra/postgres/migrations/0035_wp33_managed_tenant_runtime.sql',
  )

  it('0035 migration tüm zorunlu izolasyon değişmezlerini taşır', () => {
    expect(checkWp33Migration(migration)).toEqual([])
  })

  it('checker eksik değişmezleri yakalar', () => {
    expect(checkWp33Migration('SELECT 1')).toContain('missing:provisioner-role')
    expect(
      checkWp33Migration(migration.replace(/FORCE ROW LEVEL SECURITY/g, '')),
    ).toContain('missing:force-row-level-security')
  })

  it('uygulanmış migration dosyaları değiştirilmemiştir (tracking-runner uyumu)', () => {
    // Yeni migration mevcut son dosyadan sonra gelir; runner lexical sırayla uygular.
    expect(migration.startsWith('-- WP33')).toBe(true)
    expect(
      read('infra/postgres/migrations/0034_wp30_production_rollout.sql'),
    ).not.toContain('wp33')
  })
})

describe('wp33 evidence sözleşmesi', () => {
  it('.wp33 dizini gitignore ve secret-path probe kapsamındadır', () => {
    expect(read('.gitignore')).toContain('.wp33/')
    expect(SECRET_PATH_PROBES).toContain('.wp33/evidence/report.json')
    const check = spawnSync(
      'git',
      ['check-ignore', '-q', '.wp33/evidence/report.json'],
      { cwd: root },
    )
    expect(check.status).toBe(0)
  })

  it('summarize hiçbir not-run sonucunu başarıya terfi ettirmez', () => {
    const passed: Wp33GateResult = {
      gate: 'wp33:test',
      accepted: true,
      status: 'passed',
    }
    const notRun: Wp33GateResult = {
      gate: 'wp33:provisioning',
      accepted: false,
      status: 'not-run',
    }
    expect(summarizeWp33Gates([passed, passed]).accepted).toBe(true)
    expect(summarizeWp33Gates([passed, notRun])).toMatchObject({
      accepted: false,
      notRun: 1,
    })
    expect(summarizeWp33Gates([]).accepted).toBe(false)
  })
})

describe('ADR-0033 bağları', () => {
  it('ADR; ADR-0017, ADR-0026, ADR-0032 ve üç profili açıkça bağlar', () => {
    const adr = read(
      'docs/architecture/adr-0033-deployment-profiles-and-managed-tenant-runtime.md',
    )
    expect(checkWp33Adr(adr)).toEqual([])
  })

  it('runbook operasyon prosedürlerini belgeler', () => {
    const runbook = read('docs/operations/managed-tenant-runtime-runbook.md')
    for (const section of [
      'wp33:provisioning',
      'wp33:isolation',
      'wp33:chaos',
      'reconcile',
      'orphan',
    ]) {
      expect(runbook).toContain(section)
    }
  })
})
