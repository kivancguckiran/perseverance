import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'

const scope = {
  tenantId: 'smoke-tenant',
  organizationId: 'smoke-organization',
  workspaceId: 'smoke-workspace',
}
const context = {
  ...scope,
  recordType: 'prompt' as const,
  recordId: 'crypto-erasure-smoke',
}
const encryption = new EnvelopeEncryption(
  new LocalKmsProvider(Buffer.alloc(32, 3)),
)
const envelope = await encryption.encrypt(context, Buffer.from('erase-me'))
await encryption.cryptoErase(scope)
let denied = false
try {
  await encryption.decrypt(context, envelope)
} catch {
  denied = true
}
if (!denied) throw new Error('crypto-erased workspace remained decryptable')
console.log(
  JSON.stringify({
    status: 'passed',
    provider: encryption.kms.name,
    evidence: 'workspace key access revoked and ciphertext denied',
  }),
)
