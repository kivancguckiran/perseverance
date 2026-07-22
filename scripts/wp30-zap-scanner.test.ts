import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnSyncReturns } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ZAP_JVM_OPTIONS,
  ZAP_SHM_SIZE,
  runZapScan,
  validateZapReport,
} from './wp30-zap-scanner'

const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'wp30-zap-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true })
})

const processResult = (
  status: number | null,
  signal: NodeJS.Signals | null = null,
): SpawnSyncReturns<string> => ({
  pid: 1,
  output: [null, '', ''],
  stdout: '',
  stderr: '',
  status,
  signal,
})

const report = (
  target = 'http://web:3301',
  alerts: Array<{ riskdesc: string }> = [],
) =>
  JSON.stringify({
    '@programName': 'ZAP',
    '@version': '2.17.0',
    '@generated': 'Wed, 22 Jul 2026 18:04:33 GMT',
    created: '2026-07-22T18:04:33.000Z',
    site: [{ '@name': target, alerts }],
    statistics: {
      'stats.auto.job.spider.run': 1,
      'stats.auto.job.spiderAjax.run': 1,
      'stats.auto.job.activeScan.run': 1,
    },
    afPlanErrors: [],
  })

const harness = (
  execute: (
    args: string[],
    call: number,
    work: string,
  ) => SpawnSyncReturns<string>,
) => {
  const work = directory()
  const persisted: Array<{ name: string; value: string | Buffer }> = []
  let calls = 0
  const result = runZapScan({
    label: 'web',
    target: 'http://web:3301',
    work,
    image: 'ghcr.io/zaproxy/zaproxy:stable@sha256:test',
    planContent: 'env: {}',
    execute: (args) => execute(args, ++calls, work),
    persistRaw: (name, value) => persisted.push({ name, value }),
  })
  return { result, persisted, calls, work }
}

describe('WP30 ZAP report validation', () => {
  it('requires non-empty valid JSON with the expected target and scan metadata', () => {
    expect(() => validateZapReport('', 'http://web:3301')).toThrow(/empty/)
    expect(() => validateZapReport('{', 'http://web:3301')).toThrow(
      /not valid JSON/,
    )
    expect(() =>
      validateZapReport(report('http://control-plane:3300'), 'http://web:3301'),
    ).toThrow(/expected target/)
    const missingMetadata = JSON.parse(report())
    delete missingMetadata.statistics['stats.auto.job.activeScan.run']
    expect(() =>
      validateZapReport(JSON.stringify(missingMetadata), 'http://web:3301'),
    ).toThrow(/activeScan/)
  })

  it('accepts a complete report and exposes its blocker severity', () => {
    const validated = validateZapReport(
      report('http://web:3301', [{ riskdesc: 'High (3)' }]),
      'http://web:3301',
    )
    expect(validated.version).toBe('2.17.0')
    expect(validated.highOrCritical).toBe(1)
  })
})

describe('WP30 ZAP infrastructure retry contract', () => {
  it('retries a missing crash report once without surfacing ENOENT', () => {
    const work = directory()
    let calls = 0
    expect(() =>
      runZapScan({
        label: 'web',
        target: 'http://web:3301',
        work,
        image: 'ghcr.io/zaproxy/zaproxy:stable@sha256:test',
        planContent: 'env: {}',
        execute: () => {
          calls++
          return processResult(135)
        },
        persistRaw: () => undefined,
      }),
    ).toThrow(
      /infrastructure failure after 2 attempt\(s\).*crash exit code 135/,
    )
    expect(calls).toBe(2)
  })

  it('reports a missing zap-report.json as scanner infrastructure failure', () => {
    const work = directory()
    let calls = 0
    expect(() =>
      runZapScan({
        label: 'control-plane',
        target: 'http://control-plane:3300',
        work,
        image: 'ghcr.io/zaproxy/zaproxy:stable@sha256:test',
        planContent: 'env: {}',
        execute: () => {
          calls++
          return processResult(0)
        },
        persistRaw: () => undefined,
      }),
    ).toThrow(/ZAP report was not created/)
    expect(calls).toBe(2)
  })

  it('preserves the first crash and succeeds only after a clean-container retry', () => {
    const observedArgs: string[][] = []
    const { result, persisted, calls, work } = harness((args, call, path) => {
      observedArgs.push(args)
      if (call === 1) {
        writeFileSync(join(path, 'crash/hs_err_pid7.log'), 'SIGBUS')
        return processResult(135)
      }
      writeFileSync(join(path, 'raw/zap-report.json'), report())
      return processResult(0)
    })
    expect(calls).toBe(2)
    expect(result.retryCount).toBe(1)
    expect(result.attempts.map((attempt) => attempt.exitCode)).toEqual([135, 0])
    expect(
      persisted.some((item) => item.name.endsWith('hs_err_pid7.log')),
    ).toBe(true)
    expect(observedArgs[0]).toContain('--shm-size')
    expect(observedArgs[0]).toContain(ZAP_SHM_SIZE)
    expect(observedArgs[0]).not.toEqual(observedArgs[1])
    expect(
      readFileSync(join(work, 'home-attempt-2/.ZAP_JVM.properties'), 'utf8'),
    ).toContain(ZAP_JVM_OPTIONS)
  })

  it('does not retry documented alert exits with a valid report', () => {
    const medium = harness((_args, _call, work) => {
      writeFileSync(join(work, 'raw/zap-report.json'), report())
      return processResult(2)
    })
    expect(medium.calls).toBe(1)
    expect(medium.result.exitCode).toBe(2)
    expect(medium.result.retryCount).toBe(0)

    const high = harness((_args, _call, work) => {
      writeFileSync(
        join(work, 'raw/zap-report.json'),
        report('http://web:3301', [{ riskdesc: 'High (3)' }]),
      )
      return processResult(1)
    })
    expect(high.calls).toBe(1)
    expect(high.result.exitCode).toBe(1)
    expect(high.result.highOrCritical).toBe(1)
  })

  it('retries a malformed report but retains the failed report evidence', () => {
    const { result, persisted, calls } = harness((_args, call, work) => {
      writeFileSync(
        join(work, 'raw/zap-report.json'),
        call === 1 ? '{' : report(),
      )
      return processResult(0)
    })
    expect(calls).toBe(2)
    expect(result.retryCount).toBe(1)
    expect(persisted.some((item) => item.name.includes('invalid-report'))).toBe(
      true,
    )
  })
})
