import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machineEvidence } from './wp30-evidence'

const required = [
  'WP30_RESOURCE_INVENTORY_ATTESTATION_PATH',
  'WP30_RESOURCE_INVENTORY_SIGNATURE_PATH',
  'WP30_RESOURCE_INVENTORY_PUBLIC_KEY_PATH',
] as const
for (const name of required)
  assert(process.env[name], `cleanup evidence missing: ${name}`)

const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const containers = docker(
  ['ps', '-aq', '--filter', 'label=persistent.wp30=true'],
  true,
)
  .split('\n')
  .filter(Boolean)
for (const id of containers) docker(['rm', '-f', '-v', id], true)
const volumes = docker(
  ['volume', 'ls', '-q', '--filter', 'label=persistent.wp30=true'],
  true,
)
  .split('\n')
  .filter(Boolean)
for (const volume of volumes) docker(['volume', 'rm', volume], true)
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith('persistent-wp30-') || name.startsWith('wp30-'))
    rmSync(join(tmpdir(), name), { recursive: true, force: true })
}
const browserSessions = spawnSync('agent-browser', ['session', 'list'], {
  encoding: 'utf8',
})
assert.equal(browserSessions.status, 0)
assert(
  !browserSessions.stdout.includes(
    process.env.WP30_BROWSER_SESSION ?? '__none__',
  ),
)
const lingering = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  .stdout.split('\n')
  .filter(
    (line) =>
      /scripts\/wp30-(?!accept|cleanup)/.test(line) && !line.includes('rg '),
  )
assert.deepEqual(lingering, [])
assert.equal(
  docker(['ps', '-aq', '--filter', 'label=persistent.wp30=true'], true),
  '',
)
assert.equal(
  docker(
    ['volume', 'ls', '-q', '--filter', 'label=persistent.wp30=true'],
    true,
  ),
  '',
)
const inventoryBytes = readFileSync(
  process.env.WP30_RESOURCE_INVENTORY_ATTESTATION_PATH!,
)
const inventorySignature = readFileSync(
  process.env.WP30_RESOURCE_INVENTORY_SIGNATURE_PATH!,
)
const inventoryPublicKey = readFileSync(
  process.env.WP30_RESOURCE_INVENTORY_PUBLIC_KEY_PATH!,
)
assert(
  verify(
    null,
    inventoryBytes,
    createPublicKey(inventoryPublicKey),
    inventorySignature,
  ),
  'resource inventory attestation signature invalid',
)
const inventory = JSON.parse(inventoryBytes.toString('utf8'))
assert.equal(inventory.schemaVersion, 1)
assert.equal(inventory.independent, true)
assert.equal(inventory.temporaryCloudResources, 0)
assert.equal(inventory.paidResourcesRemaining, 0)
assert.equal(inventory.temporaryCredentialsRemaining, 0)
machineEvidence('wp30:cleanup', {
  accepted: true,
  status: 'passed',
  containers: 0,
  volumes: 0,
  processes: 0,
  browserSessions: 0,
  temporaryCredentialsPersisted: 0,
  paidResourcesRemaining: 0,
  resourceInventoryAttestationSha256: createHash('sha256')
    .update(inventoryBytes)
    .digest('hex'),
  resourceInventoryPublicKeySha256: createHash('sha256')
    .update(inventoryPublicKey)
    .digest('hex'),
})
