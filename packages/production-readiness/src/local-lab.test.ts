import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertLocalInvariant,
  assertLocalUrl,
  parseEnv,
  validatePinnedImagePlatform,
} from '../../../scripts/wp30-local'

describe('WP30-L local acceptance contract', () => {
  it('accepts only loopback and reviewed Docker-internal targets', () => {
    expect(assertLocalUrl('target', 'http://127.0.0.1:3300').hostname).toBe(
      '127.0.0.1',
    )
    expect(assertLocalUrl('target', 'http://control-plane:3300').hostname).toBe(
      'control-plane',
    )
    for (const value of [
      'https://example.com',
      'http://0.0.0.0:3300',
      'http://192.168.1.4',
    ])
      expect(() => assertLocalUrl('target', value)).toThrow(
        /loopback\/internal/,
      )
  })

  it('makes local evidence and external readiness immutable invariants', () => {
    expect(() =>
      assertLocalInvariant({
        WP30_EVIDENCE_CLASS: 'local-operator',
        WP30_EXTERNAL_PRODUCTION_READY: 'false',
        WP30_TARGET_SCOPE: 'loopback-only',
      }),
    ).not.toThrow()
    expect(() =>
      assertLocalInvariant({
        WP30_EVIDENCE_CLASS: 'independent',
        WP30_EXTERNAL_PRODUCTION_READY: 'true',
        WP30_TARGET_SCOPE: 'public',
      }),
    ).toThrow()
  })

  it('pins every scanner image by tag and digest and labels every lab resource', () => {
    const images = parseEnv(
      readFileSync(resolve('infra/wp30-local/images.env'), 'utf8'),
    )
    expect(Object.keys(images).sort()).toEqual([
      'WP30_K6_IMAGE',
      'WP30_NUCLEI_IMAGE',
      'WP30_ZAP_IMAGE',
    ])
    for (const image of Object.values(images))
      expect(image).toMatch(/:[^@]+@sha256:[a-f0-9]{64}$/)
    const zapManifest = JSON.parse(
      readFileSync(resolve('infra/wp30-local/zap-image-manifest.json'), 'utf8'),
    )
    expect(zapManifest.image).toBe(images.WP30_ZAP_IMAGE)
    expect(zapManifest.platforms.map(({ platform }: any) => platform)).toEqual([
      'linux/amd64',
      'linux/arm64',
    ])
    const compose = readFileSync(
      resolve('infra/wp30-local/compose.yml'),
      'utf8',
    )
    expect(compose).toMatch(/persistent\.wp30\.local: ['"]true['"]/)
    expect(compose).toContain('127.0.0.1:3300:3300')
    expect(compose).not.toMatch(/(?:^|["'])0\.0\.0\.0:/m)
    expect(
      readFileSync(resolve('scripts/wp30-local-lab.ts'), 'utf8'),
    ).toContain('product.Dockerfile')
    expect(compose).toContain("command: ['node', '/app/control-plane.mjs']")
    expect(compose).toContain("command: ['node', '/app/workspace-agent.mjs']")
    expect(compose).toContain(
      "command: ['node', '/app/web-production-server.mjs']",
    )
    expect(compose).not.toContain('fixture-server.mjs')
  })

  it('rejects a ZAP image whose local platform does not match the host', () => {
    const image =
      'ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2'
    const manifest = {
      image,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      indexDigest:
        'sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2',
      platforms: [
        {
          platform: 'linux/amd64',
          digest:
            'sha256:c558ee87358911ab17278c70991e856f57793e115d9cd0f88ca475cf82907a1a',
        },
        {
          platform: 'linux/arm64',
          digest:
            'sha256:1110082c94217b6e9592b18934740108839a44c02f1d0e961e4933bbb98bab45',
        },
      ],
    }
    expect(
      validatePinnedImagePlatform({
        image,
        manifest,
        hostPlatform: 'linux/aarch64',
        imagePlatform: 'linux/arm64',
      }),
    ).toMatchObject({
      hostPlatform: 'linux/arm64',
      imagePlatform: 'linux/arm64',
      platformManifestDigest: manifest.platforms[1]!.digest,
    })
    expect(() =>
      validatePinnedImagePlatform({
        image,
        manifest,
        hostPlatform: 'linux/aarch64',
        imagePlatform: 'linux/amd64',
      }),
    ).toThrow(/does not match host/)
  })

  it('retains redacted raw evidence and makes cleanup a report gate', () => {
    const acceptance = readFileSync(
      resolve('scripts/wp30-local-accept.ts'),
      'utf8',
    )
    expect(acceptance).toContain("record('wp30:lab:down'")
    expect(acceptance).toContain('assert(cleaned')
    expect(acceptance).toContain('rawEvidence: embeddedRawEvidence')
    expect(acceptance).toContain('signatureVerified')
    expect(acceptance).toContain('runZapScan')
    expect(acceptance.indexOf("browser('snapshot')")).toBeLessThan(
      acceptance.indexOf("['screenshot', screenshotPath]"),
    )
    expect(acceptance).toContain("'browser/screenshot.log'")
    expect(acceptance).not.toContain('tenantMixing: 0')
    expect(acceptance).not.toContain('dataLoss: 0')
  })

  it('keeps generated credentials outside the repository contract', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp30-local-'))
    const path = join(directory, 'local.env')
    writeFileSync(path, 'TOKEN=local-secret\n', { mode: 0o600 })
    chmodSync(path, 0o600)
    expect(parseEnv(readFileSync(path, 'utf8'))).toEqual({
      TOKEN: 'local-secret',
    })
    rmSync(directory, { recursive: true })
  })

  it('keeps local authority fields explicit and does not modify production acceptance', () => {
    const local = readFileSync(resolve('scripts/wp30-local-accept.ts'), 'utf8')
    for (const field of [
      "status: 'accepted-local-production-like'",
      'engineeringComplete: true',
      'externalProductionReady: false',
      "evidenceClass: 'local-operator'",
      "targetScope: 'loopback-only'",
      "independentPentest: 'not-run'",
      "multiRegionFailover: 'not-run'",
      "productionKmsFailure: 'not-run'",
      "realPushBillingFailure: 'not-run'",
    ])
      expect(local).toContain(field)
    const packageJson = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8'),
    )
    expect(packageJson.scripts['production:accept']).toBe(
      'node --import tsx scripts/wp30-accept.ts',
    )
  })
})
