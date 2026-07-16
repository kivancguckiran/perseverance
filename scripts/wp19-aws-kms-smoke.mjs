import { spawnSync } from 'node:child_process'

const keyId = process.env.WP19_AWS_KMS_KEY_ID
if (!keyId) {
  console.error(
    'WP19_AWS_KMS_KEY_ID is required. The smoke will not create a billable KMS key automatically.',
  )
  process.exit(2)
}
const context = [
  'tenantId=wp19-smoke',
  'organizationId=wp19-smoke',
  'workspaceId=wp19-smoke',
  'purpose=persistent-codex-workspace-envelope-v1',
]
function aws(args) {
  const result = spawnSync('aws', args, {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `aws ${args[0]} failed`)
  return result.stdout.trim()
}

const ciphertext = aws([
  'kms',
  'encrypt',
  '--key-id',
  keyId,
  '--plaintext',
  'd3AxOS1zbW9rZQ==',
  '--encryption-context',
  ...context,
  '--output',
  'text',
  '--query',
  'CiphertextBlob',
])
const plaintext = aws([
  'kms',
  'decrypt',
  '--ciphertext-blob',
  ciphertext,
  '--encryption-context',
  ...context,
  '--output',
  'text',
  '--query',
  'Plaintext',
])
if (plaintext !== 'd3AxOS1zbW9rZQ==')
  throw new Error('AWS KMS plaintext round-trip mismatch')
const mismatch = spawnSync(
  'aws',
  [
    'kms',
    'decrypt',
    '--ciphertext-blob',
    ciphertext,
    '--encryption-context',
    'tenantId=other-tenant',
    ...context.slice(1),
    '--output',
    'text',
    '--query',
    'Plaintext',
  ],
  { encoding: 'utf8', timeout: 30_000 },
)
if (mismatch.status === 0)
  throw new Error('AWS KMS accepted a mismatched tenant encryption context')
console.log(
  JSON.stringify({
    status: 'passed',
    provider: 'aws-kms',
    keyIdHash: await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(keyId).digest('hex').slice(0, 16),
    ),
    roundTrip: true,
    contextMismatch: 'denied',
  }),
)
