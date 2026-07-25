import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// WP31 public-release kütüphanesi. Deterministiktir: hiçbir fonksiyon zaman
// damgası, rastgelelik veya mutlak yol içeren çıktı üretmez. ADR-0031.

export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex')

const runGit = (args: string[], cwd: string, input?: Buffer | string) => {
  const result = spawnSync('git', args, {
    cwd,
    input,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${String(result.stderr)}`,
    )
  return result.stdout as Buffer
}

// --- Gitleaks TOML alt kümesi ---
// Desteklenen yapı: üst düzey anahtarlar, [extend], [[rules]] (id, description,
// regex, keywords) ve [[allowlists]] (description, paths, regexes). Bu alt küme
// infra/release/wp31-gitleaks.toml için yeterlidir ve resmî gitleaks ile aynı
// dosyayı paylaşır.

export interface SecretRule {
  id: string
  description?: string
  regex: RegExp
}

export interface AllowlistEntry {
  description: string
  paths: RegExp[]
  regexes: RegExp[]
}

export interface SecretPolicy {
  title?: string
  rules: SecretRule[]
  allowlists: AllowlistEntry[]
}

// Go/RE2 stilindeki başa yazılan (?i) bayrağını JS RegExp bayrağına çevirir;
// gitleaks TOML'ı Go regex'i kullanır, JS inline grup bayrağını desteklemez.
const goRegexToJs = (source: string, extraFlags = ''): RegExp =>
  source.startsWith('(?i)')
    ? new RegExp(source.slice(4), `i${extraFlags}`)
    : new RegExp(source, extraFlags)

const parseTomlString = (raw: string): string => {
  const trimmed = raw.trim()
  if (
    trimmed.startsWith("'''") &&
    trimmed.endsWith("'''") &&
    trimmed.length >= 6
  )
    return trimmed.slice(3, -3)
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1)
  return trimmed
}

const splitTomlArray = (body: string): string[] => {
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < body.length; index += 1) {
    if (quote === "'''") {
      if (body.startsWith("'''", index)) {
        current += "'''"
        index += 2
        quote = null
      } else current += body[index]
      continue
    }
    if (quote) {
      current += body[index]
      if (body[index] === quote) quote = null
      continue
    }
    if (body.startsWith("'''", index)) {
      current += "'''"
      index += 2
      quote = "'''"
      continue
    }
    if (body[index] === '"' || body[index] === "'") {
      quote = body[index]
      current += body[index]
      continue
    }
    if (body[index] === ',') {
      if (current.trim()) items.push(parseTomlString(current))
      current = ''
      continue
    }
    current += body[index]
  }
  if (current.trim()) items.push(parseTomlString(current))
  return items
}

export const parseGitleaksToml = (text: string): SecretPolicy => {
  const policy: SecretPolicy = { rules: [], allowlists: [] }
  let section: 'root' | 'extend' | 'rule' | 'allowlist' = 'root'
  let currentRule: Partial<SecretRule> & { keywords?: string[] } = {}
  let currentAllow: {
    description?: string
    paths: string[]
    regexes: string[]
  } = {
    paths: [],
    regexes: [],
  }
  const flushRule = () => {
    if (currentRule.id && currentRule.regex)
      policy.rules.push({
        id: currentRule.id,
        description: currentRule.description,
        regex: currentRule.regex,
      })
    currentRule = {}
  }
  const flushAllow = () => {
    if (
      currentAllow.description ||
      currentAllow.paths.length ||
      currentAllow.regexes.length
    )
      policy.allowlists.push({
        description: currentAllow.description ?? '',
        paths: currentAllow.paths.map((source) => goRegexToJs(source)),
        regexes: currentAllow.regexes.map((source) => goRegexToJs(source)),
      })
    currentAllow = { paths: [], regexes: [] }
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#')) continue
    if (stripped === '[[rules]]') {
      flushRule()
      flushAllow()
      section = 'rule'
      continue
    }
    if (stripped === '[[allowlists]]' || stripped === '[allowlist]') {
      flushRule()
      flushAllow()
      section = 'allowlist'
      continue
    }
    if (stripped === '[extend]') {
      flushRule()
      flushAllow()
      section = 'extend'
      continue
    }
    if (stripped.startsWith('[')) {
      flushRule()
      flushAllow()
      section = 'root'
      continue
    }
    const equals = stripped.indexOf('=')
    if (equals === -1) continue
    const key = stripped.slice(0, equals).trim()
    let value = stripped.slice(equals + 1).trim()
    if (value.startsWith('[') && !value.endsWith(']')) {
      while (index + 1 < lines.length && !value.endsWith(']')) {
        index += 1
        value += `\n${lines[index].split('#')[0].trimEnd()}`
        value = value.trim()
      }
    }
    if (section === 'root' && key === 'title')
      policy.title = parseTomlString(value)
    if (section === 'rule') {
      if (key === 'id') currentRule.id = parseTomlString(value)
      if (key === 'description')
        currentRule.description = parseTomlString(value)
      if (key === 'regex')
        currentRule.regex = goRegexToJs(parseTomlString(value), 'g')
    }
    if (section === 'allowlist') {
      const arrayBody =
        value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : null
      if (key === 'description')
        currentAllow.description = parseTomlString(value)
      if (key === 'paths' && arrayBody !== null)
        currentAllow.paths.push(...splitTomlArray(arrayBody))
      if (key === 'regexes' && arrayBody !== null)
        currentAllow.regexes.push(...splitTomlArray(arrayBody))
    }
  }
  flushRule()
  flushAllow()
  for (const entry of policy.allowlists)
    if (!entry.description.trim())
      throw new Error(
        'wp31 secret policy: her allowlist kaydı gerekçe (description) içermelidir',
      )
  return policy
}

// Offline koşularda gitleaks default kural setinin yüksek sinyalli yaklaşık
// karşılığı. Docker'lı resmî gitleaks koşusu (wp29:security-scans) authoritative
// kalır; bu set preflight'ın her ortamda bağımsız çalışmasını sağlar.
export const builtinSecretRules: SecretRule[] = [
  {
    id: 'aws-access-key-id',
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'private-key',
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'github-token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b/g,
  },
  { id: 'gitlab-pat', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-api-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-api-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'slack-webhook',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_/]{8,}/g,
  },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-access-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'stripe-secret-key', regex: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'twilio-api-key', regex: /\bSK[0-9a-fA-F]{32}\b/g },
  {
    id: 'sendgrid-api-key',
    regex: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g,
  },
  {
    id: 'jwt',
    regex:
      /\beyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'generic-credential-assignment',
    regex:
      /(?:password|passwd|secret|api[_-]?key|access[_-]?token|credential)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
  },
]

export interface SecretFinding {
  ruleId: string
  path: string
  blob: string
  redacted: string
}

const redact = (match: string): string =>
  `${match.slice(0, 4)}…[len:${match.length}]`

export const scanContent = (
  path: string,
  text: string,
  policy: SecretPolicy,
  blob = 'worktree',
): SecretFinding[] => {
  const pathAllowed = policy.allowlists.some((entry) =>
    entry.paths.some((pattern) => pattern.test(path)),
  )
  if (pathAllowed) return []
  const findings: SecretFinding[] = []
  for (const rule of [...builtinSecretRules, ...policy.rules]) {
    const pattern = new RegExp(rule.regex.source, rule.regex.flags)
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
      const valueAllowed = policy.allowlists.some((entry) =>
        entry.regexes.some((allow) => allow.test(value)),
      )
      if (valueAllowed) continue
      findings.push({ ruleId: rule.id, path, blob, redacted: redact(value) })
    }
  }
  return findings
}

const looksBinary = (buffer: Buffer): boolean =>
  buffer.subarray(0, 8000).includes(0)

const MAX_SCANNED_BLOB_BYTES = 10 * 1024 * 1024

export const listWorkingTreeFiles = (root: string): string[] =>
  String(
    runGit(['ls-files', '--cached', '--others', '--exclude-standard'], root),
  )
    .split('\n')
    .filter(Boolean)
    .sort()

export const scanWorkingTree = (
  root: string,
  policy: SecretPolicy,
): { filesScanned: number; findings: SecretFinding[] } => {
  const findings: SecretFinding[] = []
  let filesScanned = 0
  for (const path of listWorkingTreeFiles(root)) {
    const absolute = join(root, path)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue
    const buffer = readFileSync(absolute)
    if (buffer.length > MAX_SCANNED_BLOB_BYTES || looksBinary(buffer)) continue
    filesScanned += 1
    findings.push(...scanContent(path, buffer.toString('utf8'), policy))
  }
  return { filesScanned, findings: sortFindings(findings) }
}

export const scanFullHistory = (
  root: string,
  policy: SecretPolicy,
): { commitCount: number; blobsScanned: number; findings: SecretFinding[] } => {
  const commitCount = String(
    runGit(['rev-list', '--all', '--count'], root),
  ).trim()
  const objectLines = String(runGit(['rev-list', '--objects', '--all'], root))
    .split('\n')
    .filter(Boolean)
  const blobPaths = new Map<string, string>()
  for (const line of objectLines) {
    const space = line.indexOf(' ')
    if (space === -1) continue
    const sha = line.slice(0, space)
    const path = line.slice(space + 1)
    if (path && !blobPaths.has(sha)) blobPaths.set(sha, path)
  }
  const shas = [...blobPaths.keys()].sort()
  const batch = runGit(['cat-file', '--batch'], root, `${shas.join('\n')}\n`)
  const findings: SecretFinding[] = []
  let blobsScanned = 0
  let offset = 0
  for (const sha of shas) {
    const headerEnd = batch.indexOf(0x0a, offset)
    const header = batch.subarray(offset, headerEnd).toString('utf8')
    offset = headerEnd + 1
    const [, type, sizeText] = header.split(' ')
    if (!type || header.endsWith('missing')) continue
    const size = Number(sizeText)
    const body = batch.subarray(offset, offset + size)
    offset += size + 1
    if (type !== 'blob') continue
    if (size > MAX_SCANNED_BLOB_BYTES || looksBinary(body)) continue
    blobsScanned += 1
    findings.push(
      ...scanContent(
        blobPaths.get(sha) ?? sha,
        body.toString('utf8'),
        policy,
        sha.slice(0, 12),
      ),
    )
  }
  return {
    commitCount: Number(commitCount),
    blobsScanned,
    findings: sortFindings(findings),
  }
}

const sortFindings = (findings: SecretFinding[]): SecretFinding[] =>
  [...findings].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.blob.localeCompare(b.blob) ||
      a.redacted.localeCompare(b.redacted),
  )

// --- Gitignore secret dizin kapsamı ---

export const SECRET_PATH_PROBES = [
  '.env',
  '.env.local',
  '.wp29/lab-secret',
  '.wp30/lab-secret',
  '.wp31/evidence/report.json',
  '.wp32/evidence/report.json',
  '.wp32/home/secrets/backup-key',
  '.wp33/evidence/report.json',
  '.wp34/evidence/report.json',
  '.wp35/evidence/report.json',
  '.codex-home/auth.json',
  '.runtime/alpha/state.json',
  'artifacts/output.bin',
  'tmp/scratch.txt',
]

export const checkGitignoreCoverage = (root: string): string[] => {
  const uncovered: string[] = []
  for (const probe of SECRET_PATH_PROBES) {
    const result = spawnSync('git', ['check-ignore', '-q', probe], {
      cwd: root,
    })
    if (result.status !== 0) uncovered.push(probe)
  }
  return uncovered
}

// --- Dependency envanteri, lisans gate'i ve SBOM ---

export interface DependencyComponent {
  name: string
  version: string
  license: string
  normalizedLicense: string
  direct: boolean
}

const LICENSE_ALIASES: Record<string, string> = {
  'MIT License': 'MIT',
  'Apache 2.0': 'Apache-2.0',
  'Apache License 2.0': 'Apache-2.0',
  BSD: 'BSD-3-Clause',
}

const normalizeLicense = (license: string): string =>
  LICENSE_ALIASES[license] ?? license

const readPackageLicense = (meta: Record<string, unknown>): string => {
  const license = meta.license
  if (typeof license === 'string' && license.trim()) return license.trim()
  if (license && typeof license === 'object' && 'type' in license)
    return String((license as { type?: unknown }).type ?? 'UNKNOWN')
  const licenses = meta.licenses
  if (Array.isArray(licenses) && licenses.length)
    return licenses
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : String((entry as { type?: unknown }).type),
      )
      .join(' OR ')
  return 'UNKNOWN'
}

export const collectDependencyInventory = (
  root: string,
): DependencyComponent[] => {
  const rootMeta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const directNames = new Set([
    ...Object.keys(rootMeta.dependencies ?? {}),
    ...Object.keys(rootMeta.devDependencies ?? {}),
  ])
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store))
    throw new Error(
      'node_modules/.pnpm bulunamadı; önce pnpm install çalıştırın',
    )
  const seen = new Map<string, DependencyComponent>()
  for (const entry of readdirSync(store).sort()) {
    const entryModules = join(store, entry, 'node_modules')
    if (!existsSync(entryModules) || !statSync(entryModules).isDirectory())
      continue
    for (const child of readdirSync(entryModules).sort()) {
      const childPath = join(entryModules, child)
      if (lstatSync(childPath).isSymbolicLink()) continue
      const candidates = child.startsWith('@')
        ? readdirSync(childPath)
            .sort()
            .map((scoped) => join(childPath, scoped))
            .filter((scopedPath) => !lstatSync(scopedPath).isSymbolicLink())
        : [childPath]
      for (const candidate of candidates) {
        const manifest = join(candidate, 'package.json')
        if (!existsSync(manifest)) continue
        const meta = JSON.parse(readFileSync(manifest, 'utf8'))
        if (!meta.name || !meta.version) continue
        const key = `${meta.name}@${meta.version}`
        if (seen.has(key)) continue
        const license = readPackageLicense(meta)
        seen.set(key, {
          name: meta.name,
          version: meta.version,
          license,
          normalizedLicense: normalizeLicense(license),
          direct: directNames.has(meta.name),
        })
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

export interface LicensePolicyFile {
  schemaVersion: number
  projectLicense?: string
  allowed: string[]
  forbidden: string[]
  unknownRequiresReview?: boolean
  reviewedUnknown?: Record<string, string>
}

export interface LicenseGateResult {
  accepted: boolean
  violations: { component: string; license: string; reason: string }[]
  licensesObserved: string[]
}

const evaluateExpression = (
  expression: string,
  policy: LicensePolicyFile,
): 'allowed' | 'forbidden' | 'unknown' => {
  const cleaned = expression.replaceAll('(', '').replaceAll(')', '').trim()
  const verdictOf = (token: string): 'allowed' | 'forbidden' | 'unknown' => {
    const id = normalizeLicense(token.trim())
    if (policy.forbidden.includes(id)) return 'forbidden'
    if (policy.allowed.includes(id)) return 'allowed'
    return 'unknown'
  }
  if (cleaned.includes(' OR ')) {
    const verdicts = cleaned.split(' OR ').map(verdictOf)
    if (verdicts.includes('allowed')) return 'allowed'
    if (verdicts.includes('forbidden')) return 'forbidden'
    return 'unknown'
  }
  if (cleaned.includes(' AND ')) {
    const verdicts = cleaned.split(' AND ').map(verdictOf)
    if (verdicts.every((verdict) => verdict === 'allowed')) return 'allowed'
    if (verdicts.includes('forbidden')) return 'forbidden'
    return 'unknown'
  }
  return verdictOf(cleaned)
}

export const runLicenseGate = (
  components: DependencyComponent[],
  policy: LicensePolicyFile,
): LicenseGateResult => {
  if (!components.length)
    throw new Error('lisans gate: bileşen listesi boş; envanter üretilemedi')
  const violations: LicenseGateResult['violations'] = []
  for (const component of components) {
    const key = `${component.name}@${component.version}`
    const verdict = evaluateExpression(component.license, policy)
    if (verdict === 'forbidden')
      violations.push({
        component: key,
        license: component.license,
        reason: 'yasak lisans',
      })
    if (verdict === 'unknown') {
      const reviewed = policy.reviewedUnknown?.[key]
      if (policy.unknownRequiresReview !== false && !reviewed)
        violations.push({
          component: key,
          license: component.license,
          reason:
            'bilinmeyen lisans; infra/release/wp29-license-policy.v1.json reviewedUnknown kaydı ve gerekçe gerekir',
        })
    }
  }
  return {
    accepted: violations.length === 0,
    violations,
    licensesObserved: [
      ...new Set(components.map((c) => c.normalizedLicense)),
    ].sort(),
  }
}

const npmPurl = (name: string, version: string): string =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`

export const buildDependencySbom = (
  components: DependencyComponent[],
  project: { name: string; version: string; license: string },
): Record<string, unknown> => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': npmPurl(project.name, project.version),
      name: project.name,
      version: project.version,
      licenses: [{ license: { id: project.license } }],
    },
    // Deterministiklik için bilinçli olarak timestamp ve serialNumber yoktur.
    properties: [
      { name: 'persistent-codex:generator', value: 'wp31-release-lib' },
      { name: 'persistent-codex:deterministic', value: 'true' },
    ],
  },
  components: components.map((component) => ({
    type: 'library',
    'bom-ref': npmPurl(component.name, component.version),
    name: component.name,
    version: component.version,
    purl: npmPurl(component.name, component.version),
    licenses: [
      component.normalizedLicense === 'UNKNOWN'
        ? { license: { name: component.license } }
        : { license: { id: component.normalizedLicense } },
    ],
    properties: [
      { name: 'persistent-codex:direct', value: String(component.direct) },
    ],
  })),
})

export const buildLicenseReport = (
  components: DependencyComponent[],
  policy: LicensePolicyFile,
): Record<string, unknown> => {
  const byLicense: Record<string, string[]> = {}
  for (const component of components) {
    const key = component.normalizedLicense
    byLicense[key] ??= []
    byLicense[key].push(`${component.name}@${component.version}`)
  }
  return {
    schemaVersion: 1,
    projectLicense: policy.projectLicense ?? 'UNKNOWN',
    componentCount: components.length,
    directCount: components.filter((component) => component.direct).length,
    licenses: Object.fromEntries(
      Object.entries(byLicense)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([license, packages]) => [license, packages.sort()]),
    ),
  }
}

export const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`

// --- Hijyen dosyaları ---

export const REQUIRED_HYGIENE_FILES: { path: string; mustContain?: string }[] =
  [
    { path: 'LICENSE', mustContain: 'GNU AFFERO GENERAL PUBLIC LICENSE' },
    { path: 'NOTICE', mustContain: 'Persistent Codex Workspace' },
    { path: 'README.md', mustContain: 'AGPL-3.0-only' },
    { path: 'SECURITY.md', mustContain: 'kivancguckiran@gmail.com' },
    { path: 'CONTRIBUTING.md', mustContain: 'pnpm install --frozen-lockfile' },
    { path: 'CODE_OF_CONDUCT.md' },
    { path: 'SUPPORT.md' },
    { path: 'docs/architecture/adr-0031-open-source-license.md' },
    { path: 'docs/policies/brand-and-endorsement-policy.md' },
    {
      path: 'docs/security/provider-binary-and-sdk-distribution-boundaries.md',
    },
    {
      path: 'docs/operations/public-release-checklist.md',
      mustContain: 'wp29:signatures',
    },
  ]

export const checkHygieneFiles = (root: string): string[] => {
  const problems: string[] = []
  for (const requirement of REQUIRED_HYGIENE_FILES) {
    const absolute = join(root, requirement.path)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      problems.push(`${requirement.path}: eksik`)
      continue
    }
    const text = readFileSync(absolute, 'utf8')
    if (!text.trim()) {
      problems.push(`${requirement.path}: boş`)
      continue
    }
    if (requirement.mustContain && !text.includes(requirement.mustContain))
      problems.push(
        `${requirement.path}: beklenen içerik eksik (${requirement.mustContain})`,
      )
  }
  return problems
}
