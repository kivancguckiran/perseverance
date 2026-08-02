import { describe, expect, it } from 'vitest'
import {
  AlertLifecycle,
  MULTI_WINDOW_BURN_RATE,
  ProductionTelemetry,
  createTrace,
  evaluateBurnRate,
  opaqueScope,
  parseTraceparent,
  requireKeyAvailable,
  sealManifest,
  sealRestoreEvidence,
  sha256,
  traceparent,
  validateRestoreGraph,
  verifyManifest,
  type BackupManifest,
  type RestoreGraph,
} from './index'

const bytes = (value: string) => new TextEncoder().encode(value)
const bodies = new Map([
  ['pg-base', bytes('base')],
  ['pg-wal', bytes('wal')],
  ['keys', bytes('wrapped-metadata')],
  ['objects', bytes('ciphertext-objects')],
  ['broker', bytes('broker-watermark')],
  ['index', bytes('deterministic-index-manifest')],
  ['config', bytes('non-secret-versioned-config')],
])

const manifest = () =>
  sealManifest({
    schemaVersion: 1,
    manifestId: 'backup-1',
    authority: 'postgresql-primary',
    sourceRegion: 'eu-1',
    createdAt: '2026-07-20T10:00:00.000Z',
    consistencyWatermark: {
      capturedAt: '2026-07-20T10:00:00.000Z',
      postgresLsn: '0/16B6C50',
      eventHighWater: 42,
      objectVersionWatermark: 'object-v42',
    },
    dependencies: { codex: '0.144.2', postgres: '17', schema: '0030' },
    components: [...bodies].map(([objectKey, body]) => ({
      kind:
        objectKey === 'pg-base'
          ? ('postgres_base' as const)
          : objectKey === 'pg-wal'
            ? ('postgres_wal' as const)
            : objectKey === 'keys'
              ? ('key_metadata' as const)
              : objectKey === 'objects'
                ? ('objects' as const)
                : objectKey === 'broker'
                  ? ('event_broker' as const)
                  : objectKey === 'index'
                    ? ('index_manifest' as const)
                    : ('configuration' as const),
      objectKey,
      checksumSha256: sha256(body),
      byteLength: body.byteLength,
      encryptionKeyVersion:
        objectKey === 'keys' || objectKey === 'objects' ? 'kms-v27' : null,
      required: true,
    })),
    previousManifestSha256: null,
  })

const graph = (): RestoreGraph => {
  const first = {
    id: 'audit-1',
    previousHash: null,
    payloadHash: sha256('first'),
  }
  const firstHash = sha256(`${first.id}:${first.payloadHash}:`)
  const second = {
    id: 'audit-2',
    previousHash: firstHash,
    payloadHash: sha256('second'),
  }
  return {
    tenants: ['tenant-a', 'tenant-b'],
    workspaces: [
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      { tenantId: 'tenant-b', workspaceId: 'workspace-b' },
    ],
    sessions: [
      {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
      },
    ],
    runs: [
      {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        runId: 'run-a',
      },
    ],
    events: [1, 2].map((sequence) => ({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      eventId: `event-${sequence}`,
      sequence,
    })),
    audit: [
      { ...first, hash: firstHash },
      {
        ...second,
        hash: sha256(`${second.id}:${second.payloadHash}:${firstHash}`),
      },
    ],
  }
}

describe('production telemetry boundary', () => {
  it('correlates spans, metrics and structured logs with W3C trace context', () => {
    const parent = createTrace()
    const parsed = parseTraceparent(traceparent(parent))
    expect(parsed?.traceId).toBe(parent.traceId)
    const clock = [
      new Date('2026-07-20T10:00:00Z'),
      new Date('2026-07-20T10:00:00.025Z'),
    ]
    const telemetry = new ProductionTelemetry(
      () => clock.shift() ?? new Date('2026-07-20T10:00:01Z'),
    )
    const span = telemetry.startSpan('scheduler.claim', {
      parent: parsed,
      attributes: {
        operation: 'claim',
        'tenant.opaque': opaqueScope('tenant-a', 'fixture-salt-fixture'),
      },
    })
    telemetry.recordMetric('scheduler_queue_wait', 25, {
      context: span.context,
      attributes: { outcome: 'claimed' },
    })
    telemetry.log('info', 'SCHEDULER_CLAIMED', { context: span.context })
    span.end()
    const snapshot = telemetry.snapshot()
    expect(
      new Set([
        snapshot.spans[0]!.traceId,
        snapshot.metrics[0]!.traceId,
        snapshot.logs[0]!.traceId,
      ]).size,
    ).toBe(1)
  })

  it('rejects content, credentials, high cardinality and free-form log messages', () => {
    const telemetry = new ProductionTelemetry()
    expect(() =>
      telemetry.startSpan('api.request', { attributes: { prompt: 'marker' } }),
    ).toThrow(/FORBIDDEN/)
    expect(() =>
      telemetry.startSpan('api.request', {
        attributes: { authorization: 'Bearer marker' },
      }),
    ).toThrow(/FORBIDDEN/)
    expect(() =>
      telemetry.startSpan('api.request', {
        attributes: { route: 'x'.repeat(129) },
      }),
    ).toThrow(/UNBOUNDED/)
    expect(() => telemetry.log('error', 'raw error includes content')).toThrow(
      /CODE_INVALID/,
    )
  })

  it('keeps unknown events observable without retaining their body', () => {
    const telemetry = new ProductionTelemetry()
    const span = telemetry.startSpan('unknown.event', {
      attributes: { 'event.type': 'codex.unknown', outcome: 'preserved' },
    })
    telemetry.log('warn', 'UNKNOWN_EVENT_PRESERVED', {
      context: span.context,
      attributes: { 'event.type': 'codex.unknown' },
    })
    span.end()
    expect(JSON.stringify(telemetry.snapshot())).not.toContain('raw')
  })

  it('bounds telemetry during exporter loss and exposes a drop metric', () => {
    const telemetry = new ProductionTelemetry(() => new Date(), 2)
    for (let index = 0; index < 5; index++)
      telemetry.recordMetric('api_availability', 1)
    const snapshot = telemetry.snapshot()
    expect(
      snapshot.metrics.filter((item) => item.sli === 'api_availability'),
    ).toHaveLength(2)
    expect(
      snapshot.metrics.find((item) => item.sli === 'telemetry_dropped')?.value,
    ).toBe(3)
  })
})

describe('immutable backup and fail-closed restore', () => {
  it('verifies immutable manifest, all component checksums and key availability', () => {
    const sealed = manifest()
    expect(verifyManifest(sealed, bodies).manifestId).toBe('backup-1')
    expect(() => requireKeyAvailable(new Set(), sealed)).toThrow(
      /RESTORE_KEY_UNAVAILABLE/,
    )
    expect(() =>
      requireKeyAvailable(new Set(['kms-v27']), sealed),
    ).not.toThrow()
  })

  it('rejects corrupt, missing and tampered backup material', () => {
    const sealed = manifest()
    expect(() =>
      verifyManifest(sealed, new Map(bodies).set('objects', bytes('corrupt'))),
    ).toThrow(/COMPONENT_CORRUPT/)
    const missing = new Map(bodies)
    missing.delete('pg-wal')
    expect(() => verifyManifest(sealed, missing)).toThrow(/COMPONENT_MISSING/)
    expect(() =>
      verifyManifest(
        { ...sealed, sourceRegion: 'evil' } as BackupManifest,
        bodies,
      ),
    ).toThrow(/MANIFEST_CHECKSUM/)
  })

  it('accepts a scoped, gapless graph and rejects every restore integrity violation', () => {
    expect(() => validateRestoreGraph(graph())).not.toThrow()
    const orphan = graph()
    orphan.runs[0]!.tenantId = 'tenant-b'
    expect(() => validateRestoreGraph(orphan)).toThrow(/CROSS_TENANT_RUN/)
    const duplicate = graph()
    duplicate.runs.push({ ...duplicate.runs[0]! })
    expect(() => validateRestoreGraph(duplicate)).toThrow(/DUPLICATE_TURN/)
    const gap = graph()
    gap.events[1]!.sequence = 3
    expect(() => validateRestoreGraph(gap)).toThrow(/EVENT_GAP/)
    const audit = graph()
    audit.audit[1]!.previousHash = sha256('wrong')
    expect(() => validateRestoreGraph(audit)).toThrow(/AUDIT_CHAIN_BREAK/)
  })

  it('seals restore evidence with the mandated order and measured RPO/RTO', () => {
    const evidence = sealRestoreEvidence({
      schemaVersion: 1,
      evidenceId: 'restore-1',
      manifestId: 'backup-1',
      isolatedTargetId: 'isolated-1',
      targetRegion: 'eu-2',
      startedAt: '2026-07-20T10:00:00.000Z',
      completedAt: '2026-07-20T10:00:07.000Z',
      restoreOrder: [
        'postgresql',
        'key_metadata',
        'objects',
        'event_broker',
        'derived_index',
      ],
      checksumVerified: true,
      watermarkVerified: true,
      tenantGraphVerified: true,
      duplicateTurns: 0,
      eventGaps: 0,
      auditChainBreaks: 0,
      rpoMs: 0,
      rtoMs: 7000,
      previousEvidenceSha256: null,
    })
    expect(evidence.evidenceSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('multi-window burn-rate alerts', () => {
  it('fires on injected failure and auto-resolves after recovery', () => {
    const lifecycle = new AlertLifecycle()
    const rule = MULTI_WINDOW_BURN_RATE[0]!
    expect(
      evaluateBurnRate(
        {
          objective: 0.999,
          shortGood: 900,
          shortTotal: 1000,
          longGood: 9000,
          longTotal: 10000,
        },
        rule,
      ),
    ).toBe(true)
    expect(lifecycle.evaluate(true).current).toBe('firing')
    expect(
      evaluateBurnRate(
        {
          objective: 0.999,
          shortGood: 1000,
          shortTotal: 1000,
          longGood: 10000,
          longTotal: 10000,
        },
        rule,
      ),
    ).toBe(false)
    expect(lifecycle.evaluate(false)).toEqual({
      previous: 'firing',
      current: 'inactive',
    })
  })
})
