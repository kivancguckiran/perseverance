import { describe, expect, it } from 'vitest'
import { resolveBillingBootstrap } from './billing-composition'

describe('WP24 main billing composition', () => {
  it('requires an explicit local emulator and durable database', () => {
    expect(() =>
      resolveBillingBootstrap({ PERSISTENT_CODEX_LOCAL_ALPHA: '1' }),
    ).toThrow('BILLING_DATABASE_URL')
    expect(() =>
      resolveBillingBootstrap({
        PERSISTENT_CODEX_LOCAL_ALPHA: '1',
        BILLING_DATABASE_URL: 'postgresql://billing/runtime',
      }),
    ).toThrow('PERSISTENT_BILLING_PROVIDER=emulator')
    expect(
      resolveBillingBootstrap({
        PERSISTENT_CODEX_LOCAL_ALPHA: '1',
        BILLING_DATABASE_URL: 'postgresql://billing/runtime',
        PERSISTENT_BILLING_PROVIDER: 'emulator',
      }),
    ).toEqual({
      localAlpha: true,
      databaseUrl: 'postgresql://billing/runtime',
      provider: 'emulator',
    })
  })

  it('forbids the emulator and missing production provider adapter', () => {
    expect(() =>
      resolveBillingBootstrap({
        BILLING_DATABASE_URL: 'postgresql://billing/runtime',
        PERSISTENT_BILLING_PROVIDER: 'emulator',
      }),
    ).toThrow('PERSISTENT_BILLING_PROVIDER=production')
    expect(() =>
      resolveBillingBootstrap({
        BILLING_DATABASE_URL: 'postgresql://billing/runtime',
        PERSISTENT_BILLING_PROVIDER: 'production',
      }),
    ).toThrow('injected production provider and secret adapter')
  })
})
