import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

export const WP29_SCHEMA_VERSION = 1 as const
export const WP29_REPOSITORY = 'persistent-codex-workspace' as const
export const WP29_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1' as const

export const canonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      )
    return input
  }
  return JSON.stringify(normalize(value))
}

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

export type ArtifactKind =
  'web' | 'control-plane' | 'workspace-agent' | 'runtime-image'

export interface ArtifactDescriptor {
  readonly name: ArtifactKind
  readonly mediaType: string
  readonly sha256: string
  readonly byteLength: number
}

export interface BuildManifest {
  readonly schemaVersion: 1
  readonly repository: string
  readonly sourceCommit: string
  readonly sourceDirty: boolean
  readonly sourceMode: 'production' | 'acceptance-fixture'
  readonly builderIdentity: string
  readonly platform: string
  readonly dependencyLockSha256: string
  readonly protocolSchemaSha256: string
  readonly buildCommand: string
  readonly sourceDateEpoch: number
  readonly artifacts: readonly ArtifactDescriptor[]
}

export const createBuildManifest = (
  input: Omit<BuildManifest, 'schemaVersion'>,
): BuildManifest => {
  if (input.sourceMode === 'production' && input.sourceDirty)
    throw new Error('DIRTY_PRODUCTION_SOURCE')
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit))
    throw new Error('INVALID_SOURCE_COMMIT')
  if (!/^[0-9a-f]{64}$/.test(input.dependencyLockSha256))
    throw new Error('INVALID_LOCK_DIGEST')
  if (!/^[0-9a-f]{64}$/.test(input.protocolSchemaSha256))
    throw new Error('INVALID_SCHEMA_DIGEST')
  const names = new Set(input.artifacts.map(({ name }) => name))
  for (const required of [
    'web',
    'control-plane',
    'workspace-agent',
    'runtime-image',
  ])
    if (!names.has(required as ArtifactKind))
      throw new Error(`MISSING_ARTIFACT:${required}`)
  return { schemaVersion: WP29_SCHEMA_VERSION, ...input }
}

export interface SbomComponent {
  readonly type: 'library' | 'application' | 'container' | 'file'
  readonly name: string
  readonly version: string
  readonly scope: 'required' | 'optional'
  readonly relationship: 'direct' | 'transitive' | 'binary' | 'container-layer'
  readonly licenses: readonly string[]
  readonly hashes: readonly { alg: 'SHA-256'; content: string }[]
}

export interface CycloneDxSbom {
  readonly bomFormat: 'CycloneDX'
  readonly specVersion: '1.6'
  readonly serialNumber: string
  readonly version: 1
  readonly metadata: {
    readonly component: { readonly type: 'application'; readonly name: string }
  }
  readonly components: readonly SbomComponent[]
}

export const createCycloneDxSbom = (
  components: readonly SbomComponent[],
): CycloneDxSbom => {
  const sorted = [...components].sort((a, b) =>
    `${a.type}:${a.name}:${a.version}`.localeCompare(
      `${b.type}:${b.name}:${b.version}`,
    ),
  )
  const identity = sha256(canonicalJson(sorted))
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${identity.slice(0, 8)}-${identity.slice(8, 12)}-${identity.slice(12, 16)}-${identity.slice(16, 20)}-${identity.slice(20, 32)}`,
    version: 1,
    metadata: {
      component: { type: 'application', name: WP29_REPOSITORY },
    },
    components: sorted,
  }
}

export interface ProvenanceStatement {
  readonly _type: 'https://in-toto.io/Statement/v1'
  readonly subject: readonly {
    readonly name: string
    readonly digest: { readonly sha256: string }
  }[]
  readonly predicateType: typeof WP29_PREDICATE_TYPE
  readonly predicate: {
    readonly buildDefinition: {
      readonly buildType: string
      readonly externalParameters: {
        readonly repository: string
        readonly sourceCommit: string
        readonly buildCommand: string
      }
      readonly internalParameters: {
        readonly dependencyLockSha256: string
        readonly protocolSchemaSha256: string
      }
      readonly resolvedDependencies: readonly {
        readonly uri: string
        readonly digest: { readonly sha256: string }
      }[]
    }
    readonly runDetails: {
      readonly builder: { readonly id: string }
      readonly metadata: {
        readonly invocationId: string
        readonly startedOn: string
        readonly finishedOn: string
      }
    }
  }
}

export const createProvenance = (
  manifest: BuildManifest,
): ProvenanceStatement => {
  const instant = new Date(manifest.sourceDateEpoch * 1000).toISOString()
  const invocationId = sha256(canonicalJson(manifest))
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: manifest.artifacts.map(({ name, sha256: digest }) => ({
      name,
      digest: { sha256: digest },
    })),
    predicateType: WP29_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: 'https://persistent-codex.example/build/v1',
        externalParameters: {
          repository: manifest.repository,
          sourceCommit: manifest.sourceCommit,
          buildCommand: manifest.buildCommand,
        },
        internalParameters: {
          dependencyLockSha256: manifest.dependencyLockSha256,
          protocolSchemaSha256: manifest.protocolSchemaSha256,
        },
        resolvedDependencies: [
          {
            uri: `git+https://example.invalid/${manifest.repository}@${manifest.sourceCommit}`,
            digest: { sha256: manifest.sourceCommit.padEnd(64, '0') },
          },
          {
            uri: 'file:pnpm-lock.yaml',
            digest: { sha256: manifest.dependencyLockSha256 },
          },
        ],
      },
      runDetails: {
        builder: { id: manifest.builderIdentity },
        metadata: {
          invocationId,
          startedOn: instant,
          finishedOn: instant,
        },
      },
    },
  }
}

export interface SignerIdentity {
  readonly id: string
  readonly publicKeyPem: string
  readonly fingerprint: string
  readonly validFrom: string
  readonly validUntil: string
  readonly revokedAt: string | null
}

export interface SignatureEnvelope {
  readonly algorithm: 'Ed25519'
  readonly signerId: string
  readonly signerFingerprint: string
  readonly payloadSha256: string
  readonly signatureBase64: string
}

export interface TestSigner {
  readonly identity: SignerIdentity
  readonly privateKey: KeyObject
}

export const createEphemeralTestSigner = (
  now = new Date('2026-07-21T00:00:00.000Z'),
): TestSigner => {
  const pair = generateKeyPairSync('ed25519')
  const publicKeyPem = pair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
  return {
    privateKey: pair.privateKey,
    identity: {
      id: 'wp29-local-ephemeral-test-root',
      publicKeyPem,
      fingerprint: sha256(
        pair.publicKey.export({ type: 'spki', format: 'der' }),
      ),
      validFrom: new Date(now.getTime() - 60_000).toISOString(),
      validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
      revokedAt: null,
    },
  }
}

export const signPayload = (
  payload: unknown,
  signer: TestSigner,
): SignatureEnvelope => {
  const bytes = Buffer.from(canonicalJson(payload))
  return {
    algorithm: 'Ed25519',
    signerId: signer.identity.id,
    signerFingerprint: signer.identity.fingerprint,
    payloadSha256: sha256(bytes),
    signatureBase64: sign(null, bytes, signer.privateKey).toString('base64'),
  }
}

export const verifySignature = (
  payload: unknown,
  signature: SignatureEnvelope,
  identity: SignerIdentity,
  at = new Date('2026-07-21T00:10:00.000Z'),
): void => {
  if (signature.signerId !== identity.id) throw new Error('UNTRUSTED_SIGNER')
  if (signature.signerFingerprint !== identity.fingerprint)
    throw new Error('SIGNER_FINGERPRINT_MISMATCH')
  if (identity.revokedAt && Date.parse(identity.revokedAt) <= at.getTime())
    throw new Error('SIGNER_REVOKED')
  if (
    at.getTime() < Date.parse(identity.validFrom) ||
    at.getTime() > Date.parse(identity.validUntil)
  )
    throw new Error('SIGNER_EXPIRED')
  const bytes = Buffer.from(canonicalJson(payload))
  if (signature.payloadSha256 !== sha256(bytes))
    throw new Error('SIGNED_PAYLOAD_DIGEST_MISMATCH')
  const publicKey = createPublicKey(identity.publicKeyPem)
  if (
    !verify(
      null,
      bytes,
      publicKey,
      Buffer.from(signature.signatureBase64, 'base64'),
    )
  )
    throw new Error('INVALID_SIGNATURE')
}

export interface SignedRelease {
  readonly manifest: BuildManifest
  readonly manifestSignature: SignatureEnvelope
  readonly sbom: CycloneDxSbom
  readonly sbomSignature: SignatureEnvelope
  readonly provenance: ProvenanceStatement
  readonly provenanceSignature: SignatureEnvelope
}

export interface AdmissionExpectation {
  readonly repository: string
  readonly sourceCommit: string
  readonly artifactDigests: Readonly<Record<ArtifactKind, string>>
  readonly trustedSigner: SignerIdentity
}

export const verifyReleaseAdmission = (
  release: SignedRelease,
  expectation: AdmissionExpectation,
): { readonly admitted: true; readonly signerFingerprint: string } => {
  if (release.manifest.sourceMode !== 'production')
    throw new Error('NON_PRODUCTION_SOURCE_MODE')
  if (release.manifest.sourceDirty) throw new Error('DIRTY_PRODUCTION_SOURCE')
  if (release.manifest.repository !== expectation.repository)
    throw new Error('WRONG_PROVENANCE_REPOSITORY')
  if (release.manifest.sourceCommit !== expectation.sourceCommit)
    throw new Error('WRONG_SOURCE_COMMIT')
  if (
    release.provenance.predicate.buildDefinition.externalParameters
      .repository !== expectation.repository
  )
    throw new Error('WRONG_PROVENANCE_REPOSITORY')
  if (
    release.provenance.predicate.buildDefinition.externalParameters
      .sourceCommit !== expectation.sourceCommit
  )
    throw new Error('WRONG_PROVENANCE_COMMIT')
  for (const artifact of release.manifest.artifacts) {
    if (expectation.artifactDigests[artifact.name] !== artifact.sha256)
      throw new Error(`WRONG_ARTIFACT_DIGEST:${artifact.name}`)
    if (
      !release.provenance.subject.some(
        (subject) =>
          subject.name === artifact.name &&
          subject.digest.sha256 === artifact.sha256,
      )
    )
      throw new Error(`PROVENANCE_SUBJECT_MISSING:${artifact.name}`)
  }
  verifySignature(
    release.manifest,
    release.manifestSignature,
    expectation.trustedSigner,
  )
  verifySignature(
    release.sbom,
    release.sbomSignature,
    expectation.trustedSigner,
  )
  verifySignature(
    release.provenance,
    release.provenanceSignature,
    expectation.trustedSigner,
  )
  return {
    admitted: true,
    signerFingerprint: expectation.trustedSigner.fingerprint,
  }
}

export type GateStatus = 'passed' | 'blocked' | 'not-run'
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface PolicyFinding {
  readonly scanner: string
  readonly ruleId: string
  readonly severity: FindingSeverity
  readonly subject: string
  readonly exploitable: boolean
}

export interface ScanResult {
  readonly scanner: string
  readonly scannerVersion: string
  readonly status: GateStatus
  readonly findings: readonly PolicyFinding[]
  readonly inputSha256: string
}

export interface AllowlistEntry {
  readonly ruleId: string
  readonly subject: string
  readonly owner: string
  readonly reason: string
  readonly expiresAt: string
  readonly approvalSha256: string
}

export const evaluateSecurityGate = (
  results: readonly ScanResult[],
  allowlist: readonly AllowlistEntry[],
  at = new Date('2026-07-21T00:10:00.000Z'),
): { readonly admitted: true; readonly findings: 0 } => {
  if (results.length === 0) throw new Error('SCANNER_MISSING')
  for (const result of results)
    if (result.status !== 'passed')
      throw new Error(
        `SCANNER_${result.status.toUpperCase()}:${result.scanner}`,
      )
  const active = new Set(
    allowlist
      .filter(
        (entry) =>
          Date.parse(entry.expiresAt) > at.getTime() &&
          entry.owner.length > 0 &&
          entry.reason.length >= 10 &&
          /^[0-9a-f]{64}$/.test(entry.approvalSha256),
      )
      .map((entry) => `${entry.ruleId}:${entry.subject}`),
  )
  const blockers = results
    .flatMap(({ findings }) => findings)
    .filter(
      (finding) =>
        (finding.severity === 'critical' ||
          (finding.severity === 'high' && finding.exploitable)) &&
        !active.has(`${finding.ruleId}:${finding.subject}`),
    )
  if (blockers.length > 0)
    throw new Error(`SECURITY_POLICY_BLOCKED:${blockers[0]!.ruleId}`)
  return { admitted: true, findings: 0 }
}

export interface MigrationFinding {
  readonly ruleId:
    | 'DESTRUCTIVE_DROP'
    | 'DESTRUCTIVE_TRUNCATE'
    | 'COLUMN_NARROWING'
    | 'UNBOUNDED_REWRITE'
    | 'TENANT_KEY_MISSING'
    | 'RLS_MISSING'
  readonly line: number
}

export const lintMigration = (sql: string): readonly MigrationFinding[] => {
  const findings: MigrationFinding[] = []
  const lines = sql.split('\n')
  const add = (ruleId: MigrationFinding['ruleId'], index: number) =>
    findings.push({ ruleId, line: index + 1 })
  lines.forEach((line, index) => {
    if (/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(line))
      add('DESTRUCTIVE_DROP', index)
    if (/\bTRUNCATE\b/i.test(line)) add('DESTRUCTIVE_TRUNCATE', index)
    if (
      /ALTER\s+COLUMN.+TYPE\s+(?:varchar\(\d+\)|smallint|integer)\b/i.test(line)
    )
      add('COLUMN_NARROWING', index)
    if (/UPDATE\s+\S+\s+SET\b/i.test(line) && !/WHERE\b/i.test(line))
      add('UNBOUNDED_REWRITE', index)
  })
  const tableBlocks = sql.split(/CREATE\s+TABLE/i).slice(1)
  for (const block of tableBlocks) {
    const firstLine = sql.slice(0, sql.indexOf(block)).split('\n').length
    if (!/tenant_id/i.test(block))
      findings.push({ ruleId: 'TENANT_KEY_MISSING', line: firstLine })
    const table = block.match(/(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/i)?.[1]
    if (
      table &&
      !new RegExp(
        `ALTER\\s+TABLE\\s+${table.replace('.', '\\.')}.+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        'is',
      ).test(sql)
    )
      findings.push({ ruleId: 'RLS_MISSING', line: firstLine })
  }
  return findings
}

export type MigrationPhase =
  | 'expand'
  | 'dual-read-write'
  | 'backfill'
  | 'validate'
  | 'contract-ready'
  | 'contracted'

export interface MigrationCompatibility {
  readonly phase: MigrationPhase
  readonly nReader: boolean
  readonly nWriter: boolean
  readonly nMinusOneReader: boolean
  readonly nMinusOneWriter: boolean
  readonly oldReaders: number
  readonly oldWriters: number
  readonly drainEvidenceSha256: string | null
}

export const advanceMigration = (
  current: MigrationCompatibility,
  next: MigrationPhase,
): MigrationCompatibility => {
  const phases: readonly MigrationPhase[] = [
    'expand',
    'dual-read-write',
    'backfill',
    'validate',
    'contract-ready',
    'contracted',
  ]
  if (phases.indexOf(next) !== phases.indexOf(current.phase) + 1)
    throw new Error('INVALID_MIGRATION_TRANSITION')
  if (
    ['validate', 'contract-ready', 'contracted'].includes(next) &&
    (!current.nReader ||
      !current.nWriter ||
      !current.nMinusOneReader ||
      !current.nMinusOneWriter)
  )
    throw new Error('N_MINUS_ONE_INCOMPATIBLE')
  if (
    next === 'contracted' &&
    (current.oldReaders !== 0 ||
      current.oldWriters !== 0 ||
      !current.drainEvidenceSha256)
  )
    throw new Error('OLD_RUNTIME_NOT_DRAINED')
  return { ...current, phase: next }
}

export type CapabilityState = 'supported' | 'degraded' | 'unsupported'
export interface ProviderCapability {
  readonly provider: 'codex' | 'claude' | 'gemini' | 'cursor'
  readonly version: string | null
  readonly discovery: 'real-binary' | 'fixture-only' | 'not-run'
  readonly capabilities: Readonly<
    Record<
      'streaming' | 'approval' | 'resume' | 'usage' | 'unknownFallback',
      CapabilityState
    >
  >
}

export interface CanaryMetrics {
  readonly errorRate: number
  readonly unknownEventRate: number
  readonly turnFailureRate: number
  readonly eventGaps: number
  readonly approvalFailureRate: number
  readonly sloBurnRate: number
}

export interface CanaryThresholds {
  readonly errorRate: number
  readonly unknownEventRate: number
  readonly turnFailureRate: number
  readonly eventGaps: number
  readonly approvalFailureRate: number
  readonly sloBurnRate: number
}

export const evaluateCanary = (
  metrics: CanaryMetrics,
  thresholds: CanaryThresholds,
): { readonly healthy: boolean; readonly breached: readonly string[] } => {
  const breached = (Object.keys(thresholds) as (keyof CanaryThresholds)[])
    .filter((key) => metrics[key] > thresholds[key])
    .sort()
  return { healthy: breached.length === 0, breached }
}

export type RolloutState =
  | 'build'
  | 'verified'
  | 'internal'
  | 'canary'
  | 'limited_cohort'
  | 'production_ready'
  | 'halted'
  | 'rolled_back'

export interface RolloutRecord {
  readonly rolloutId: string
  readonly state: RolloutState
  readonly version: number
  readonly artifactSha256: string
  readonly previousArtifactSha256: string | null
  readonly provider: string
  readonly providerVersion: string
  readonly runtimeVersion: string
  readonly protocolSchemaSha256: string
  readonly migrationCompatible: boolean
  readonly cohort: string
  readonly idempotency: Readonly<Record<string, string>>
  readonly killSwitch: boolean
  readonly previousRecordSha256: string | null
}

const normalRolloutOrder: readonly RolloutState[] = [
  'build',
  'verified',
  'internal',
  'canary',
  'limited_cohort',
  'production_ready',
]

export const transitionRollout = (
  current: RolloutRecord,
  input: {
    readonly expectedVersion: number
    readonly idempotencyKey: string
    readonly commandSha256: string
    readonly next: RolloutState
    readonly canary?: ReturnType<typeof evaluateCanary>
    readonly cohort: string
  },
): RolloutRecord => {
  const prior = current.idempotency[input.idempotencyKey]
  if (prior && prior !== input.commandSha256)
    throw new Error('ROLLOUT_IDEMPOTENCY_CONFLICT')
  if (prior) return current
  if (input.expectedVersion !== current.version)
    throw new Error('ROLLOUT_VERSION_CONFLICT')
  if (input.next === 'halted') {
    if (input.canary?.healthy !== false) throw new Error('HALT_WITHOUT_BREACH')
  } else if (input.next === 'rolled_back') {
    if (current.state !== 'halted' || !current.previousArtifactSha256)
      throw new Error('ROLLBACK_PRECONDITION_FAILED')
  } else {
    if (
      normalRolloutOrder.indexOf(input.next) !==
      normalRolloutOrder.indexOf(current.state) + 1
    )
      throw new Error('INVALID_ROLLOUT_TRANSITION')
    if (!current.migrationCompatible) throw new Error('MIGRATION_INCOMPATIBLE')
    if (current.killSwitch) throw new Error('KILL_SWITCH_ACTIVE')
    if (input.next === 'limited_cohort' && input.canary?.healthy !== true)
      throw new Error('CANARY_NOT_HEALTHY')
  }
  return {
    ...current,
    state: input.next,
    version: current.version + 1,
    cohort: input.cohort,
    artifactSha256:
      input.next === 'rolled_back'
        ? current.previousArtifactSha256!
        : current.artifactSha256,
    idempotency: {
      ...current.idempotency,
      [input.idempotencyKey]: input.commandSha256,
    },
    killSwitch: current.killSwitch || input.next === 'halted',
    previousRecordSha256: sha256(canonicalJson(current)),
  }
}

export interface EvidenceRecord {
  readonly controlId: string
  readonly framework: 'SOC2' | 'ISO27001'
  readonly owner: string
  readonly observedAt: string
  readonly automationRunId: string
  readonly artifactSha256: string
  readonly evidenceSha256: string
  readonly previousEvidenceSha256: string | null
}

export const appendEvidence = (
  records: readonly EvidenceRecord[],
  input: Omit<EvidenceRecord, 'previousEvidenceSha256'>,
): readonly EvidenceRecord[] => [
  ...records,
  {
    ...input,
    previousEvidenceSha256:
      records.length === 0
        ? null
        : sha256(canonicalJson(records[records.length - 1])),
  },
]

export const importPrivateKey = (pem: string): KeyObject =>
  createPrivateKey(pem)
