import { describe, expect, it } from 'vitest'
import {
  advanceMigration,
  appendEvidence,
  canonicalJson,
  createBuildManifest,
  createCycloneDxSbom,
  createEphemeralTestSigner,
  createProvenance,
  evaluateCanary,
  evaluateSecurityGate,
  lintMigration,
  sha256,
  signPayload,
  transitionRollout,
  verifyReleaseAdmission,
  verifySignature,
  type ArtifactKind,
  type RolloutRecord,
  type SignedRelease,
} from './index'

const artifacts = (
  Object.keys({
    web: 1,
    'control-plane': 1,
    'workspace-agent': 1,
    'runtime-image': 1,
  }) as ArtifactKind[]
).map((name) => ({
  name,
  mediaType: 'application/vnd.wp29',
  sha256: sha256(name),
  byteLength: name.length,
}))

const manifest = createBuildManifest({
  repository: 'persistent-codex-workspace',
  sourceCommit: 'a'.repeat(40),
  sourceDirty: false,
  sourceMode: 'production',
  builderIdentity: 'wp29-builder-v1',
  platform: 'linux/arm64',
  dependencyLockSha256: 'b'.repeat(64),
  protocolSchemaSha256: 'c'.repeat(64),
  buildCommand: 'pnpm wp29:reproducible-build',
  sourceDateEpoch: 1_753_056_000,
  artifacts,
})

describe('WP29 supply-chain authority', () => {
  it('canonicalizes objects and rejects dirty production builds', () => {
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}')
    expect(() =>
      createBuildManifest({ ...manifest, sourceDirty: true }),
    ).toThrow('DIRTY_PRODUCTION_SOURCE')
  })

  it('cryptographically admits only exact signed provenance', () => {
    const signer = createEphemeralTestSigner()
    const sbom = createCycloneDxSbom([])
    const provenance = createProvenance(manifest)
    const release: SignedRelease = {
      manifest,
      manifestSignature: signPayload(manifest, signer),
      sbom,
      sbomSignature: signPayload(sbom, signer),
      provenance,
      provenanceSignature: signPayload(provenance, signer),
    }
    const expected = Object.fromEntries(
      artifacts.map(({ name, sha256: digest }) => [name, digest]),
    ) as Record<ArtifactKind, string>
    expect(
      verifyReleaseAdmission(release, {
        repository: 'persistent-codex-workspace',
        sourceCommit: manifest.sourceCommit,
        artifactDigests: expected,
        trustedSigner: signer.identity,
      }).admitted,
    ).toBe(true)
    expect(() =>
      verifyReleaseAdmission(
        { ...release, manifest: { ...manifest, repository: 'attacker/repo' } },
        {
          repository: 'persistent-codex-workspace',
          sourceCommit: manifest.sourceCommit,
          artifactDigests: expected,
          trustedSigner: signer.identity,
        },
      ),
    ).toThrow('WRONG_PROVENANCE_REPOSITORY')
    expect(() =>
      verifySignature(
        { ...manifest, sourceCommit: 'd'.repeat(40) },
        release.manifestSignature,
        signer.identity,
      ),
    ).toThrow('SIGNED_PAYLOAD_DIGEST_MISMATCH')
    expect(() =>
      verifySignature(manifest, release.manifestSignature, {
        ...signer.identity,
        revokedAt: '2026-07-21T00:05:00.000Z',
      }),
    ).toThrow('SIGNER_REVOKED')
  })

  it('fails closed on missing scanners and exploitable high findings', () => {
    expect(() => evaluateSecurityGate([], [])).toThrow('SCANNER_MISSING')
    expect(() =>
      evaluateSecurityGate(
        [
          {
            scanner: 'vulnerability',
            scannerVersion: '1',
            status: 'passed',
            inputSha256: sha256('input'),
            findings: [
              {
                scanner: 'vulnerability',
                ruleId: 'CVE-TEST',
                severity: 'high',
                subject: 'fixture@1',
                exploitable: true,
              },
            ],
          },
        ],
        [],
      ),
    ).toThrow('SECURITY_POLICY_BLOCKED:CVE-TEST')
  })

  it('lints destructive and tenant-unsafe migrations', () => {
    const findings = lintMigration(
      'CREATE TABLE public.bad (id text);\nDROP TABLE public.old;\nTRUNCATE public.x;',
    )
    expect(findings.map(({ ruleId }) => ruleId)).toEqual(
      expect.arrayContaining([
        'TENANT_KEY_MISSING',
        'RLS_MISSING',
        'DESTRUCTIVE_DROP',
        'DESTRUCTIVE_TRUNCATE',
      ]),
    )
  })

  it('requires N/N-1 compatibility and drain evidence before contract', () => {
    const base = {
      phase: 'expand' as const,
      nReader: true,
      nWriter: true,
      nMinusOneReader: true,
      nMinusOneWriter: true,
      oldReaders: 1,
      oldWriters: 1,
      drainEvidenceSha256: null,
    }
    let state = advanceMigration(base, 'dual-read-write')
    state = advanceMigration(state, 'backfill')
    state = advanceMigration(state, 'validate')
    state = advanceMigration(state, 'contract-ready')
    expect(() => advanceMigration(state, 'contracted')).toThrow(
      'OLD_RUNTIME_NOT_DRAINED',
    )
    expect(
      advanceMigration(
        {
          ...state,
          oldReaders: 0,
          oldWriters: 0,
          drainEvidenceSha256: sha256('drained'),
        },
        'contracted',
      ).phase,
    ).toBe('contracted')
  })

  it('halts unhealthy canaries and rolls back with CAS/idempotency', () => {
    const healthy = evaluateCanary(
      {
        errorRate: 0,
        unknownEventRate: 0,
        turnFailureRate: 0,
        eventGaps: 0,
        approvalFailureRate: 0,
        sloBurnRate: 0,
      },
      {
        errorRate: 0.01,
        unknownEventRate: 0.01,
        turnFailureRate: 0.01,
        eventGaps: 0,
        approvalFailureRate: 0.01,
        sloBurnRate: 1,
      },
    )
    const initial: RolloutRecord = {
      rolloutId: 'rollout-1',
      state: 'canary',
      version: 4,
      artifactSha256: sha256('new'),
      previousArtifactSha256: sha256('old-signed'),
      provider: 'codex',
      providerVersion: '0.144.2',
      runtimeVersion: 'workspace-v29',
      protocolSchemaSha256: 'c'.repeat(64),
      migrationCompatible: true,
      cohort: 'canary',
      idempotency: {},
      killSwitch: false,
      previousRecordSha256: null,
    }
    const limited = transitionRollout(initial, {
      expectedVersion: 4,
      idempotencyKey: 'promote',
      commandSha256: sha256('promote'),
      next: 'limited_cohort',
      canary: healthy,
      cohort: 'limited-5-percent',
    })
    expect(() =>
      transitionRollout(limited, {
        expectedVersion: 4,
        idempotencyKey: 'other',
        commandSha256: sha256('other'),
        next: 'production_ready',
        cohort: 'production',
      }),
    ).toThrow('ROLLOUT_VERSION_CONFLICT')
    const broken = evaluateCanary(
      {
        errorRate: 1,
        unknownEventRate: 0,
        turnFailureRate: 0,
        eventGaps: 0,
        approvalFailureRate: 0,
        sloBurnRate: 0,
      },
      {
        errorRate: 0.01,
        unknownEventRate: 0.01,
        turnFailureRate: 0.01,
        eventGaps: 0,
        approvalFailureRate: 0.01,
        sloBurnRate: 1,
      },
    )
    const halted = transitionRollout(initial, {
      expectedVersion: 4,
      idempotencyKey: 'halt',
      commandSha256: sha256('halt'),
      next: 'halted',
      canary: broken,
      cohort: 'canary',
    })
    const rolledBack = transitionRollout(halted, {
      expectedVersion: 5,
      idempotencyKey: 'rollback',
      commandSha256: sha256('rollback'),
      next: 'rolled_back',
      cohort: 'internal-stable',
    })
    expect(rolledBack.artifactSha256).toBe(sha256('old-signed'))
  })

  it('chains real automation evidence', () => {
    let records = appendEvidence([], {
      controlId: 'CC8.1',
      framework: 'SOC2',
      owner: 'release-engineering',
      observedAt: '2026-07-21T00:00:00.000Z',
      automationRunId: 'run-1',
      artifactSha256: sha256('artifact'),
      evidenceSha256: sha256('gate-output'),
    })
    records = appendEvidence(records, {
      controlId: 'A.8.8',
      framework: 'ISO27001',
      owner: 'security',
      observedAt: '2026-07-21T00:01:00.000Z',
      automationRunId: 'run-1',
      artifactSha256: sha256('artifact'),
      evidenceSha256: sha256('scan-output'),
    })
    expect(records[1]?.previousEvidenceSha256).toBe(
      sha256(canonicalJson(records[0])),
    )
  })
})
