import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AlertLifecycle,
  MULTI_WINDOW_BURN_RATE,
  evaluateBurnRate,
} from '../packages/production-observability/src/index'

const rules = readFileSync('infra/observability/alerts.v1.yml', 'utf8')
for (const marker of [
  '14.4',
  '6',
  'severity: page',
  'owner:',
  'runbook:',
  'RestoreOrBackupFailed',
  'RegionFailoverBudgetExceeded',
])
  assert(rules.includes(marker), `missing alert contract ${marker}`)
const lifecycle = new AlertLifecycle()
const states: string[] = []
const injected = {
  objective: 0.999,
  shortGood: 950,
  shortTotal: 1000,
  longGood: 9500,
  longTotal: 10000,
}
for (const rule of MULTI_WINDOW_BURN_RATE.slice(0, 2)) {
  const firing = evaluateBurnRate(injected, rule)
  assert(firing)
  states.push(lifecycle.evaluate(firing).current)
}
const healthy = {
  objective: 0.999,
  shortGood: 1000,
  shortTotal: 1000,
  longGood: 10000,
  longTotal: 10000,
}
assert.equal(
  lifecycle.evaluate(evaluateBurnRate(healthy, MULTI_WINDOW_BURN_RATE[0]!))
    .current,
  'inactive',
)
states.push(lifecycle.state)
console.log(
  JSON.stringify({
    gate: 'wp27:alerts',
    accepted: true,
    failureInjection: 'firing',
    recovery: 'inactive',
    states,
    multiWindowRules: MULTI_WINDOW_BURN_RATE.length,
    pagingOwner: true,
    runbookLinks: true,
  }),
)
