import { describe, expect, it } from 'vitest'
import {
  observedAdaptersFromEnv,
  resolveBootProfile,
} from './profile-composition'

describe('resolveBootProfile', () => {
  it('resolves local development and self-hosted production', () => {
    const selfHosted = {
      EVENT_STORE_BACKEND: 'postgresql',
      SCHEDULER_QUEUE_BACKEND: 'postgresql',
      SCHEDULER_LOCK_BACKEND: 'postgresql',
      ARTIFACT_STORAGE_BACKEND: 'object-storage',
      ATTACHMENT_STORAGE_BACKEND: 'object-storage',
      SOURCE_STORAGE_BACKEND: 'object-storage',
    }
    expect(
      resolveBootProfile({ PERSISTENT_CODEX_LOCAL_ALPHA: '1' }).profile,
    ).toBe('local')
    expect(resolveBootProfile(selfHosted).profile).toBe('self-hosted')
    expect(resolveBootProfile(selfHosted).contract.edition).toBe('community')
  })

  it('rejects unsupported deployment products', () => {
    expect(() =>
      resolveBootProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'cloud' }),
    ).toThrow('UNKNOWN_DEPLOYMENT_PROFILE:cloud')
  })
})

describe('observedAdaptersFromEnv', () => {
  it('keeps topology defaulting semantics', () => {
    expect(observedAdaptersFromEnv({})).toMatchObject({
      eventStoreBackend: 'sqlite',
      schedulerQueueBackend: 'memory',
      schedulerLockBackend: 'memory',
      artifactStorageBackend: 'filesystem',
      attachmentStorageBackend: 'filesystem',
      sourceStorageBackend: 'filesystem',
    })
  })
})
