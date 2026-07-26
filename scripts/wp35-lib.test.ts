import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
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
import { WP35_POSTGRES_READINESS_TIMEOUT_MS } from './wp35-postgres-readiness'

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

  it('WP35-E prerequisites olmadan fail-closed no-go döner', () => {
    const output = mkdtempSync(join(tmpdir(), 'wp35-external-subprocess-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith('WP35_E_') && name !== 'WP35_OUTPUT_DIR',
      ),
    )
    try {
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/wp35-external-accept.ts'],
        {
          cwd: root,
          env: { ...env, WP35_OUTPUT_DIR: output },
          encoding: 'utf8',
        },
      )
      expect(run.status).toBe(1)
      expect(run.stderr).toBe('')
      const line = run.stdout
        .trim()
        .split('\n')
        .findLast((candidate) => candidate.startsWith('{"gate":'))
      expect(line).toBeDefined()
      const evidence = JSON.parse(line!) as {
        accepted: boolean
        status: string
        productionEvidence: boolean
        decision: string
        missing: string[]
      }
      expect(evidence).toMatchObject({
        accepted: false,
        status: 'not-run',
        productionEvidence: false,
        decision: 'no-go',
      })
      expect(evidence.missing).toContain('WP35_E_WP30_ACCEPTANCE_REPORT_PATH')
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })

  it('WP35-E attestation JSON Schema gerçek validator ile derlenir', () => {
    const schema = JSON.parse(
      read('docs/security/wp35-external-beta-attestation.schema.json'),
    )
    const validate = new Ajv2020({
      allErrors: true,
      strict: true,
    }).compile(schema)
    expect(validate({})).toBe(false)
    expect(validate.errors?.map(({ keyword }) => keyword)).toContain('required')
  })

  it('PostgreSQL readiness en az 60 saniye ve tek temiz retry ile sınırlıdır', () => {
    expect(WP35_POSTGRES_READINESS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    const readiness = read('scripts/wp35-postgres-readiness.ts')
    expect(readiness).toContain('attempt <= 2')
    expect(readiness).toContain("docker(['rm', '-f', '-v'")
    expect(readiness).toContain("'SELECT 1 AS ready'")
  })
})
