// Deterministic self-hosted release validation library (ADR-0032).
// Yan etkisizdir; compose/env/script invariant kontrolleri ve credential tarama
// kuralları burada yaşar. self-hosted-release-lib.test.ts bu kontrolleri gerçek dağıtım
// dosyalarına karşı koşar (her ortamda çalışan statik kabul katmanı).
import {
  scanContent,
  type SecretFinding,
  type SecretPolicy,
} from './public-release-lib'

export const SELF_HOSTED_RELEASE_LONG_RUNNING_SERVICES = [
  'proxy',
  'postgres',
  'object-storage',
  'broker',
  'content-key-broker',
  'identity',
  'workspace-agent',
  'control-plane',
  'web',
] as const

export const SELF_HOSTED_RELEASE_OPS_SERVICES = [
  'migrate',
  'bootstrap',
  'ops-shell',
] as const

export const SELF_HOSTED_RELEASE_REQUIRED_SERVICES = [
  ...SELF_HOSTED_RELEASE_LONG_RUNNING_SERVICES,
  ...SELF_HOSTED_RELEASE_OPS_SERVICES,
] as const

export const SELF_HOSTED_RELEASE_PINNED_IMAGE_PATTERN =
  /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/

export const parseEnvFile = (text: string): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return values
}

export const checkImagesEnv = (text: string): string[] => {
  const problems: string[] = []
  const values = parseEnvFile(text)
  const entries = Object.entries(values).filter(([key]) =>
    /^SELF_HOSTED_[A-Z_]*_IMAGE$/.test(key),
  )
  if (entries.length === 0) problems.push('images.env: hiç imaj tanımı yok')
  for (const [key, value] of entries) {
    if (!SELF_HOSTED_RELEASE_PINNED_IMAGE_PATTERN.test(value))
      problems.push(`images.env: ${key} sürüm+digest pinli değil: ${value}`)
  }
  return problems
}

export interface ComposeService {
  name: string
  body: string
}

export const extractComposeServices = (
  composeText: string,
): ComposeService[] => {
  const lines = composeText.split('\n')
  const services: ComposeService[] = []
  let inServices = false
  let current: { name: string; lines: string[] } | undefined
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true
      continue
    }
    if (inServices && /^[a-zA-Z]/.test(line)) {
      // services bloğu bitti (yeni top-level anahtar)
      if (current)
        services.push({ name: current.name, body: current.lines.join('\n') })
      current = undefined
      inServices = false
      continue
    }
    if (!inServices) continue
    const serviceHeader = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)
    if (serviceHeader?.[1]) {
      if (current)
        services.push({ name: current.name, body: current.lines.join('\n') })
      current = { name: serviceHeader[1], lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  if (current)
    services.push({ name: current.name, body: current.lines.join('\n') })
  return services
}

export const checkComposeFile = (composeText: string): string[] => {
  const problems: string[] = []
  const services = extractComposeServices(composeText)
  const names = new Set(services.map((service) => service.name))

  for (const required of SELF_HOSTED_RELEASE_REQUIRED_SERVICES)
    if (!names.has(required))
      problems.push(`compose: servis eksik: ${required}`)

  for (const service of services) {
    const image = /image:\s*(\S+)/.exec(service.body)?.[1]
    const usesAnchor = service.body.includes('<<: *product')
    if (!usesAnchor) {
      if (!image) {
        problems.push(`compose: ${service.name} için image tanımı yok`)
      } else if (!/^\$\{SELF_HOSTED_[A-Z_]*IMAGE\}$/.test(image)) {
        problems.push(
          `compose: ${service.name} imajı images.env değişkeni üzerinden pinli olmalı: ${image}`,
        )
      }
    }
    if (service.name !== 'proxy' && /^\s+ports:/m.test(service.body))
      problems.push(
        `compose: yalnız proxy dışa port açabilir; ${service.name} port yayınlıyor`,
      )
    const isLongRunning = (
      SELF_HOSTED_RELEASE_LONG_RUNNING_SERVICES as readonly string[]
    ).includes(service.name)
    if (isLongRunning) {
      if (!service.body.includes('healthcheck:'))
        problems.push(`compose: ${service.name} healthcheck tanımlamalı`)
      if (!service.body.includes('restart: unless-stopped') && !usesAnchor)
        problems.push(`compose: ${service.name} restart: unless-stopped olmalı`)
    }
    if (
      (SELF_HOSTED_RELEASE_OPS_SERVICES as readonly string[]).includes(
        service.name,
      )
    ) {
      if (!/profiles:\s*\n\s+- ops/.test(service.body))
        problems.push(`compose: ${service.name} yalnız ops profilinde olmalı`)
    }
    for (const match of service.body.matchAll(
      /^\s+[A-Z_]*(?:PASSWORD|SECRET|TOKEN)[A-Z_]*:\s*(.+)$/gm,
    )) {
      const value = (match[1] ?? '').trim()
      if (!value.startsWith('$') && !value.startsWith('/run/secrets/'))
        problems.push(
          `compose: ${service.name} içinde plaintext secret değeri görünüyor`,
        )
    }
  }

  if (!composeText.includes("persistent.self-hosted: 'true'"))
    problems.push(
      'compose: persistent.self-hosted etiketi (yaşam döngüsü keşfi) eksik',
    )
  return problems
}

export const checkShellScript = (text: string, name: string): string[] => {
  const problems: string[] = []
  const isPosixSh = text.startsWith('#!/bin/sh')
  if (isPosixSh) {
    if (!text.includes('set -eu'))
      problems.push(`${name}: set -eu zorunlu (fail-closed)`)
  } else if (!text.includes('set -euo pipefail') && !text.includes('lib.sh')) {
    problems.push(`${name}: set -euo pipefail zorunlu (fail-closed)`)
  }
  if (/curl[^\n]*\|\s*(?:ba)?sh/.test(text))
    problems.push(
      `${name}: curl|sh deseni yasak (doğrulanmamış kod çalıştırma)`,
    )
  return problems
}

export const extractShellFunction = (
  script: string,
  functionName: string,
): string => {
  const lines = script.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${functionName}()`))
  if (start === -1) return ''
  const end = lines.findIndex(
    (line, index) => index > start && /^\}\s*$/.test(line),
  )
  return lines.slice(start, end === -1 ? lines.length : end + 1).join('\n')
}

// Codex/provider credential'larına özgü ek tarama kuralları; public-release builtin
// kurallarının üzerine eklenir (auth.json içerik işaretleri, device-code
// token'ları, OPENAI anahtarları zaten builtin'de).
export const selfHostedCredentialRules = [
  {
    id: 'self-hosted-release-codex-auth-json',
    description:
      'codex auth.json içerik işareti (access/refresh token gövdesi); ' +
      'yol/isim referansları değil, gerçek token değerleri hedeflenir',
    pattern:
      /"(?:OPENAI_API_KEY|access_token|refresh_token|id_token)"\s*:\s*"[A-Za-z0-9._~+/-]{16,}"/g,
  },
] as const

export interface Wp32ScanSource {
  name: string
  content: string
}

// Statik dağıtım taraması için gerekçeli allowlist (public-release policy: her giriş
// açıklama taşır). Yalnız değişken-referansı desenleri; gerçek secret değerleri
// allowlist'e giremez.
export const selfHostedStaticScanPolicy: SecretPolicy = {
  title: 'self-hosted-release-static-distribution-scan',
  rules: [],
  allowlists: [
    {
      description:
        'psql değişken indirection: ALTER ROLE ... PASSWORD :var ve -v var="${ENV}" ' +
        'desenleri secret değeri değil değişken adı taşır (apply-migrations.sh, init-runtime-role.sql)',
      paths: [],
      regexes: [
        /self_hosted_runtime_password/,
        /\$\{RUNTIME_PASSWORD\}/,
        /\$\{SELF_HOSTED_[A-Z_]+\}/,
      ],
    },
    {
      description:
        'self-hosted auth login formu: HTML autocomplete belirteçleri (current-password/' +
        'new-password) tarayıcı parola yöneticisi ipuçlarıdır; secret değeri değildir',
      paths: [],
      regexes: [/current-password|new-password/],
    },
  ],
}

export const scanForCredentials = (
  sources: readonly Wp32ScanSource[],
  policy?: SecretPolicy,
): SecretFinding[] => {
  // scanContent builtin kuralları her zaman uygular; varsayılan policy yalnız
  // boş ek kural/allowlist taşır.
  const effectivePolicy: SecretPolicy = policy ?? { rules: [], allowlists: [] }
  const findings = sources.flatMap((source) =>
    scanContent(source.name, source.content, effectivePolicy),
  )
  for (const source of sources)
    for (const rule of selfHostedCredentialRules) {
      rule.pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = rule.pattern.exec(source.content)) !== null) {
        const value = match[0]
        findings.push({
          ruleId: rule.id,
          path: source.name,
          blob: 'self-hosted-release-scan',
          redacted: `${value.slice(0, 4)}…[len:${value.length}]`,
        })
      }
    }
  return findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.redacted.localeCompare(b.redacted),
  )
}

export const SELF_HOSTED_RELEASE_REQUIRED_FILES = [
  'ARCHITECTURE.md',
  'infra/self-hosted/README.md',
  'infra/self-hosted/compose.yml',
  'infra/self-hosted/images.env',
  'infra/self-hosted/product.Dockerfile',
  'infra/self-hosted/self-hosted.sh',
  'infra/self-hosted/lib.sh',
  'infra/self-hosted/config/Caddyfile.tmpl',
  'infra/self-hosted/config/self-hosted.env.example',
  'infra/self-hosted/identity/identity-service.mjs',
  'infra/self-hosted/web/self-hosted-web-server.mjs',
  'infra/self-hosted/postgres/apply-migrations.sh',
  'infra/self-hosted/postgres/init-runtime-role.sql',
  'infra/self-hosted/bootstrap/self-hosted-bootstrap.ts',
  'infra/self-hosted/release/build-release.sh',
  // self-hosted auth — kullanıcı hesapları ve parola-türevli mahremiyet (ADR-0037):
  // yeni auth/kripto kaynakları da statik credential taramasına dahildir.
  'infra/postgres/migrations/0038_wp37_user_accounts.sql',
  'services/control-plane/src/self-hosted-auth.ts',
  'services/control-plane/src/self-hosted-auth-api.ts',
  'services/control-plane/src/self-hosted-auth-composition.ts',
  'services/control-plane/src/content-key-lease-client.ts',
  'services/control-plane/src/self-hosted-provisioning.ts',
  'services/control-plane/src/user-content-crypto.ts',
  'services/content-key-broker/src/server.ts',
  'services/content-key-broker/src/entrypoint.ts',
  'apps/web/src/self-hosted-auth.ts',
  'apps/web/src/login-page.tsx',
] as const

export const SELF_HOSTED_RELEASE_GATES = [
  'self-hosted release:test',
  'self-hosted release:preflight',
  'self-hosted release:install-smoke',
  'self-hosted release:lifecycle',
  'self-hosted release:credential-scan',
  'self-hosted release:golden',
] as const

export interface SelfHostedReleaseGateResult {
  gate: string
  accepted: boolean
  status: 'passed' | 'not-run' | 'failed'
  [key: string]: unknown
}

export const summarizeGates = (
  results: readonly SelfHostedReleaseGateResult[],
) => ({
  total: results.length,
  passed: results.filter((result) => result.status === 'passed').length,
  notRun: results.filter((result) => result.status === 'not-run').length,
  failed: results.filter((result) => result.status === 'failed').length,
  // not-run hiçbir zaman başarıya terfi etmez (fail-closed).
  accepted: results.every((result) => result.status === 'passed'),
})
