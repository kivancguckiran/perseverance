import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const values = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || !value) throw new Error('invalid arguments')
  values.set(key.slice(2), value)
}
const required = (name: string) => {
  const value = values.get(name)
  if (!value) throw new Error(`missing --${name}`)
  return resolve(value)
}
const artifact = required('artifact')
const signature = required('signature')
const publicKey = required('public-key')
const policyPath = required('policy')
const repository = values.get('repository')
const sourceCommit = values.get('source-commit')
assert(repository && sourceCommit)
const directory = dirname(artifact)
mkdirSync(join(directory, 'home'), { recursive: true })
for (const path of [signature, publicKey, policyPath])
  assert.equal(
    dirname(path),
    directory,
    'verifier inputs must share a directory',
  )
const verify = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-e',
    'HOME=/work/home',
    '-v',
    `${directory}:/work`,
    '-w',
    '/work',
    'ghcr.io/sigstore/cosign/cosign:v2.5.3',
    'verify-blob',
    '--key',
    `/work/${basename(publicKey)}`,
    '--signature',
    `/work/${basename(signature)}`,
    `/work/${basename(artifact)}`,
  ],
  { encoding: 'utf8' },
)
if (verify.status !== 0) throw new Error(verify.stderr || verify.stdout)
const sha256 = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex')
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
assert.equal(policy.revoked, false, 'signer is revoked')
assert(Date.parse(policy.validUntil) > Date.now(), 'signer is expired')
assert.equal(policy.repository, repository, 'repository mismatch')
assert.equal(policy.sourceCommit, sourceCommit, 'source commit mismatch')
assert.equal(
  policy.artifactSha256,
  sha256(readFileSync(artifact)),
  'artifact digest mismatch',
)
process.stdout.write(
  `${JSON.stringify({ verified: true, repository, sourceCommit })}\n`,
)
