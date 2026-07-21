export * from './contracts'
export * from './identity'
export * from './durable'

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import type {
  DeletionJob,
  ExportManifest,
  LegalHold,
  ResidencyPolicy,
  RetentionClass,
  ScimResource,
  TransferAudit,
} from './contracts'
import { EnterpriseBoundaryError } from './identity'

export class ScimDirectory {
  #resources = new Map<string, ScimResource>()
  #idempotency = new Map<string, ScimResource>()
  upsert(
    input: Omit<ScimResource, 'schemaVersion' | 'version' | 'updatedAt'> & {
      idempotencyKey: string
      updatedAt?: string
    },
  ) {
    const scope = `${input.tenantId}:${input.organizationId}`,
      key = `${scope}:${input.resourceType}:${input.resourceId}`
    const idem = `${scope}:${input.providerId}:${input.idempotencyKey}`
    const priorIdem = this.#idempotency.get(idem)
    if (priorIdem) return priorIdem
    for (const value of this.#resources.values())
      if (
        value.tenantId === input.tenantId &&
        value.resourceType === input.resourceType &&
        value.externalId === input.externalId &&
        value.resourceId !== input.resourceId
      )
        throw new EnterpriseBoundaryError('SCIM_EXTERNAL_ID_CONFLICT')
    const prior = this.#resources.get(key)
    if (prior && input.providerVersion <= prior.providerVersion) {
      this.#idempotency.set(idem, prior)
      return prior
    }
    const value: ScimResource = {
      ...input,
      schemaVersion: 1,
      version: (prior?.version ?? 0) + 1,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    }
    delete (value as ScimResource & { idempotencyKey?: string }).idempotencyKey
    this.#resources.set(key, value)
    this.#idempotency.set(idem, value)
    return value
  }
  get(
    scope: { tenantId: string; organizationId: string },
    type: 'User' | 'Group',
    id: string,
  ) {
    const value = this.#resources.get(
      `${scope.tenantId}:${scope.organizationId}:${type}:${id}`,
    )
    if (!value) throw new EnterpriseBoundaryError('SCIM_NOT_FOUND')
    return value
  }
}

export function mapGroupsToRoles(
  groups: ScimResource[],
  mapping: Record<string, string>,
  tenantId: string,
) {
  return [
    ...new Set(
      groups
        .filter(
          (g) =>
            g.tenantId === tenantId && g.resourceType === 'Group' && g.active,
        )
        .map((g) => mapping[g.externalId])
        .filter((v): v is string => Boolean(v)),
    ),
  ]
}
export function planDeprovision() {
  return [
    'login',
    'sessions',
    'tokens',
    'leases',
    'turns',
    'credentials',
    'shared_folders',
    'corpus',
    'support',
    'authorization_cache',
  ] as const
}

export function assertLifecyclePrivilege(
  actorRoles: string[],
  action: 'export' | 'dsar' | 'delete' | 'legal_hold',
) {
  const required = {
    export: ['tenant_export_admin'],
    dsar: ['dsar_officer'],
    delete: ['tenant_owner', 'tenant_lifecycle_admin'],
    legal_hold: ['tenant_compliance_admin', 'legal_officer'],
  }[action]
  if (!actorRoles.some((role) => required.includes(role)))
    throw new EnterpriseBoundaryError('LIFECYCLE_PRIVILEGE_DENIED')
  return true
}

export interface RetentionCandidate {
  tenantId: string
  objectId: string
  objectClass: RetentionClass
  createdAt: Date
}
export class RetentionWorker {
  async runBatch(input: {
    tenantId: string
    candidates: RetentionCandidate[]
    limit: number
    checkpoint: number
    decide: (candidate: RetentionCandidate) => {
      delete: boolean
      reason: string
    }
    remove: (candidate: RetentionCandidate) => Promise<void>
    audit: (record: {
      objectId: string
      outcome: string
      reason: string
    }) => Promise<void>
  }) {
    const page = input.candidates.slice(
      input.checkpoint,
      input.checkpoint + input.limit,
    )
    for (const candidate of page) {
      if (candidate.tenantId !== input.tenantId)
        throw new EnterpriseBoundaryError('CROSS_TENANT_RETENTION_SCAN')
      const decision = input.decide(candidate)
      if (decision.delete) await input.remove(candidate)
      await input.audit({
        objectId: candidate.objectId,
        outcome: decision.delete ? 'deleted' : 'retained',
        reason: decision.reason,
      })
    }
    return {
      checkpoint: input.checkpoint + page.length,
      processed: page.length,
      done: page.length < input.limit,
    }
  }
}

export function retentionDecision(input: {
  objectClass: RetentionClass
  createdAt: Date
  now: Date
  policyDays: number
  previousPolicyDays?: number
  policyEffectiveAt: Date
  holds: LegalHold[]
  statutoryMinimumDays?: number
}) {
  const activeHold = input.holds.some(
    (h) =>
      h.state === 'active' &&
      h.objectClasses.includes(input.objectClass) &&
      new Date(h.expiresAt) > input.now,
  )
  if (activeHold) return { delete: false, reason: 'LEGAL_HOLD' as const }
  const days =
    input.createdAt < input.policyEffectiveAt
      ? Math.max(input.policyDays, input.previousPolicyDays ?? input.policyDays)
      : input.policyDays
  const minimum = Math.max(days, input.statutoryMinimumDays ?? 0)
  return input.now.getTime() >= input.createdAt.getTime() + minimum * 86400000
    ? { delete: true, reason: 'RETENTION_EXPIRED' as const }
    : { delete: false, reason: 'RETENTION_ACTIVE' as const }
}

export function buildEncryptedExport(input: {
  tenantId: string
  organizationId: string
  jobId: string
  workspaceIds: string[]
  watermark: string
  objects: {
    tenantId: string
    objectId: string
    objectClass: RetentionClass
    body: Buffer
    keyVersion: number
  }[]
  key: Buffer
  keyVersion?: number
  createdAt?: Date
}) {
  if (input.objects.some((o) => o.tenantId !== input.tenantId))
    throw new EnterpriseBoundaryError('CROSS_TENANT_EXPORT')
  const clean = input.objects.map((o) => ({
    objectId: o.objectId,
    objectClass: o.objectClass,
    body: o.body.toString('base64'),
  }))
  const plaintext = Buffer.from(JSON.stringify(clean)),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', input.key, iv)
  cipher.setAAD(Buffer.from(`${input.tenantId}:${input.jobId}`))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const archive = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  const manifest: ExportManifest = {
    schemaVersion: 1,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    workspaceIds: input.workspaceIds,
    watermark: input.watermark,
    objects: input.objects.map((o) => ({
      objectId: o.objectId,
      objectClass: o.objectClass,
      sha256: createHash('sha256').update(o.body).digest('hex'),
      byteLength: o.body.length,
      keyVersion: o.keyVersion,
    })),
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    archiveByteLength: archive.length,
    keyVersion:
      input.keyVersion ??
      Math.max(...input.objects.map((o) => o.keyVersion), 1),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  }
  return { archive, manifest }
}
export function decryptExport(
  archive: Buffer,
  key: Buffer,
  tenantId: string,
  jobId: string,
) {
  const decipher = createDecipheriv('aes-256-gcm', key, archive.subarray(0, 12))
  decipher.setAuthTag(archive.subarray(12, 28))
  decipher.setAAD(Buffer.from(`${tenantId}:${jobId}`))
  return Buffer.concat([
    decipher.update(archive.subarray(28)),
    decipher.final(),
  ])
}

export class TenantKeyAuthority {
  #keys = new Map<string, Buffer>()
  put(tenantId: string, version: number, key: Buffer) {
    this.#keys.set(`${tenantId}:${version}`, Buffer.from(key))
  }
  unwrap(tenantId: string, version: number) {
    const key = this.#keys.get(`${tenantId}:${version}`)
    if (!key) throw new EnterpriseBoundaryError('KMS_KEY_UNAVAILABLE')
    return Buffer.from(key)
  }
  cryptoErase(tenantId: string, version: number) {
    this.#keys.delete(`${tenantId}:${version}`)
  }
}

const deletionSteps = [
  'access_revoke',
  'admission_cordon',
  'active_job_drain',
  'session_token_revoke',
  'cache_purge',
  'index_purge',
  'object_delete',
  'metadata_cleanup',
  'backup_expiry',
  'kms_crypto_erasure',
  'deletion_receipt',
] as const
export function advanceDeletion(
  job: DeletionJob,
  holds: LegalHold[],
  now = new Date(),
): DeletionJob {
  if (job.state === 'complete') return job
  const held = holds.filter(
    (h) => h.state === 'active' && new Date(h.expiresAt) > now,
  )
  const index = deletionSteps.indexOf(job.currentStep)
  if (job.currentStep === 'object_delete' && held.length)
    return {
      ...job,
      state: 'blocked_by_hold',
      remainingClasses: held.flatMap((h) =>
        h.objectClasses.map((objectClass) => ({
          objectClass,
          reasonCode: 'LEGAL_HOLD',
          expiresAt: h.expiresAt,
        })),
      ),
      version: job.version + 1,
    }
  const completedSteps = [...new Set([...job.completedSteps, job.currentStep])]
  const next = deletionSteps[index + 1]
  return {
    ...job,
    state: next ? 'running' : 'complete',
    currentStep: next ?? 'deletion_receipt',
    completedSteps,
    remainingClasses: [],
    version: job.version + 1,
  }
}

export function assertResidency(
  policy: ResidencyPolicy,
  input: {
    region: string
    kind: 'placement' | 'object' | 'backup' | 'index' | 'export'
  },
) {
  if (!policy.allowedRegions.includes(input.region))
    throw new EnterpriseBoundaryError(
      `RESIDENCY_${input.kind.toUpperCase()}_DENIED`,
    )
}
export function authorizeTransfer(
  policy: ResidencyPolicy,
  input: {
    sourceRegion: string
    destinationRegion: string
    objectClass: RetentionClass
    approvalId?: string
  },
) {
  const allowed = policy.crossRegionTransfers.some(
    (r) =>
      r.sourceRegion === input.sourceRegion &&
      r.destinationRegion === input.destinationRegion &&
      r.objectClasses.includes(input.objectClass),
  )
  if (!allowed || !input.approvalId)
    throw new EnterpriseBoundaryError('CROSS_REGION_TRANSFER_DENIED')
  return true
}

export function createTransferAudit(
  policy: ResidencyPolicy,
  input: Omit<TransferAudit, 'schemaVersion' | 'tenantId' | 'organizationId'>,
): TransferAudit {
  authorizeTransfer(policy, input)
  return {
    schemaVersion: 1,
    tenantId: policy.tenantId,
    organizationId: policy.organizationId,
    ...input,
  }
}
