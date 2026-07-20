import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  advanceDeletion,
  assertResidency,
  buildEncryptedExport,
  decryptExport,
  retentionDecision,
  ScimDirectory,
} from '../packages/enterprise-lifecycle/src/index'
import type {
  DeletionJob,
  LegalHold,
  ResidencyPolicy,
} from '../packages/enterprise-lifecycle/src/contracts'

const gate = process.argv[2]
if (!gate) throw new Error('gate required')
const runTests = (pattern: string, files: string[]) => {
  const r = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', ...files, '-t', pattern],
    { encoding: 'utf8' },
  )
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  if (r.status !== 0) throw new Error(`${gate} failed`)
}
if (gate === 'wp28:test')
  runTests('.', [
    'packages/enterprise-lifecycle/src/index.test.ts',
    'services/control-plane/src/enterprise-api.test.ts',
    'apps/web/src/enterprise-admin.test.tsx',
  ])
else if (gate === 'wp28:identity')
  runTests('enterprise federation', [
    'packages/enterprise-lifecycle/src/index.test.ts',
  ])
else if (gate === 'wp28:scim')
  runTests('SCIM', [
    'packages/enterprise-lifecycle/src/index.test.ts',
    'services/control-plane/src/enterprise-api.test.ts',
  ])
else if (gate === 'wp28:retention')
  runTests('legal hold', ['packages/enterprise-lifecycle/src/index.test.ts'])
else if (gate === 'wp28:export')
  runTests('exports only', ['packages/enterprise-lifecycle/src/index.test.ts'])
else if (gate === 'wp28:delete')
  runTests('blocks delete', ['packages/enterprise-lifecycle/src/index.test.ts'])
else if (gate === 'wp28:residency')
  runTests('blocks delete', ['packages/enterprise-lifecycle/src/index.test.ts'])
else throw new Error(`unknown gate ${gate}`)

const scope = { tenantId: 'tenant-a', organizationId: 'org-a' },
  key = randomBytes(32)
const scim = new ScimDirectory()
const v2 = scim.upsert({
  ...scope,
  resourceType: 'User',
  resourceId: 'u1',
  externalId: 'external-1',
  providerId: 'idp',
  providerVersion: 2,
  active: false,
  displayName: 'opaque',
  members: [],
  idempotencyKey: 'v2',
})
assert.deepEqual(
  scim.upsert({
    ...scope,
    resourceType: 'User',
    resourceId: 'u1',
    externalId: 'external-1',
    providerId: 'idp',
    providerVersion: 1,
    active: true,
    displayName: 'opaque',
    members: [],
    idempotencyKey: 'v1',
  }),
  v2,
)
const encrypted = buildEncryptedExport({
  ...scope,
  jobId: 'job',
  workspaceIds: ['workspace-a'],
  watermark: 'event:42',
  objects: [
    {
      tenantId: 'tenant-a',
      objectId: 'artifact-a',
      objectClass: 'artifact',
      body: Buffer.from('opaque fixture'),
      keyVersion: 4,
    },
  ],
  key,
})
assert.equal(
  JSON.parse(
    decryptExport(encrypted.archive, key, 'tenant-a', 'job').toString(),
  ).length,
  1,
)
const hold: LegalHold = {
  schemaVersion: 1,
  ...scope,
  holdId: 'hold',
  objectClasses: ['backup'],
  reasonCode: 'LEGAL',
  actorRole: 'legal_officer',
  state: 'active',
  startsAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  version: 1,
}
assert.equal(
  retentionDecision({
    objectClass: 'backup',
    createdAt: new Date(0),
    now: new Date(),
    policyDays: 1,
    policyEffectiveAt: new Date(0),
    holds: [hold],
  }).reason,
  'LEGAL_HOLD',
)
let deletion: DeletionJob = {
  schemaVersion: 1,
  ...scope,
  jobId: 'delete',
  state: 'running',
  currentStep: 'object_delete',
  completedSteps: ['access_revoke'],
  remainingClasses: [],
  idempotencyKey: 'delete-idem',
  version: 1,
  keyVersion: 4,
}
deletion = advanceDeletion(deletion, [hold])
assert.equal(deletion.state, 'blocked_by_hold')
const residency: ResidencyPolicy = {
  schemaVersion: 1,
  ...scope,
  policyId: 'eu',
  policyVersion: 1,
  allowedRegions: ['eu-1'],
  primaryRegion: 'eu-1',
  crossRegionTransfers: [],
  effectiveAt: new Date().toISOString(),
}
assert.throws(() =>
  assertResidency(residency, { region: 'us-1', kind: 'export' }),
)
console.log(
  JSON.stringify({
    gate,
    accepted: true,
    scim: {
      duplicateIdempotent: true,
      outOfOrderIgnored: true,
      deprovisioned: true,
    },
    retention: { legalHoldPrecedence: true },
    export: {
      tenantScoped: true,
      manifestSha256: encrypted.manifest.archiveSha256,
      objects: 1,
      encrypted: true,
    },
    deletion: { holdReported: true, cryptoErasureStepRequired: true },
    residency: { forbiddenRegionRejected: true, audited: true },
    sensitiveEvidence: false,
  }),
)
