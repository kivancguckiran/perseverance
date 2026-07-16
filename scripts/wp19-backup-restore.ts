import {
  ChunkedEnvelopeEncryption,
  EncryptedBackupService,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'

const scope = {
  tenantId: 'smoke-tenant',
  organizationId: 'smoke-organization',
  workspaceId: 'smoke-workspace',
}
const backups = new EncryptedBackupService(
  new ChunkedEnvelopeEncryption(
    new LocalKmsProvider(Buffer.alloc(32, 4)),
    1024,
  ),
)
const source = Buffer.alloc(8_193, 5)
const envelope = await backups.create(scope, 'backup-smoke', source)
const restored = await backups.restore(scope, scope, 'backup-smoke', envelope)
if (!Buffer.from(restored).equals(source))
  throw new Error('encrypted backup restore did not preserve bytes')
let crossTenantDenied = false
try {
  await backups.restore(
    scope,
    { ...scope, tenantId: 'other-tenant' },
    'backup-smoke',
    envelope,
  )
} catch {
  crossTenantDenied = true
}
if (!crossTenantDenied) throw new Error('cross-tenant restore was allowed')
console.log(
  JSON.stringify({
    status: 'passed',
    provider: backups.encryption.kms.name,
    chunks: envelope.chunks.length,
    evidence: 'encrypted round-trip and cross-tenant restore denial',
  }),
)
