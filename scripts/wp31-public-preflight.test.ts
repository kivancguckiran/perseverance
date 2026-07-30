import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildDependencySbom,
  buildLicenseReport,
  checkGitignoreCoverage,
  checkHygieneFiles,
  collectDependencyInventory,
  parseGitleaksToml,
  runLicenseGate,
  scanContent,
  scanFullHistory,
  scanWorkingTree,
  stableJson,
  type DependencyComponent,
  type LicensePolicyFile,
} from './wp31-release-lib'

const root = resolve(import.meta.dirname, '..')
const policy = parseGitleaksToml(
  readFileSync(join(root, 'infra/release/wp31-gitleaks.toml'), 'utf8'),
)
const licensePolicy: LicensePolicyFile = JSON.parse(
  readFileSync(join(root, 'infra/release/wp29-license-policy.v1.json'), 'utf8'),
)

const fakeAwsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const fakeMarker = ['WP29_PROVIDER_CREDENTIAL_', 'abcdefghijklmnop'].join('')

describe('wp31 secret policy', () => {
  it('wp31 konfigürasyonu wp29 kural setinin üst kümesidir ve gerekçeli allowlist taşır', () => {
    expect(policy.rules.map((rule) => rule.id)).toContain(
      'wp29-provider-credential',
    )
    expect(policy.allowlists.length).toBeGreaterThanOrEqual(4)
    for (const entry of policy.allowlists)
      expect(entry.description.trim().length).toBeGreaterThan(20)
  })

  it('authoritative wp29 security scan public-release secret politikasını kullanır', () => {
    const gate = readFileSync(join(root, 'scripts/wp29-real-gate.ts'), 'utf8')
    expect(
      gate.match(/--config=\/src\/infra\/release\/wp31-gitleaks\.toml/g)
        ?.length,
    ).toBe(2)
    expect(gate).not.toContain('--config=/src/infra/release/wp29-gitleaks.toml')
    for (const localOnly of [
      '**/.runtime',
      '**/node_modules',
      '**/dist',
      '**/.wp29',
      '**/.wp31',
      '/src/_to_delete',
    ])
      expect(gate).toContain(localOnly)
  })

  it('gerekçesiz allowlist kaydını reddeder', () => {
    expect(() =>
      parseGitleaksToml(
        '[[allowlists]]\npaths = ["""x"""]'.replace(/"""/g, "'''"),
      ),
    ).toThrow(/gerekçe/)
  })

  it('gerçek görünümlü secret sınıflarını yakalar', () => {
    const content = [
      `aws = "${fakeAwsKey}"`,
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      fakeMarker,
    ].join('\n')
    const findings = scanContent('services/example.ts', content, policy)
    const ruleIds = findings.map((finding) => finding.ruleId)
    expect(ruleIds).toContain('aws-access-key-id')
    expect(ruleIds).toContain('private-key')
    expect(ruleIds).toContain('wp29-provider-credential')
  })

  it('bulguları redakte eder; ham secret raporda görünmez', () => {
    const findings = scanContent('services/example.ts', fakeAwsKey, policy)
    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(finding.redacted).not.toContain(fakeAwsKey)
      expect(finding.redacted).toMatch(/…\[len:\d+\]$/)
    }
  })

  it('test fixture yollarını ve sentinel değerleri allowlist ile eler', () => {
    expect(
      scanContent(
        'packages/x/src/index.test.ts',
        `key = "${fakeAwsKey}"`,
        policy,
      ),
    ).toEqual([])
    expect(
      scanContent(
        'services/live.ts',
        "apiKey: 'sk-fixture-not-a-real-key-000000'",
        policy,
      ),
    ).toEqual([])
    expect(
      scanContent(
        'scripts/wp24-unified-e2e.ts',
        'idempotencyKey: "synthetic-replay-key-000000"',
        policy,
      ),
    ).toEqual([])
    expect(
      scanContent(
        'scripts/wp24-unified-e2e.ts',
        "'idempotency-key': 'synthetic-replay-value'",
        policy,
      ),
    ).toEqual([])
    expect(
      scanContent(
        'scripts/wp27-e2e.ts',
        "const marker = 'WP27_SECRET_MARKER_fixture'",
        policy,
      ),
    ).toEqual([])
    expect(
      scanContent(
        'infra/security/wp30/templates/realtime-boundary.yaml',
        'Sec-WebSocket-Key: synthetic-handshake-value',
        policy,
      ),
    ).toEqual([])
  })

  it("working tree ve tam history taraması seed edilmiş secret'ı bulur", () => {
    const work = mkdtempSync(join(tmpdir(), 'wp31-scan-'))
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: work })
      git('init', '--quiet')
      git('config', 'user.email', 'wp31@test.local')
      git('config', 'user.name', 'wp31')
      writeFileSync(join(work, 'leaked.ts'), `const key = "${fakeAwsKey}"\n`)
      git('add', '.')
      git('commit', '--quiet', '-m', 'seed')
      writeFileSync(join(work, 'leaked.ts'), 'const key = "temizlendi"\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'clean')
      const history = scanFullHistory(work, policy)
      expect(history.commitCount).toBe(2)
      expect(
        history.findings.some(
          (finding) =>
            finding.ruleId === 'aws-access-key-id' &&
            finding.path === 'leaked.ts',
        ),
      ).toBe(true)
      const workingTree = scanWorkingTree(work, policy)
      expect(workingTree.findings).toEqual([])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('wp31 gitignore secret kapsamı', () => {
  it('.wp30 benzeri lokal lab secret dizinleri gitignore kapsamındadır', () => {
    expect(checkGitignoreCoverage(root)).toEqual([])
  }, 15_000)
})

describe('wp31 lisans gate ve SBOM', () => {
  const fixture = (license: string): DependencyComponent => ({
    name: 'fixture-package',
    version: '1.0.0',
    license,
    normalizedLicense: license,
    direct: false,
  })

  it("mevcut dependency ağacı gate'ten geçer", () => {
    const components = collectDependencyInventory(root)
    expect(components.length).toBeGreaterThan(200)
    const gate = runLicenseGate(components, licensePolicy)
    expect(gate.violations).toEqual([])
    expect(gate.accepted).toBe(true)
  })

  it('enjekte edilen yasak lisansta fail eder', () => {
    const components = [
      ...collectDependencyInventory(root),
      fixture('SSPL-1.0'),
    ]
    const gate = runLicenseGate(components, licensePolicy)
    expect(gate.accepted).toBe(false)
    expect(gate.violations).toEqual([
      {
        component: 'fixture-package@1.0.0',
        license: 'SSPL-1.0',
        reason: 'yasak lisans',
      },
    ])
  })

  it('bilinmeyen lisans reviewedUnknown gerekçesi olmadan fail eder', () => {
    const gate = runLicenseGate([fixture('Custom-License-X')], licensePolicy)
    expect(gate.accepted).toBe(false)
    const reviewed = runLicenseGate([fixture('Custom-License-X')], {
      ...licensePolicy,
      reviewedUnknown: {
        'fixture-package@1.0.0': 'hukuk incelemesinden geçti (örnek)',
      },
    })
    expect(reviewed.accepted).toBe(true)
  })

  it('SPDX OR/AND ifadelerini değerlendirir', () => {
    expect(
      runLicenseGate([fixture('(MIT OR GPL-3.0)')], licensePolicy).accepted,
    ).toBe(true)
    expect(
      runLicenseGate([fixture('(GPL-3.0 AND MIT)')], licensePolicy).accepted,
    ).toBe(false)
  })

  it('SBOM ve lisans raporu deterministiktir: iki üretim bayt-aynıdır', () => {
    const first = collectDependencyInventory(root)
    const second = collectDependencyInventory(root)
    const meta = {
      name: 'perseverance',
      version: '0.0.0',
      license: 'AGPL-3.0-only',
    }
    expect(stableJson(buildDependencySbom(first, meta))).toEqual(
      stableJson(buildDependencySbom(second, meta)),
    )
    expect(stableJson(buildLicenseReport(first, licensePolicy))).toEqual(
      stableJson(buildLicenseReport(second, licensePolicy)),
    )
    const sbomText = stableJson(buildDependencySbom(first, meta))
    expect(sbomText).not.toMatch(/timestamp|serialNumber/)
  })

  it('platform varyantlarının transitif bağımlılıklarını envanterden eler', () => {
    const names = new Set(
      collectDependencyInventory(root).map((component) => component.name),
    )
    for (const platformOnly of [
      '@emnapi/core',
      '@emnapi/runtime',
      '@emnapi/wasi-threads',
      '@napi-rs/wasm-runtime',
      '@tybys/wasm-util',
    ])
      expect(names).not.toContain(platformOnly)
  })

  it('commit edilmiş SBOM ve lisans raporu günceldir (drift yok)', () => {
    const components = collectDependencyInventory(root)
    const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const sbom = stableJson(
      buildDependencySbom(components, {
        name: meta.name,
        version: meta.version,
        license: licensePolicy.projectLicense ?? 'UNKNOWN',
      }),
    )
    const report = stableJson(buildLicenseReport(components, licensePolicy))
    expect(
      readFileSync(join(root, 'infra/release/wp31-sbom.cdx.json'), 'utf8'),
    ).toEqual(sbom)
    expect(
      readFileSync(
        join(root, 'infra/release/wp31-license-report.json'),
        'utf8',
      ),
    ).toEqual(report)
  })

  it('proje lisansı AGPL-3.0-only olarak sabitlenmiştir', () => {
    expect(licensePolicy.projectLicense).toBe('AGPL-3.0-only')
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain(
      'GNU AFFERO GENERAL PUBLIC LICENSE',
    )
  })
})

describe('wp31 hijyen dosyaları', () => {
  it('temiz checkout install adımını non-interactive çalıştırır', () => {
    const preflight = readFileSync(
      join(root, 'scripts/wp31-public-preflight.ts'),
      'utf8',
    )
    expect(preflight).toContain("CI: process.env.CI ?? 'true'")
  })

  it('zorunlu public dosyaların tümü mevcut ve doludur', () => {
    expect(checkHygieneFiles(root)).toEqual([])
  })

  it('eksik dosyayı raporlar', () => {
    const work = mkdtempSync(join(tmpdir(), 'wp31-hygiene-'))
    try {
      const problems = checkHygieneFiles(work)
      expect(problems.some((problem) => problem.startsWith('LICENSE'))).toBe(
        true,
      )
      expect(
        problems.some((problem) => problem.startsWith('SECURITY.md')),
      ).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
