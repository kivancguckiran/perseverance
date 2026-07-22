import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { failNotRun, machineEvidence } from './wp30-evidence'

const gate = 'wp30:browser-mobile'
const required = [
  'WP30_PRODUCTION_GOLDEN_URL',
  'WP30_BROWSER_SESSION',
  'WP30_GOLDEN_READY_SELECTOR',
  'WP30_GOLDEN_APPROVAL_SELECTOR',
  'WP30_GOLDEN_APPROVAL_BUTTON',
  'WP30_GOLDEN_RESOLVED_SELECTOR',
] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length) failNotRun(gate, missing)
const exec = promisify(execFile)
const browser = async (...args: string[]) =>
  (
    await exec('agent-browser', args, {
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: process.env.WP30_BROWSER_SESSION,
      },
      maxBuffer: 20 * 1024 * 1024,
    })
  ).stdout.trim()
const url = new URL(process.env.WP30_PRODUCTION_GOLDEN_URL!)
assert(
  !url.username && !url.password && !url.search,
  'golden URL must not contain credentials or query data',
)
try {
  await browser('open', url.toString())
  await browser('wait', process.env.WP30_GOLDEN_READY_SELECTOR!)
  const viewports = [
    [1280, 720],
    [768, 1024],
    [390, 844],
  ] as const
  for (const [width, height] of viewports) {
    await browser('set', 'viewport', String(width), String(height))
    const result = JSON.parse(
      await browser(
        'eval',
        `JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,ready:Boolean(document.querySelector(${JSON.stringify(process.env.WP30_GOLDEN_READY_SELECTOR)})),approval:Boolean(document.querySelector(${JSON.stringify(process.env.WP30_GOLDEN_APPROVAL_SELECTOR)}))})`,
      ),
    )
    const layout = typeof result === 'string' ? JSON.parse(result) : result
    assert.equal(layout.width, width)
    assert.equal(layout.overflow, false)
    assert.equal(layout.ready, true)
    assert.equal(layout.approval, true)
  }
  const sessionIdentityBefore = await browser('eval', 'location.pathname')
  await browser('reload')
  await browser('wait', process.env.WP30_GOLDEN_READY_SELECTOR!)
  const sessionIdentityAfter = await browser('eval', 'location.pathname')
  assert.equal(sessionIdentityAfter, sessionIdentityBefore)
  await browser('click', process.env.WP30_GOLDEN_APPROVAL_BUTTON!)
  await browser('wait', process.env.WP30_GOLDEN_RESOLVED_SELECTOR!)
  const errors = await browser(
    'eval',
    `JSON.stringify({errorOverlay:Boolean(document.querySelector('vite-error-overlay,[data-error-overlay]')),resolved:Boolean(document.querySelector(${JSON.stringify(process.env.WP30_GOLDEN_RESOLVED_SELECTOR)})),overflow:document.documentElement.scrollWidth>innerWidth})`,
  )
  const finalState = typeof errors === 'string' ? JSON.parse(errors) : errors
  assert.equal(finalState.errorOverlay, false)
  assert.equal(finalState.resolved, true)
  assert.equal(finalState.overflow, false)
  machineEvidence(gate, {
    accepted: true,
    status: 'passed',
    liveProductionTarget: true,
    authenticatedExistingBrowserSession: true,
    viewports: viewports.map(([width, height]) => `${width}x${height}`),
    reloadReconnectPreservedSession: true,
    approvalResolved: true,
    errorOverlay: false,
  })
} finally {
  await browser('close').catch(() => undefined)
}
