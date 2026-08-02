import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import {
  buildDependencySbom,
  buildLicenseReport,
  checkGitignoreCoverage,
  checkHygieneFiles,
  collectDependencyInventory,
  parseGitleaksToml,
  runLicenseGate,
  scanFullHistory,
  scanWorkingTree,
  sha256,
  stableJson,
  type LicensePolicyFile,
} from './public-release-lib'

// Public-release preflight (ADR-0031) under one deterministic gate:
//   1. zorunlu hijyen dosyaları
//   2. gitignore secret dizin kapsamı
//   3. working tree + tam Git history secret taraması (redakte evidence)
//   4. dependency lisans gate'i + deterministik SBOM/lisans raporu drift kontrolü
//   5. temiz checkout'ta `pnpm install --frozen-lockfile && pnpm verify`
// Evidence çıktısı zaman damgası içermez; iki ardışık koşu bayt-aynı sonuç üretir.
// İmzalı artifact ve provenance self-hosted release hattında üretilir.

const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(root, '.public-release', 'evidence')
mkdirSync(evidenceDir, { recursive: true })

const updateMode = process.argv.includes('--update-artifacts')
const skipCleanCheckout =
  process.env.PUBLIC_PREFLIGHT_SKIP_CLEAN_CHECKOUT === '1'

const failures: string[] = []
const step = (name: string, run: () => string) => {
  try {
    const summary = run()
    console.log(`✔ ${name}: ${summary}`)
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`)
    console.error(`✘ ${name}: ${(error as Error).message}`)
  }
}

const policyText = readFileSync(
  join(root, 'infra/release/public-gitleaks.toml'),
  'utf8',
)
const secretPolicy = parseGitleaksToml(policyText)
const licensePolicy: LicensePolicyFile = JSON.parse(
  readFileSync(join(root, 'infra/release/license-policy.v1.json'), 'utf8'),
)

const evidence: Record<string, unknown> = {
  gate: 'release:public-preflight',
  adr: 'ADR-0031',
  secretPolicySha256: sha256(policyText),
}

// 1. Hijyen dosyaları
step('hygiene-files', () => {
  const problems = checkHygieneFiles(root)
  if (problems.length) throw new Error(problems.join('; '))
  evidence.hygiene = { accepted: true }
  return 'zorunlu public dosyaların tümü mevcut'
})

// 2. Gitignore secret kapsamı
step('gitignore-coverage', () => {
  const uncovered = checkGitignoreCoverage(root)
  if (uncovered.length)
    throw new Error(`gitignore kapsamı dışında: ${uncovered.join(', ')}`)
  evidence.gitignoreCoverage = { accepted: true }
  return 'lokal secret dizinleri gitignore kapsamında'
})

// 3. Secret taraması: working tree + tam history
step('secret-scan', () => {
  const workingTree = scanWorkingTree(root, secretPolicy)
  const history = scanFullHistory(root, secretPolicy)
  const report = {
    config: 'infra/release/public-gitleaks.toml',
    workingTree: {
      filesScanned: workingTree.filesScanned,
      findings: workingTree.findings,
    },
    history: {
      commitCount: history.commitCount,
      blobsScanned: history.blobsScanned,
      findings: history.findings,
    },
  }
  writeFileSync(
    join(evidenceDir, 'public-secret-scan.json'),
    stableJson(report),
  )
  const total = workingTree.findings.length + history.findings.length
  evidence.secretScan = {
    accepted: total === 0,
    workingTreeFilesScanned: workingTree.filesScanned,
    historyCommits: history.commitCount,
    historyBlobsScanned: history.blobsScanned,
    findings: total,
  }
  if (total)
    throw new Error(
      `${total} doğrulanmamış bulgu (redakte rapor: .public-release/evidence/public-secret-scan.json)`,
    )
  return `working tree ${workingTree.filesScanned} dosya + history ${history.commitCount} commit / ${history.blobsScanned} blob, 0 bulgu`
})

// 4. Lisans gate'i + deterministik SBOM/lisans raporu
step('license-gate-and-sbom', () => {
  const components = collectDependencyInventory(root)
  const gate = runLicenseGate(components, licensePolicy)
  if (!gate.accepted)
    throw new Error(
      gate.violations
        .map(
          (violation) =>
            `${violation.component} (${violation.license}): ${violation.reason}`,
        )
        .join('; '),
    )
  const projectMeta = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  )
  const sbom = stableJson(
    buildDependencySbom(components, {
      name: projectMeta.name,
      version: projectMeta.version,
      license: licensePolicy.projectLicense ?? 'UNKNOWN',
    }),
  )
  const report = stableJson(buildLicenseReport(components, licensePolicy))
  const sbomPath = join(root, 'infra/release/sbom.cdx.json')
  const reportPath = join(root, 'infra/release/dependency-license-report.json')
  writeFileSync(join(evidenceDir, 'sbom.cdx.json'), sbom)
  writeFileSync(join(evidenceDir, 'dependency-license-report.json'), report)
  if (updateMode) {
    writeFileSync(sbomPath, sbom)
    writeFileSync(reportPath, report)
  }
  const drift: string[] = []
  if (!existsSync(sbomPath) || readFileSync(sbomPath, 'utf8') !== sbom)
    drift.push('infra/release/sbom.cdx.json')
  if (!existsSync(reportPath) || readFileSync(reportPath, 'utf8') !== report)
    drift.push('infra/release/dependency-license-report.json')
  if (drift.length)
    throw new Error(
      `commit edilmiş çıktı güncel değil: ${drift.join(', ')} — 'pnpm release:public-preflight --update-artifacts' ile yenileyin`,
    )
  evidence.licenseAndSbom = {
    accepted: true,
    componentCount: components.length,
    licensesObserved: gate.licensesObserved,
    sbomSha256: sha256(sbom),
    licenseReportSha256: sha256(report),
  }
  return `${components.length} bileşen, sbom sha256 ${sha256(sbom).slice(0, 12)}…`
})

// 5. Temiz checkout build/test
step('clean-checkout', () => {
  if (skipCleanCheckout) {
    evidence.cleanCheckout = { accepted: false, skipped: true }
    return 'PUBLIC_PREFLIGHT_SKIP_CLEAN_CHECKOUT=1 ile atlandı (yalnız iterasyon için; kabul koşusunda kapatılamaz)'
  }
  const work = mkdtempSync(join(tmpdir(), 'public-release-clean-'))
  try {
    const checkout = join(work, 'checkout')
    const clone = spawnSync('git', ['clone', '--quiet', root, checkout], {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (clone.status !== 0)
      throw new Error(
        `git clone failed (${clone.status}): ${(clone.stderr || clone.stdout).slice(-4000)}`,
      )
    const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
    })
    if (diff.status !== 0) throw new Error('git diff --binary HEAD failed')
    if (diff.stdout.length) {
      const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
        cwd: checkout,
        input: diff.stdout,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      })
      if (applied.status !== 0)
        throw new Error(
          `git apply worktree failed (${applied.status}): ${(applied.stderr || applied.stdout).slice(-4000)}`,
        )
    }
    const untracked = spawnSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'buffer' },
    )
    if (untracked.status !== 0) throw new Error('git ls-files failed')
    for (const path of untracked.stdout.toString('utf8').split('\0')) {
      if (!path) continue
      const target = join(checkout, path)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(root, path), target)
    }
    const commands: [string, string[]][] = [
      ['pnpm', ['install', '--frozen-lockfile']],
      ['pnpm', ['verify']],
    ]
    for (const [command, args] of commands) {
      const result = spawnSync(command, args, {
        cwd: checkout,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          CI: process.env.CI ?? 'true',
          PUBLIC_PREFLIGHT_SKIP_CLEAN_CHECKOUT: '1',
        },
      })
      if (result.status !== 0)
        throw new Error(
          `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr?.slice(-2000) ?? ''}`,
        )
      if (args[0] === 'install') {
        const localInventory = collectDependencyInventory(root).map(
          ({ name, version, license }) => `${name}@${version}:${license}`,
        )
        const cleanInventory = collectDependencyInventory(checkout).map(
          ({ name, version, license }) => `${name}@${version}:${license}`,
        )
        if (stableJson(localInventory) !== stableJson(cleanInventory)) {
          const local = new Set(localInventory)
          const clean = new Set(cleanInventory)
          throw new Error(
            `dependency inventory nondeterministic; clean-only=${cleanInventory
              .filter((entry) => !local.has(entry))
              .slice(0, 20)
              .join(',')}; local-only=${localInventory
              .filter((entry) => !clean.has(entry))
              .slice(0, 20)
              .join(',')}`,
          )
        }
      }
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: join(work, 'checkout'),
      encoding: 'utf8',
    }).stdout.trim()
    evidence.cleanCheckout = {
      accepted: true,
      sourceCommit: head,
      includesWorkingTree: true,
    }
    return `temiz worktree snapshot'ında (HEAD ${head.slice(0, 12)}) frozen-lockfile install + verify geçti`
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

evidence.accepted = failures.length === 0
const evidenceText = stableJson(evidence)
writeFileSync(join(evidenceDir, 'public-release-preflight.json'), evidenceText)
console.log(
  `${failures.length === 0 ? 'ACCEPTED' : 'FAILED'} — evidence sha256 ${sha256(evidenceText).slice(0, 16)}… (.public-release/evidence/public-release-preflight.json)`,
)
if (failures.length) {
  process.exitCode = 1
}
