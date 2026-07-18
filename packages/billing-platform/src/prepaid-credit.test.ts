import { describe, expect, it } from 'vitest'
import {
  creditLedgerEntrySchema,
  creditReservationSchema,
  financialProjectionSchema,
  retailPriceCatalogSchema,
} from './contracts.js'
import { normalizeBillingWebhookPayload } from './index.js'

const scope = {
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
}

describe('WP24 prepaid credit contracts', () => {
  it('normalizes paid purchase without retaining payment instrument payload', () => {
    const value = normalizeBillingWebhookPayload({
      schemaVersion: 1,
      ...scope,
      eventId: 'event-purchase',
      eventType: 'credit.purchase',
      providerSequence: 1,
      effectiveAt: '2026-07-18T00:00:00.000Z',
      data: {
        currency: 'USD',
        creditsMicros: 1_000,
        cashAmountMicros: 1_000,
        paymentReference: 'payment-reference',
        expiresAt: null,
      },
    })
    expect(value.command.kind).toBe('credit.purchase')
    expect(JSON.stringify(value.command)).not.toMatch(
      /card|credential|signature|secret/i,
    )
  })

  it('requires scoped append-only ledger references', () => {
    expect(
      creditLedgerEntrySchema.parse({
        schemaVersion: 1,
        ...scope,
        ledgerEntryId: 'entry-1',
        ledgerSequence: 1,
        lotId: 'lot-1',
        entryType: 'usage_settlement',
        currency: 'USD',
        creditAmountMicros: 50,
        cashAmountMicros: 0,
        idempotencyKey: 'settlement-entry-1',
        paymentReference: null,
        usageDedupeKey: 'usage-1',
        runId: 'run-1',
        operationReference: 'turn-1',
        reservationId: 'reservation-1',
        settlementId: 'settlement-1',
        sourceWebhookEventId: null,
        occurredAt: '2026-07-18T00:00:00.000Z',
      }).entryType,
    ).toBe('usage_settlement')
  })

  it('keeps unresolved incomplete reservation visible', () => {
    expect(
      creditReservationSchema.parse({
        schemaVersion: 1,
        ...scope,
        reservationId: 'reservation-1',
        currency: 'USD',
        idempotencyKey: 'reservation-key',
        operation: 'turn.start',
        retailPriceCatalogVersion: 'retail-v1',
        maximumCreditsMicros: 100,
        settledCreditsMicros: 25,
        releasedCreditsMicros: 0,
        unresolvedCreditsMicros: 75,
        state: 'partially_settled',
        version: 2,
        paymentReference: null,
        usageDedupeKey: 'usage-incomplete',
        runId: 'run-incomplete',
        operationReference: 'turn-incomplete',
        occurredAt: '2026-07-18T00:00:00.000Z',
        resolvedAt: null,
      }).unresolvedCreditsMicros,
    ).toBe(75)
  })

  it('defines versioned retail pricing and operational financial formulas', () => {
    expect(
      retailPriceCatalogSchema.parse({
        schemaVersion: 1,
        ...scope,
        catalogId: 'retail',
        catalogVersion: 'retail-v1',
        currency: 'USD',
        rates: [{ meter: 'provider_input_token', creditsMicrosPerUnit: 1 }],
        operationMaximums: [
          { operation: 'turn.start', maximumCreditsMicros: 100 },
        ],
        idempotencyKey: 'retail-v1',
        paymentReference: null,
        usageDedupeKey: null,
        runId: null,
        operationReference: null,
        occurredAt: '2026-07-18T00:00:00.000Z',
        effectiveAt: '2026-07-18T00:00:00.000Z',
        retiredAt: null,
      }).catalogVersion,
    ).toBe('retail-v1')
    const projection = financialProjectionSchema.parse({
      schemaVersion: 1,
      ...scope,
      projectionId: 'projection-1',
      currency: 'USD',
      retailPriceCatalogVersion: 'retail-v1',
      ledgerWatermark: 'clw_10',
      idempotencyKey: 'projection-clw-10',
      paymentReference: null,
      usageDedupeKey: null,
      runId: null,
      operationReference: null,
      occurredAt: '2026-07-18T00:00:00.000Z',
      cashCollectedMicros: 1_000,
      outstandingPaidCreditLiabilityMicros: 700,
      consumedPaidCreditRevenueMicros: 300,
      promotionalConsumptionMicros: 50,
      refundsMicros: 0,
      chargebacksMicros: 0,
      providerCogsMicros: 100,
      infrastructureCogsMicros: 25,
      grossMarginMicros: 175,
      projectedAt: '2026-07-18T00:00:00.000Z',
      accountingStatus: 'operational_projection_not_tax_advice',
    })
    expect(projection.grossMarginMicros).toBe(
      projection.consumedPaidCreditRevenueMicros -
        projection.providerCogsMicros -
        projection.infrastructureCogsMicros,
    )
  })
})
