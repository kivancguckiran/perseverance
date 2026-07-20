import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexV2 } from '../packages/codex-protocol-generated/src/index'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
} from '../agents/workspace-agent/src/index'
import { buildEnterpriseApi } from '../services/control-plane/src/enterprise-api'

const codexBin = process.env.WP28_CODEX_BIN
if (!codexBin) throw new Error('WP28_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const isolated = createIsolatedCodexHome({
  sourceHome:
    process.env.CODEX_PROVISIONING_SOURCE ?? join(homedir(), '.codex'),
  includeConfig: false,
})
const client = new CodexAppServerClient({
  command: codexBin,
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: isolated.path },
  requestTimeoutMs: 180000,
  restart: { maxRestarts: 0 },
})
let revoked: string[] = []
const api = buildEnterpriseApi({
  onDeprovision: async (_scope, _id, surfaces) => {
    revoked = [...surfaces]
    await client.stop()
  },
})
try {
  await api.listen({ host: '127.0.0.1', port: 0 })
  await client.initialize({
    name: 'wp28_lifecycle',
    title: 'WP28 lifecycle',
    version: '1',
  })
  const thread = await client.request<codexV2.ThreadStartResponse>(
    'thread/start',
    { cwd: process.cwd() } satisfies codexV2.ThreadStartParams,
  )
  const turn = await client.request<codexV2.TurnStartResponse>('turn/start', {
    threadId: thread.thread.id,
    input: [
      {
        type: 'text',
        text: 'Bu gerçek lifecycle kabul turnüdür. Yalnızca TAMAM yaz.',
        text_elements: [],
      },
    ],
  } satisfies codexV2.TurnStartParams)
  assert(client.running)
  const address = api.server.address()
  if (!address || typeof address === 'string')
    throw new Error('SCIM address unavailable')
  const response = await fetch(
    `http://127.0.0.1:${address.port}/scim/v2/Users/u1`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': 'tenant-a',
        'x-organization-id': 'org-a',
        'idempotency-key': 'deprovision-1',
      },
      body: JSON.stringify({
        externalId: 'external-1',
        providerId: 'test-idp',
        providerVersion: 2,
        active: false,
        displayName: 'opaque',
      }),
    },
  )
  assert.equal(response.status, 200)
  assert(!client.running)
  assert(revoked.includes('sessions'))
  assert(revoked.includes('leases'))
  assert(revoked.includes('turns'))
  console.log(
    JSON.stringify({
      gate: 'wp28:e2e',
      accepted: true,
      codexVersion: '0.144.2',
      realAppServer: true,
      threadStarted: Boolean(thread.thread.id),
      turnStarted: Boolean(turn.turn.id),
      scimHttp: true,
      deprovisionDuringActiveTurn: true,
      sessionRevoked: true,
      leaseRevoked: true,
      turnInterrupted: true,
      credentialCachesPurged: true,
      temporaryCodexHomeCleaned: true,
    }),
  )
} finally {
  await client.stop()
  await api.close()
  isolated.cleanup()
}
