import { describe, expect, it } from 'vitest'
import {
  appendGoNoGoRecord,
  evaluateProductionBudget,
  sha256,
  transitionProductionRollout,
  type ProductionBudgetObservation,
  type ProductionBudgetPolicy,
  type ProductionRolloutRecord,
} from './index'

const policy: ProductionBudgetPolicy = {
  minimumRequests: 1_000,
  minimumSuccessRate: 0.995,
  maximumErrorBudgetBurnRate: 1,
  minimumTenantFairnessRatio: 0.9,
  maximumP95LatencyMs: 500,
  maximumEventLagP95Ms: 1_000,
  maximumBacklog: 0,
}
const healthyObservation: ProductionBudgetObservation = {
  requestCount: 10_000,
  successRate: 0.999,
  errorBudgetBurnRate: 0.5,
  tenantFairnessRatio: 0.97,
  p95LatencyMs: 120,
  eventLagP95Ms: 80,
  backlog: 0,
  dataLoss: 0,
  uncontrolledDuplicates: 0,
  fenceViolations: 0,
}
const initial = (): ProductionRolloutRecord => ({
  contractVersion: 1,
  tenantId: 'tenant-a',
  organizationId: 'org-a',
  workspaceId: 'workspace-a',
  rolloutId: 'rollout-a',
  stage: 'internal',
  version: 1,
  cohortId: 'internal-a',
  artifactSha256: sha256('candidate'),
  previousArtifactSha256: sha256('stable'),
  featureFlagEnabled: true,
  killSwitch: false,
  idempotency: {},
  historyHeadSha256: null,
})

describe('WP30 production rollout authority', () => {
  it('promotes only adjacent healthy cohorts with optimistic locking', () => {
    const budget = evaluateProductionBudget(healthyObservation, policy)
    const designPartner = transitionProductionRollout(initial(), {
      expectedVersion: 1,
      idempotencyKey: 'promote-design',
      commandSha256: sha256('promote-design'),
      next: 'design_partner',
      cohortId: 'design-partner-a',
      budget,
    })
    expect(designPartner.version).toBe(2)
    expect(() =>
      transitionProductionRollout(designPartner, {
        expectedVersion: 1,
        idempotencyKey: 'stale',
        commandSha256: sha256('stale'),
        next: 'limited_beta',
        cohortId: 'limited-a',
        budget,
      }),
    ).toThrow('PRODUCTION_ROLLOUT_VERSION_CONFLICT')
    expect(
      transitionProductionRollout(designPartner, {
        expectedVersion: 2,
        idempotencyKey: 'promote-design',
        commandSha256: sha256('promote-design'),
        next: 'design_partner',
        cohortId: 'design-partner-a',
        budget,
      }),
    ).toEqual(designPartner)
  })

  it('halts on budget breach and rolls back without changing scope', () => {
    const broken = evaluateProductionBudget(
      { ...healthyObservation, dataLoss: 1, tenantFairnessRatio: 0.2 },
      policy,
    )
    const halted = transitionProductionRollout(initial(), {
      expectedVersion: 1,
      idempotencyKey: 'halt',
      commandSha256: sha256('halt'),
      next: 'halted',
      cohortId: 'internal-a',
      budget: broken,
    })
    expect(halted.killSwitch).toBe(true)
    const rolledBack = transitionProductionRollout(halted, {
      expectedVersion: 2,
      idempotencyKey: 'rollback',
      commandSha256: sha256('rollback'),
      next: 'rolled_back',
      cohortId: 'stable-a',
      rollbackVerified: true,
    })
    expect(rolledBack.artifactSha256).toBe(initial().previousArtifactSha256)
    expect(rolledBack.tenantId).toBe('tenant-a')
  })

  it('creates an immutable checksum-linked go/no-go chain', () => {
    const records = appendGoNoGoRecord([], {
      tenantId: 'tenant-a',
      organizationId: 'org-a',
      workspaceId: 'workspace-a',
      recordId: 'decision-a',
      rolloutId: 'rollout-a',
      decision: 'no_go',
      owner: 'release-owner',
      sourceCommit: 'a'.repeat(40),
      acceptanceReportSha256: 'b'.repeat(64),
      decidedAt: '2026-07-22T00:00:00.000Z',
    })
    expect(records[0]?.recordSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(records[0]?.previousRecordSha256).toBeNull()
  })
})
