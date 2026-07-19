import { describe, expect, it } from 'vitest'
import { resolveProductionTopology } from './topology-composition'

const production = {
  EVENT_STORE_BACKEND: 'postgresql',
  SCHEDULER_QUEUE_BACKEND: 'postgresql',
  SCHEDULER_LOCK_BACKEND: 'postgresql',
  ARTIFACT_STORAGE_BACKEND: 'object-storage',
  ATTACHMENT_STORAGE_BACKEND: 'object-storage',
  SOURCE_STORAGE_BACKEND: 'object-storage',
  PERSISTENT_INSTANCE_ID: 'api-eu-1-a',
  PERSISTENT_INSTANCE_ROLE: 'api',
  TOPOLOGY_DATABASE_URL: 'postgresql://runtime/database',
  EVENT_BROKER_READINESS_URL: 'http://broker/ready',
  OBJECT_STORAGE_READINESS_URL: 'http://object/ready',
  RUNTIME_CONTROL_READINESS_URL: 'http://runtime/ready',
  KMS_READINESS_URL: 'http://kms/ready',
}

describe('production topology composition', () => {
  it('keeps explicit local alpha outside production requirements', () => {
    expect(
      resolveProductionTopology({ PERSISTENT_CODEX_LOCAL_ALPHA: '1' }),
    ).toBeNull()
  })
  it('rejects SQLite, filesystem, memory and cache fallbacks', () => {
    expect(() => resolveProductionTopology({})).toThrow(
      'PRODUCTION_FALLBACK_FORBIDDEN',
    )
    expect(() =>
      resolveProductionTopology({
        ...production,
        SCHEDULER_LOCK_BACKEND: 'cache',
      }),
    ).toThrow('PRODUCTION_FALLBACK_FORBIDDEN:locks')
  })
  it('requires every readiness endpoint after durable adapters are selected', () => {
    const missing = { ...production }
    delete (missing as Partial<typeof production>).KMS_READINESS_URL
    expect(() => resolveProductionTopology(missing)).toThrow(
      'KMS_READINESS_URL',
    )
    expect(resolveProductionTopology(production)).toMatchObject({
      instanceId: 'api-eu-1-a',
      role: 'api',
    })
  })
})
