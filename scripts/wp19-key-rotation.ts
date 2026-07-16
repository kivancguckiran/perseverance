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
  recordType: 'raw_event' as const,
  recordId: 'rotation-smoke',
}
const kms = new LocalKmsProvider(Buffer.alloc(32, 1))
const encryption = new EnvelopeEncryption(kms)
const oldEnvelope = await encryption.encrypt(context, Buffer.from('old-value'))
const newVersion = kms.rotate(Buffer.alloc(32, 2))
const newEnvelope = await encryption.encrypt(context, Buffer.from('new-value'))
if (newEnvelope.keyVersion !== newVersion)
  throw new Error('new writes did not use the current key version')
if (
  Buffer.from(await encryption.decrypt(context, oldEnvelope)).toString() !==
  'old-value'
)
  throw new Error('old ciphertext was not readable during rotation')
if (
  Buffer.from(await encryption.decrypt(context, newEnvelope)).toString() !==
  'new-value'
)
  throw new Error('new ciphertext was not readable during rotation')
kms.revokeKeyVersion(oldEnvelope.keyVersion)
let revoked = false
try {
  await encryption.decrypt(context, oldEnvelope)
} catch {
  revoked = true
}
if (!revoked) throw new Error('revoked key remained readable')
console.log(
  JSON.stringify({
    status: 'passed',
    provider: kms.name,
    evidence: 'old/new read, current-version write, revoked-key denial',
  }),
)
