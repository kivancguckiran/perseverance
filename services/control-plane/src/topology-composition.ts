import { Pool } from 'pg'
import {
  assertProductionStorage,
  evaluateDependencyReadiness,
  type DependencyReadiness,
} from '@persistent-codex/production-topology'

export interface ProductionTopologyConfig {
  instanceId: string
  role: DependencyReadiness['role']
  databaseUrl: string
  readinessUrls: {
    eventBroker: string
    objectStorage: string
    runtimeControl: string
    kms: string
  }
}

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Production requires ${name}`)
  return value
}

export function resolveProductionTopology(
  env: NodeJS.ProcessEnv,
): ProductionTopologyConfig | null {
  if (env.PERSISTENT_CODEX_LOCAL_ALPHA === '1') return null
  assertProductionStorage({
    eventStore:
      env.EVENT_STORE_BACKEND === 'postgresql' ? 'postgresql' : 'sqlite',
    queue:
      env.SCHEDULER_QUEUE_BACKEND === 'postgresql' ? 'postgresql' : 'memory',
    locks:
      env.SCHEDULER_LOCK_BACKEND === 'postgresql'
        ? 'postgresql'
        : env.SCHEDULER_LOCK_BACKEND === 'cache'
          ? 'cache'
          : 'memory',
    artifacts:
      env.ARTIFACT_STORAGE_BACKEND === 'object-storage'
        ? 'object-storage'
        : 'filesystem',
    attachments:
      env.ATTACHMENT_STORAGE_BACKEND === 'object-storage'
        ? 'object-storage'
        : 'filesystem',
    sources:
      env.SOURCE_STORAGE_BACKEND === 'object-storage'
        ? 'object-storage'
        : 'filesystem',
  })
  return {
    instanceId: required(env, 'PERSISTENT_INSTANCE_ID'),
    role: (env.PERSISTENT_INSTANCE_ROLE ??
      'api') as DependencyReadiness['role'],
    databaseUrl: required(env, 'TOPOLOGY_DATABASE_URL'),
    readinessUrls: {
      eventBroker: required(env, 'EVENT_BROKER_READINESS_URL'),
      objectStorage: required(env, 'OBJECT_STORAGE_READINESS_URL'),
      runtimeControl: required(env, 'RUNTIME_CONTROL_READINESS_URL'),
      kms: required(env, 'KMS_READINESS_URL'),
    },
  }
}

async function httpProbe(url: string, signal: AbortSignal) {
  const response = await fetch(url, { method: 'HEAD', signal })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
}

export function createProductionTopologyReadiness(
  config: ProductionTopologyConfig,
): () => Promise<DependencyReadiness> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 })
  return async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_500)
    const probes = await Promise.allSettled([
      pool.query('SELECT 1'),
      httpProbe(config.readinessUrls.eventBroker, controller.signal),
      httpProbe(config.readinessUrls.objectStorage, controller.signal),
      httpProbe(config.readinessUrls.runtimeControl, controller.signal),
      httpProbe(config.readinessUrls.kms, controller.signal),
    ]).finally(() => clearTimeout(timer))
    const names = [
      'postgresql',
      'event-broker',
      'object-storage',
      'runtime-control',
      'kms',
    ] as const
    return evaluateDependencyReadiness({
      instanceId: config.instanceId,
      role: config.role,
      mode: 'production',
      dependencies: names.map((name, index) => ({
        name,
        required: true,
        ready: probes[index]?.status === 'fulfilled',
        code:
          probes[index]?.status === 'fulfilled'
            ? null
            : `${name.toUpperCase().replaceAll('-', '_')}_UNAVAILABLE`,
      })),
    })
  }
}
