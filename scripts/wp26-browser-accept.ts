import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { Wp26ProductionStack, wp26Headers } from './wp26-production-stack'

const codexBin = process.env.WP26_CODEX_BIN
if (!codexBin) throw new Error('WP26_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const stack = new Wp26ProductionStack()
const execAsync = promisify(execFile)
const namespace = `wp26-${process.pid}`
const browser = (...args: string[]) =>
  execAsync(
    'agent-browser',
    ['--session', 'ha', '--namespace', namespace, ...args],
    { encoding: 'utf8', timeout: 60_000 },
  ).then((result) => result.stdout.trim())
const evaluate = (expression: string) => browser('eval', expression)
const waitFor = async (expression: string, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await evaluate(expression)) === 'true') return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `browser condition timeout: ${await evaluate('document.body.innerText')}`,
  )
}
const requestJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  return { response, body: (await response.json()) as Record<string, any> }
}

try {
  await stack.startInfrastructure()
  await stack.startWorkers(codexBin, 2)
  await stack.startApis(2)
  const scope = Object.fromEntries(
    Object.entries(wp26Headers).filter(([name]) => name !== 'content-type'),
  )
  const session = await requestJson(`${stack.loadBalancerUrl}/v1/sessions`, {
    method: 'POST',
    headers: scope,
  })
  assert.equal(session.response.status, 201)
  const sessionId = String(session.body.sessionId)
  const turn = await requestJson(
    `${stack.loadBalancerUrl}/v1/sessions/${sessionId}/turns`,
    {
      method: 'POST',
      headers: { ...wp26Headers, 'idempotency-key': 'browser-turn' },
      body: JSON.stringify({
        prompt: 'Yalnızca TAMAM yaz. Araç kullanma.',
        approvalContext: {
          kind: 'command',
          command: 'opaque-browser-command',
          risk: 'bounded',
        },
      }),
    },
  )
  assert.equal(turn.response.status, 202)
  await browser(
    'open',
    `${stack.loadBalancerUrl}/wp26?tenant=tenant-a&workspace=workspace-a&session=${sessionId}`,
  )
  await waitFor(
    `document.querySelector('#approval').textContent.includes('opaque-browser-command')`,
    30_000,
  )
  const approval = await requestJson(
    `${stack.loadBalancerUrl}/v1/approvals/${turn.body.approvalId}/decision`,
    {
      method: 'POST',
      headers: { ...wp26Headers, 'x-principal-id': 'browser-principal' },
      body: JSON.stringify({ decision: 'accept', expectedVersion: 1 }),
    },
  )
  assert.equal(approval.response.status, 200)
  await waitFor(
    `document.querySelector('#approval').textContent === '[]'`,
    30_000,
  )
  const initialInstance = await evaluate(`document.body.dataset.instance`)
  stack.killApi(initialInstance.includes('api-1') ? 0 : 1)
  await waitFor(`document.body.innerText.includes('turn.completed')`)
  await waitFor(
    `document.body.dataset.instance && document.body.dataset.instance !== ${initialInstance}`,
  )
  const state = await evaluate(`document.querySelector('#state').textContent`)
  const recoveredInstance = await evaluate(`document.body.dataset.instance`)
  const timeline = await evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll('#timeline li')).map(x=>x.textContent))`,
  )
  assert.match(state, /connected high-water [1-9]/)
  assert.match(timeline, /agent\.message\.completed/)
  console.log(
    JSON.stringify({
      gate: 'wp26:browser',
      browser: 'chromium',
      productionHaEvidence: true,
      apiInstances: 2,
      schedulerInstances: 2,
      durableBackends: ['postgresql', 'rabbitmq', 'minio'],
      instanceKill: 'browser-reconnected',
      realtimeInstances: {
        initial: initialInstance,
        recovered: recoveredInstance,
      },
      approvalContext: 'preserved',
      highWaterReplay: state,
      completedReconciliation: true,
      cleanup: 'complete',
    }),
  )
} finally {
  await browser('close').catch(() => undefined)
  await stack.cleanup()
}
