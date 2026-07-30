// WP32 — statik kabul katmanı: gerçek dağıtım dosyaları üzerinde deterministik
// invariant testleri (her ortamda koşar; Docker gerektirmez).
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WP32_PINNED_IMAGE_PATTERN,
  WP32_REQUIRED_FILES,
  WP32_REQUIRED_SERVICES,
  checkComposeFile,
  checkImagesEnv,
  checkShellScript,
  extractComposeServices,
  extractShellFunction,
  parseEnvFile,
  scanForCredentials,
  summarizeGates,
  wp32StaticScanPolicy,
} from './wp32-lib'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('wp32 dağıtım dosyaları', () => {
  it('gerekli tüm dosyalar mevcut', () => {
    const missing = WP32_REQUIRED_FILES.filter(
      (path) => !existsSync(resolve(root, path)),
    )
    expect(missing).toEqual([])
  })

  it('images.env tüm imajları sürüm+digest ile pinler', () => {
    expect(checkImagesEnv(read('infra/self-hosted/images.env'))).toEqual([])
  })

  it('compose profili güvenli default invariantlarını sağlar', () => {
    expect(checkComposeFile(read('infra/self-hosted/compose.yml'))).toEqual([])
  })

  it('compose gerekli tüm servisleri içerir', () => {
    const services = extractComposeServices(
      read('infra/self-hosted/compose.yml'),
    ).map((service) => service.name)
    for (const required of WP32_REQUIRED_SERVICES)
      expect(services).toContain(required)
  })

  it('compose yalnız proxy üzerinden 80/443 yayınlar', () => {
    const services = extractComposeServices(
      read('infra/self-hosted/compose.yml'),
    )
    for (const service of services) {
      if (service.name === 'proxy') {
        expect(service.body).toMatch(/:80:80/)
        expect(service.body).toMatch(/:443:443/)
      } else {
        expect(service.body).not.toMatch(/^\s+ports:/m)
      }
    }
  })

  it('broker healthcheck Erlang cookie hazırlığını bekler', () => {
    const broker = extractComposeServices(
      read('infra/self-hosted/compose.yml'),
    ).find((service) => service.name === 'broker')
    expect(broker?.body).toContain('start_period: 30s')
  })

  it('kabuk scriptleri fail-closed hijyenine uyar', () => {
    for (const script of [
      'infra/self-hosted/self-hosted.sh',
      'infra/self-hosted/lib.sh',
      'infra/self-hosted/release/build-release.sh',
      'infra/self-hosted/postgres/apply-migrations.sh',
    ])
      expect(checkShellScript(read(script), script)).toEqual([])
  })

  it('self-hosted.sh sözdizimsel olarak geçerli (bash -n)', () => {
    for (const script of [
      'infra/self-hosted/self-hosted.sh',
      'infra/self-hosted/lib.sh',
      'infra/self-hosted/release/build-release.sh',
    ])
      execFileSync('bash', ['-n', resolve(root, script)])
    execFileSync('sh', [
      '-n',
      resolve(root, 'infra/self-hosted/postgres/apply-migrations.sh'),
    ])
  })

  it('release manifesti package sürümünü ve uzun ömürlü deterministik trust epochunu taşır', () => {
    const release = read('infra/self-hosted/release/build-release.sh')
    const images = read('infra/self-hosted/images.env')
    expect(release).toContain('"version"')
    expect(release).toContain('SOURCE_DATE_EPOCH=1785369600')
    expect(release).toContain('releaseVersion: process.env.RELEASE_VERSION')
    expect(release).toContain('5 * 365 * 24 * 3600')
    expect(release).toContain('linux/amd64) suffix=linux-amd64')
    expect(release).toContain('linux/arm64) suffix=linux-arm64')
    expect(release).toContain('artifact="product-${suffix}.tar"')
    expect(release).toContain('type=docker')
    expect(release).toContain('--driver docker-container')
    expect(release).toContain('SELF_HOSTED_RELEASE_BUILDKIT_IMAGE')
    for (const sourceDirectory of ['apps', 'agents', 'packages', 'services'])
      expect(release).toMatch(
        new RegExp(`(?:^|\\s)${sourceDirectory}(?:\\s|$)`),
      )
    expect(release).toContain('SELF_HOSTED_TAR_IMAGE')
    expect(release).not.toMatch(/^tar --sort=name/m)
    expect(images).toMatch(
      /^SELF_HOSTED_TAR_IMAGE=debian:bookworm-slim@sha256:[a-f0-9]{64}$/m,
    )
    expect(images).toMatch(
      /^SELF_HOSTED_RELEASE_BUILDKIT_IMAGE=moby\/buildkit:buildx-stable-1@sha256:[a-f0-9]{64}$/m,
    )
    const validUntil = (1785369600 + 5 * 365 * 24 * 3600) * 1000
    expect(validUntil).toBeGreaterThan(Date.parse('2031-01-01T00:00:00Z'))
  })

  it('bundle kurulumu manifest commitini ve mimariye özel Docker archiveı kullanır', () => {
    const script = read('infra/self-hosted/self-hosted.sh')
    const install = extractShellFunction(script, 'cmd_install')
    expect(script).toContain('product-linux-amd64.tar')
    expect(script).toContain('product-linux-arm64.tar')
    expect(script).toContain('docker load --input')
    expect(script).toContain('release_manifest_value')
    expect(install).toContain('load_release_product_image')
    expect(install).not.toContain('echo bundle')
  })

  it('yedek, provider credential volumeunu yalnız açık bayrakla içerir', () => {
    const backup = extractShellFunction(
      read('infra/self-hosted/self-hosted.sh'),
      'cmd_backup',
    )
    expect(backup).toContain('--include-provider-credentials')
    const guarded =
      /if \[ "\$\{include_credentials\}" = 1 \]; then[\s\S]*?codex-home\.tar[\s\S]*?fi/
    expect(backup).toMatch(guarded)
    // codex-home arşivi guard dışında geçmemeli
    const outsideGuard = backup.replace(guarded, '')
    expect(outsideGuard).not.toContain('codex-home.tar')
  })

  it('yedek arşivi her durumda şifrelenir', () => {
    const backup = extractShellFunction(
      read('infra/self-hosted/self-hosted.sh'),
      'cmd_backup',
    )
    expect(backup).toContain('openssl enc -aes-256-cbc -pbkdf2')
    expect(backup).toContain('file:$(secrets_dir)/backup-key')
  })

  it('uninstall varsayılanı export almaktır (uninstall-with-export)', () => {
    const uninstall = extractShellFunction(
      read('infra/self-hosted/self-hosted.sh'),
      'cmd_uninstall',
    )
    expect(uninstall).toContain('--export')
    expect(uninstall).toContain('--skip-export')
    expect(uninstall).toContain('labeled_resources')
  })

  it('migration runner tracking tablosu ve fail-closed sha256 kontrolü içerir', () => {
    const runner = read('infra/self-hosted/postgres/apply-migrations.sh')
    expect(runner).toContain('persistent_codex_ops.schema_migrations')
    expect(runner).toContain('FAIL-CLOSED')
    expect(runner).toContain('ON_ERROR_STOP=1')
  })

  it('product.Dockerfile digest-pinli base, non-root ve placeholder origin kullanır', () => {
    const dockerfile = read('infra/self-hosted/product.Dockerfile')
    for (const from of dockerfile.matchAll(/^FROM\s+(\S+)/gm))
      expect(from[1]).toMatch(/@sha256:[0-9a-f]{64}/)
    expect(dockerfile).toContain('USER 10001:10001')
    expect(dockerfile).toContain('SOURCE_DATE_EPOCH')
    expect(dockerfile).toContain(
      'VITE_CONTROL_PLANE_URL=https://public-origin.invalid',
    )
    for (const tool of [
      'bash=5.3.9-r1',
      'git=2.54.0-r0',
      'openssh-client-default=10.3_p1-r0',
      'ripgrep=15.1.0-r0',
    ])
      expect(dockerfile).toContain(tool)
    expect(dockerfile).toContain('mkdir -p /codex-home /workspace')
    expect(dockerfile).toContain('chown 10001:10001 /codex-home /workspace')
  })

  it('workspace import canonical Git worktree, read-only bind ve explicit replace uygular', () => {
    const script = read('infra/self-hosted/self-hosted.sh')
    const workspaceImport = extractShellFunction(script, 'cmd_workspace_import')
    expect(workspaceImport).toContain('pwd -P')
    expect(workspaceImport).toContain('/.git')
    expect(workspaceImport).toContain(':/import:ro')
    expect(workspaceImport).toContain('--replace')
    expect(workspaceImport).toContain('chown -R 10001:10001')
    expect(workspaceImport).toContain('git -C /workspace rev-parse')
    expect(script).toContain('prepare_workspace_volume')
  })

  it('identity servisi ağ üzerinden token basmaz (mint yalnız CLI)', () => {
    const identity = read('infra/self-hosted/identity/identity-service.mjs')
    expect(identity).toContain("if (request.method !== 'GET')")
    expect(identity).not.toContain("request.url === '/mint'")
    expect(identity).toContain("mode === 'mint'")
  })

  it('Caddyfile şablonu TLS zorunlu yönlendirme ve güvenlik başlıkları içerir', () => {
    const caddyfile = read('infra/self-hosted/config/Caddyfile.tmpl')
    expect(caddyfile).toContain('redir https://@@DOMAIN@@{uri} 308')
    expect(caddyfile).toContain('Strict-Transport-Security')
    expect(caddyfile).toContain('reverse_proxy control-plane:3300')
    expect(caddyfile).toContain('reverse_proxy web:3301')
  })

  it('runbooklar tek komut kurulumu ve backup anahtarı uyarısını belgeler', () => {
    const install = read('docs/operations/self-hosted-install-runbook.md')
    expect(install).toContain('self-hosted.sh install')
    const backupRestore = read(
      'docs/operations/self-hosted-backup-restore-runbook.md',
    )
    expect(backupRestore).toContain('backup-key')
  })
})

describe('wp32-lib fonksiyonları', () => {
  it('parseEnvFile yorum ve boş satırları atlar', () => {
    expect(parseEnvFile('# yorum\nA=1\n\nB=x=y\n')).toEqual({
      A: '1',
      B: 'x=y',
    })
  })

  it('pin deseni yalnız digest içeren referansları kabul eder', () => {
    expect(
      WP32_PINNED_IMAGE_PATTERN.test(`caddy:2.10.2@sha256:${'a'.repeat(64)}`),
    ).toBe(true)
    expect(WP32_PINNED_IMAGE_PATTERN.test('caddy:2.10.2')).toBe(false)
    expect(WP32_PINNED_IMAGE_PATTERN.test('caddy:latest')).toBe(false)
  })

  it('checkImagesEnv digest içermeyen imajı reddeder', () => {
    const problems = checkImagesEnv('SELF_HOSTED_CADDY_IMAGE=caddy:latest\n')
    expect(problems).toHaveLength(1)
  })

  it('checkComposeFile plaintext secret ve serbest port yayınını yakalar', () => {
    const bad = [
      'services:',
      '  rogue:',
      '    image: nginx:latest',
      '    ports:',
      "      - '8080:80'",
      '    environment:',
      '      ADMIN_PASSWORD: hunter2-super-secret',
      '',
    ].join('\n')
    const problems = checkComposeFile(bad)
    expect(
      problems.some((problem) => problem.includes('plaintext secret')),
    ).toBe(true)
    expect(
      problems.some((problem) => problem.includes('port yayınlıyor')),
    ).toBe(true)
    expect(problems.some((problem) => problem.includes('images.env'))).toBe(
      true,
    )
  })

  it('checkShellScript curl|sh desenini reddeder', () => {
    const problems = checkShellScript(
      '#!/usr/bin/env bash\nset -euo pipefail\ncurl https://x.sh | bash\n',
      'kötü.sh',
    )
    expect(problems.some((problem) => problem.includes('curl|sh'))).toBe(true)
  })

  it('scanForCredentials codex auth.json sızıntısını yakalar ve redakte eder', () => {
    const findings = scanForCredentials([
      {
        name: 'log.txt',
        content: `{"access_token":"${'a'.repeat(40)}"}`,
      },
    ])
    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(finding.redacted).toMatch(/…\[len:\d+\]$/)
      expect(finding.redacted.length).toBeLessThan(30)
    }
  })

  it('scanForCredentials temiz içerikte bulgu üretmez', () => {
    expect(
      scanForCredentials([{ name: 'ok.txt', content: 'merhaba dünya\n' }]),
    ).toEqual([])
  })

  it('statik tarama: dağıtım kaynakları plaintext credential içermez', () => {
    const sources = WP32_REQUIRED_FILES.map((path) => ({
      name: path,
      content: read(path),
    }))
    expect(scanForCredentials(sources, wp32StaticScanPolicy)).toEqual([])
  })

  it('allowlist gerçek bir secret değerini geçirmez', () => {
    const findings = scanForCredentials(
      [
        {
          name: 'bad.env',
          content: 'password="hunter2-hunter2-hunter2"\n',
        },
      ],
      wp32StaticScanPolicy,
    )
    expect(findings.length).toBeGreaterThan(0)
  })

  it('summarizeGates not-run sonucu asla başarıya terfi ettirmez', () => {
    const summary = summarizeGates([
      { gate: 'wp32:test', accepted: true, status: 'passed' },
      { gate: 'wp32:install-smoke', accepted: false, status: 'not-run' },
    ])
    expect(summary.accepted).toBe(false)
    expect(summary.notRun).toBe(1)
  })
})
