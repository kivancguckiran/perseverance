import { describe, expect, it } from 'vitest'
import {
  DeterministicBillingEmulator,
  evaluateAdmission,
  type CommercialPolicySnapshot,
} from './index.js'

const scope = { tenantId: 'org_1', organizationId: 'org_1', workspaceId: 'w_1' }
const snapshot: CommercialPolicySnapshot = {
  plan: {
    ...scope,
    schemaVersion: 1,
    planId: 'beta',
    planVersion: 4,
    displayName: 'Beta',
    currency: 'USD',
    effectiveAt: '2026-07-18T00:00:00.000Z',
    retiredAt: null,
    billingMode: 'hybrid',
    taxBehavior: 'unknown',
  },
  entitlements: [
    {
      ...scope,
      schemaVersion: 1,
      entitlementId: 'turn',
      planId: 'beta',
      planVersion: 4,
      key: 'turn.start',
      enabled: true,
      effectiveAt: '2026-07-18T00:00:00.000Z',
      expiresAt: null,
      sourceWebhookEventId: null,
    },
  ],
  budgets: [],
  quotas: [
    {
      ...scope,
      schemaVersion: 1,
      quotaId: 'spend',
      policyVersion: 7,
      meter: 'provider_spend_micros',
      softLimit: 800,
      hardLimit: 1000,
      inFlightPolicy: 'continue',
      effectiveAt: '2026-07-18T00:00:00.000Z',
      expiresAt: null,
    },
  ],
}

describe('commercial admission', () => {
  const request = (spend: number) => ({
    ...scope,
    schemaVersion: 1 as const,
    operation: 'turn.start' as const,
    measurements: { provider_spend_micros: spend },
    measurementWatermark: `ledger:${spend}`,
    evaluatedAt: '2026-07-18T10:00:00.000Z',
  })
  it('warns at soft limit and denies fail-closed at hard limit', () => {
    expect(evaluateAdmission(request(800), snapshot)).toMatchObject({
      outcome: 'warn',
      reason: 'SOFT_LIMIT_PROVIDER_SPEND_MICROS',
      policyVersion: 7,
    })
    expect(evaluateAdmission(request(1000), snapshot)).toMatchObject({
      outcome: 'deny',
      reason: 'HARD_LIMIT_PROVIDER_SPEND_MICROS',
      policyVersion: 7,
    })
  })
  it('is deterministic for a measurement watermark', () => {
    expect(evaluateAdmission(request(1), snapshot)).toEqual(
      evaluateAdmission(request(1), snapshot),
    )
  })
  it('denies disabled entitlements and adversarial corpus/concurrency capacity', () => {
    const disabled = structuredClone(snapshot)
    disabled.entitlements[0]!.enabled = false
    expect(evaluateAdmission(request(0), disabled)).toMatchObject({
      outcome: 'deny',
      reason: 'ENTITLEMENT_DISABLED',
    })
    const constrained: CommercialPolicySnapshot = {
      ...snapshot,
      entitlements: [
        {
          ...snapshot.entitlements[0]!,
          entitlementId: 'upload',
          key: 'source.upload',
        },
      ],
      quotas: [
        {
          ...snapshot.quotas[0]!,
          quotaId: 'bytes',
          meter: 'corpus_byte',
          hardLimit: 10,
          softLimit: 8,
        },
      ],
    }
    expect(
      evaluateAdmission(
        {
          ...request(0),
          operation: 'source.upload',
          measurements: { corpus_byte: 10 },
          measurementWatermark: 'corpus:10',
        },
        constrained,
      ),
    ).toMatchObject({ outcome: 'deny', reason: 'HARD_LIMIT_CORPUS_BYTE' })
  })
})

describe('billing webhook emulator', () => {
  it('verifies signature, timestamp, bounded payload and replay protection without claiming production evidence', () => {
    const emulator = new DeterministicBillingEmulator({
      secret: Buffer.alloc(32, 7),
    })
    const payload = Buffer.from('{"type":"subscription.updated"}')
    const timestamp = Date.parse('2026-07-18T10:00:00.000Z')
    const signature = emulator.sign(payload, timestamp)
    expect(
      emulator.verify({
        payload,
        timestamp,
        signature,
        replayKey: 'evt_1',
        now: new Date(timestamp),
      }),
    ).toMatchObject({
      productionEvidence: false,
      provider: 'deterministic-billing-emulator',
    })
    expect(() =>
      emulator.verify({
        payload,
        timestamp,
        signature,
        replayKey: 'evt_1',
        now: new Date(timestamp),
      }),
    ).toThrow('REPLAY_REJECTED')
  })
  it('rejects stale timestamps, invalid signatures, and oversized payloads', () => {
    const emulator = new DeterministicBillingEmulator({
      secret: Buffer.alloc(32, 8),
      maxPayloadBytes: 8,
      toleranceMs: 1_000,
    })
    const payload = Buffer.from('{}')
    const timestamp = Date.parse('2026-07-18T10:00:00.000Z')
    expect(() =>
      emulator.verify({
        payload,
        timestamp,
        signature: 'bad',
        replayKey: 'bad',
        now: new Date(timestamp),
      }),
    ).toThrow('SIGNATURE_INVALID')
    expect(() =>
      emulator.verify({
        payload,
        timestamp,
        signature: emulator.sign(payload, timestamp),
        replayKey: 'stale',
        now: new Date(timestamp + 2_000),
      }),
    ).toThrow('TIMESTAMP_INVALID')
    expect(() => emulator.sign(Buffer.alloc(9), timestamp)).toThrow(
      'PAYLOAD_TOO_LARGE',
    )
  })
})
