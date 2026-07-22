import { createHash } from 'node:crypto'
import {
  goNoGoRecordSchema,
  productionBudgetObservationSchema,
  productionBudgetPolicySchema,
  productionRolloutRecordSchema,
  type GoNoGoRecord,
  type ProductionBudgetObservation,
  type ProductionBudgetPolicy,
  type ProductionRolloutRecord,
  type ProductionRolloutStage,
} from './contracts'

export * from './contracts'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export const sha256 = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex')

export const evaluateProductionBudget = (
  observation: ProductionBudgetObservation,
  policy: ProductionBudgetPolicy,
) => {
  const metrics = productionBudgetObservationSchema.parse(observation)
  const thresholds = productionBudgetPolicySchema.parse(policy)
  const breached: string[] = []
  if (metrics.requestCount < thresholds.minimumRequests)
    breached.push('minimumRequests')
  if (metrics.successRate < thresholds.minimumSuccessRate)
    breached.push('minimumSuccessRate')
  if (metrics.errorBudgetBurnRate > thresholds.maximumErrorBudgetBurnRate)
    breached.push('maximumErrorBudgetBurnRate')
  if (metrics.tenantFairnessRatio < thresholds.minimumTenantFairnessRatio)
    breached.push('minimumTenantFairnessRatio')
  if (metrics.p95LatencyMs > thresholds.maximumP95LatencyMs)
    breached.push('maximumP95LatencyMs')
  if (metrics.eventLagP95Ms > thresholds.maximumEventLagP95Ms)
    breached.push('maximumEventLagP95Ms')
  if (metrics.backlog > thresholds.maximumBacklog)
    breached.push('maximumBacklog')
  if (metrics.dataLoss > 0) breached.push('dataLoss')
  if (metrics.uncontrolledDuplicates > 0)
    breached.push('uncontrolledDuplicates')
  if (metrics.fenceViolations > 0) breached.push('fenceViolations')
  return { healthy: breached.length === 0, breached: breached.sort() } as const
}

const rolloutOrder: readonly ProductionRolloutStage[] = [
  'internal',
  'design_partner',
  'limited_beta',
  'production_cohort',
]

export interface ProductionTransitionInput {
  expectedVersion: number
  idempotencyKey: string
  commandSha256: string
  next: ProductionRolloutStage
  cohortId: string
  budget?: ReturnType<typeof evaluateProductionBudget>
  rollbackVerified?: boolean
  operatorHalt?: boolean
}

export const transitionProductionRollout = (
  currentInput: ProductionRolloutRecord,
  input: ProductionTransitionInput,
): ProductionRolloutRecord => {
  const current = productionRolloutRecordSchema.parse(currentInput)
  const previousCommand = current.idempotency[input.idempotencyKey]
  if (previousCommand && previousCommand !== input.commandSha256)
    throw new Error('PRODUCTION_ROLLOUT_IDEMPOTENCY_CONFLICT')
  if (previousCommand) return current
  if (current.version !== input.expectedVersion)
    throw new Error('PRODUCTION_ROLLOUT_VERSION_CONFLICT')

  if (input.next === 'halted') {
    if (input.budget?.healthy !== false && input.operatorHalt !== true)
      throw new Error('PRODUCTION_ROLLOUT_HALT_REQUIRES_BREACH_OR_OPERATOR')
  } else if (input.next === 'rolled_back') {
    if (
      current.stage !== 'halted' ||
      !current.previousArtifactSha256 ||
      input.rollbackVerified !== true
    )
      throw new Error('PRODUCTION_ROLLOUT_ROLLBACK_PRECONDITION_FAILED')
  } else {
    if (current.killSwitch)
      throw new Error('PRODUCTION_ROLLOUT_KILL_SWITCH_ACTIVE')
    if (!current.featureFlagEnabled)
      throw new Error('PRODUCTION_ROLLOUT_FEATURE_FLAG_DISABLED')
    if (input.budget?.healthy !== true)
      throw new Error('PRODUCTION_ROLLOUT_BUDGET_NOT_HEALTHY')
    if (
      rolloutOrder.indexOf(input.next) !==
      rolloutOrder.indexOf(current.stage) + 1
    )
      throw new Error('PRODUCTION_ROLLOUT_INVALID_TRANSITION')
  }

  const command = {
    from: current.stage,
    to: input.next,
    expectedVersion: input.expectedVersion,
    cohortId: input.cohortId,
    commandSha256: input.commandSha256,
    previousHistorySha256: current.historyHeadSha256,
  }
  return productionRolloutRecordSchema.parse({
    ...current,
    stage: input.next,
    version: current.version + 1,
    cohortId: input.cohortId,
    artifactSha256:
      input.next === 'rolled_back'
        ? current.previousArtifactSha256
        : current.artifactSha256,
    killSwitch: current.killSwitch || input.next === 'halted',
    idempotency: {
      ...current.idempotency,
      [input.idempotencyKey]: input.commandSha256,
    },
    historyHeadSha256: sha256(command),
  })
}

export const appendGoNoGoRecord = (
  records: readonly GoNoGoRecord[],
  input: Omit<
    GoNoGoRecord,
    'contractVersion' | 'previousRecordSha256' | 'recordSha256'
  >,
): readonly GoNoGoRecord[] => {
  const previousRecordSha256 = records.at(-1)?.recordSha256 ?? null
  const recordBase = {
    contractVersion: 1 as const,
    ...input,
    previousRecordSha256,
  }
  const record = goNoGoRecordSchema.parse({
    ...recordBase,
    recordSha256: sha256(recordBase),
  })
  return [...records, record]
}
