import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { SpawnSyncReturns } from 'node:child_process'
import { sha256 } from './wp30-local'

export const ZAP_ALERT_EXIT_CODES = [0, 1, 2] as const
export const ZAP_SHM_SIZE = '1g'
export const ZAP_JVM_OPTIONS =
  '-Xms512m -Xmx1536m -XX:+ExitOnOutOfMemoryError -XX:ErrorFile=/zap/wrk/crash/hs_err_pid%p.log'

type ZapSite = {
  '@name'?: unknown
  alerts?: Array<{ riskdesc?: string }>
}

export type ValidatedZapReport = {
  report: Record<string, unknown>
  content: string
  alerts: Array<{ riskdesc?: string }>
  highOrCritical: number
  version: string
  generatedAt: string
}

export type ZapAttemptMeasurement = {
  attempt: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  reportValid: boolean
  reportSha256: string | null
  crashFiles: string[]
  infrastructureFailure: string | null
}

export type ZapScanResult = ValidatedZapReport & {
  exitCode: number
  retryCount: number
  attempts: ZapAttemptMeasurement[]
}

const normalizedOrigin = (value: string) => {
  const url = new URL(value)
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`
}

export function validateZapReport(
  content: string,
  expectedTarget: string,
): ValidatedZapReport {
  assert(content.trim().length > 0, 'ZAP report is empty')
  let report: Record<string, unknown>
  try {
    report = JSON.parse(content) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `ZAP report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  assert.equal(
    report['@programName'],
    'ZAP',
    'ZAP report program metadata missing',
  )
  assert.match(
    String(report['@version'] ?? ''),
    /^\d+\.\d+\.\d+$/,
    'ZAP report version metadata missing',
  )
  const generatedAt = String(report.created ?? report['@generated'] ?? '')
  assert(
    generatedAt.length > 0 && Number.isFinite(Date.parse(generatedAt)),
    'ZAP report generation metadata missing',
  )
  const sites = report.site
  assert(Array.isArray(sites), 'ZAP report site metadata missing')
  const expectedOrigin = normalizedOrigin(expectedTarget)
  assert(
    (sites as ZapSite[]).some((site) => {
      try {
        return normalizedOrigin(String(site['@name'])) === expectedOrigin
      } catch {
        return false
      }
    }),
    `ZAP report does not contain expected target ${expectedOrigin}`,
  )
  const statistics = report.statistics as Record<string, unknown> | undefined
  assert(statistics, 'ZAP report statistics metadata missing')
  for (const job of [
    'stats.auto.job.spider.run',
    'stats.auto.job.spiderAjax.run',
    'stats.auto.job.activeScan.run',
  ])
    assert(
      Number(statistics[job] ?? 0) >= 1,
      `ZAP report missing completed scan metadata ${job}`,
    )
  assert.deepEqual(report.afPlanErrors ?? [], [], 'ZAP automation plan failed')
  const alerts = (sites as ZapSite[]).flatMap((site) => site.alerts ?? [])
  const highOrCritical = alerts.filter((item) =>
    ['High', 'Critical'].includes(item.riskdesc?.split(' ')[0] ?? ''),
  ).length
  return {
    report,
    content,
    alerts,
    highOrCritical,
    version: String(report['@version']),
    generatedAt,
  }
}

const infrastructureReason = (
  processResult: SpawnSyncReturns<string>,
  crashFiles: string[],
  reportError: unknown,
  validated: ValidatedZapReport | null,
) => {
  if (processResult.error)
    return `container process error: ${processResult.error.message}`
  if (processResult.signal)
    return `container process terminated by signal ${processResult.signal}`
  if (processResult.status == null)
    return 'container process returned no exit code'
  if (processResult.status >= 128)
    return `container process crash exit code ${processResult.status}`
  if (!ZAP_ALERT_EXIT_CODES.includes(processResult.status as 0 | 1 | 2))
    return `undocumented ZAP exit code ${processResult.status}`
  if (crashFiles.length > 0)
    return `ZAP JVM crash file produced: ${crashFiles.join(', ')}`
  if (reportError)
    return reportError instanceof Error
      ? reportError.message
      : String(reportError)
  if (processResult.status === 1 && validated?.highOrCritical === 0)
    return 'ZAP exit code 1 without a reportable High/Critical alert'
  return null
}

export function runZapScan(options: {
  label: string
  target: string
  work: string
  image: string
  planContent: string
  maxAttempts?: number
  execute: (args: string[]) => SpawnSyncReturns<string>
  persistRaw: (name: string, value: string | Buffer) => unknown
}): ZapScanResult {
  const maxAttempts = options.maxAttempts ?? 2
  assert(maxAttempts >= 1 && maxAttempts <= 2)
  const reportPath = join(options.work, 'raw/zap-report.json')
  const attempts: ZapAttemptMeasurement[] = []
  mkdirSync(join(options.work, 'raw'), { recursive: true })
  writeFileSync(join(options.work, 'zap.yaml'), options.planContent)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    rmSync(reportPath, { force: true })
    const crashDirectory = join(options.work, 'crash')
    const homeDirectory = join(options.work, `home-attempt-${attempt}`)
    rmSync(crashDirectory, { recursive: true, force: true })
    rmSync(homeDirectory, { recursive: true, force: true })
    mkdirSync(crashDirectory, { recursive: true })
    mkdirSync(homeDirectory, { recursive: true })
    writeFileSync(
      join(homeDirectory, '.ZAP_JVM.properties'),
      `${ZAP_JVM_OPTIONS}\n`,
    )
    const result = options.execute([
      'run',
      '--rm',
      '--name',
      `wp30-zap-${options.label}-${process.pid}-${attempt}`,
      '--label',
      'persistent.wp30.local=true',
      '--network',
      'persistent-wp30-local',
      '--shm-size',
      ZAP_SHM_SIZE,
      '-v',
      `${options.work}:/zap/wrk:rw`,
      '-v',
      `${homeDirectory}:/home/zap/.ZAP:rw`,
      options.image,
      'zap.sh',
      '-cmd',
      '-autorun',
      '/zap/wrk/zap.yaml',
    ])
    options.persistRaw(
      `scanners/zap-${options.label}-attempt-${attempt}.log`,
      `${result.stdout}${result.stderr}`,
    )
    const crashFiles = readdirSync(crashDirectory)
      .filter((name) => /^hs_err_pid\d+\.log$/.test(name))
      .sort()
    for (const name of crashFiles)
      options.persistRaw(
        `scanners/zap-${options.label}-attempt-${attempt}-${name}`,
        readFileSync(join(crashDirectory, name)),
      )

    let validated: ValidatedZapReport | null = null
    let reportError: unknown = null
    let reportContent: string | null = null
    try {
      assert(existsSync(reportPath), 'ZAP report was not created')
      assert(statSync(reportPath).size > 0, 'ZAP report is empty')
      reportContent = readFileSync(reportPath, 'utf8')
      validated = validateZapReport(reportContent, options.target)
    } catch (error) {
      reportError = error
      if (existsSync(reportPath)) {
        reportContent = readFileSync(reportPath, 'utf8')
        options.persistRaw(
          `scanners/zap-${options.label}-attempt-${attempt}-invalid-report.json`,
          reportContent,
        )
      }
    }
    const failure = infrastructureReason(
      result,
      crashFiles,
      reportError,
      validated,
    )
    const measurement: ZapAttemptMeasurement = {
      attempt,
      exitCode: result.status,
      signal: result.signal,
      reportValid: validated !== null,
      reportSha256: validated ? sha256(validated.content) : null,
      crashFiles,
      infrastructureFailure: failure,
    }
    attempts.push(measurement)
    options.persistRaw(
      `scanners/zap-${options.label}-attempt-${attempt}-measurement.json`,
      JSON.stringify(measurement),
    )
    if (failure) {
      if (attempt < maxAttempts) continue
      throw new Error(
        `ZAP ${options.label} infrastructure failure after ${attempt} attempt(s): ${failure}`,
      )
    }
    assert(validated)
    assert.notEqual(result.status, null)
    options.persistRaw(`scanners/zap-${options.label}.json`, validated.content)
    return {
      ...validated,
      exitCode: result.status,
      retryCount: attempt - 1,
      attempts,
    }
  }
  throw new Error(`ZAP ${options.label} exhausted attempts`)
}
