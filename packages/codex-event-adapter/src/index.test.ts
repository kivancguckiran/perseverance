import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@perseverance/domain-events'
import {
  CodexEnvelopeValidationError,
  CodexEventAdapter,
  TimelineReconciler,
  codexModelCatalog,
  ingestRawCodexEnvelope,
} from './index'

describe('Codex provider model catalog', () => {
  it('maps model/list identities, capabilities, and reasoning efforts', () => {
    const catalog = codexModelCatalog(
      {
        data: [
          {
            id: 'opaque-fixture-id',
            model: 'fixture-upstream-model',
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: 'Fixture model',
            description: 'fixture',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'none', description: 'None' },
              { reasoningEffort: 'medium', description: 'Medium' },
            ],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
      {
        sourceVersion: 'fixture-version',
        discoveredAt: '2026-07-15T00:00:00.000Z',
      },
    )
    expect(catalog.models[0]).toMatchObject({
      modelId: 'fixture-upstream-model',
      reasoningEfforts: ['none', 'medium'],
      capabilities: { imageInput: 'supported', interrupt: 'supported' },
    })
  })
})

const goldenDirectory = fileURLToPath(
  new URL('../../../tests/golden-sessions/', import.meta.url),
)

function context() {
  let sequence = 0
  return {
    tenantId: 'ten_test',
    workspaceId: 'wsp_test',
    sessionId: 'ses_test',
    sourceVersion: '0.144.2',
    nextSequence: () => ++sequence,
    nextEventId: () => `evt_${String(sequence + 1).padStart(3, '0')}`,
    now: () => new Date('2026-07-14T00:00:00.000Z'),
  }
}

function semanticEvent(event: TimelineEvent) {
  return {
    type: event.type,
    ...(event.codexThreadId ? { codexThreadId: event.codexThreadId } : {}),
    ...(event.codexTurnId ? { codexTurnId: event.codexTurnId } : {}),
    ...(event.codexItemId ? { codexItemId: event.codexItemId } : {}),
    payload: event.payload,
  }
}

function loadInputs(name: string): unknown[] {
  return readFileSync(`${goldenDirectory}/${name}.input.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function loadOutput(name: string): unknown {
  return JSON.parse(
    readFileSync(`${goldenDirectory}/${name}.output.json`, 'utf8'),
  )
}

describe('golden Codex sessions', () => {
  const fixtureNames = readdirSync(goldenDirectory)
    .filter((name) => name.endsWith('.input.jsonl'))
    .map((name) => name.replace('.input.jsonl', ''))
    .sort()

  it.each(fixtureNames)('%s has deterministic normalized output', (name) => {
    const adapter = new CodexEventAdapter(context())
    const results = loadInputs(name).map((input) => adapter.adapt(input))

    expect(results.map(({ event }) => semanticEvent(event))).toEqual(
      loadOutput(name),
    )
    results.forEach(({ event }, index) => {
      expect(parseTimelineEvent(event)).toEqual(event)
      expect(event.eventId).toBe(`evt_${String(index + 1).padStart(3, '0')}`)
      expect(event.sequence).toBe(index + 1)
      expect(event.occurredAt).toBe('2026-07-14T00:00:00.000Z')
      expect(event.receivedAt).toBe('2026-07-14T00:00:00.000Z')
    })

    const replay = new CodexEventAdapter(context())
    expect(loadInputs(name).map((input) => replay.adapt(input))).toEqual(
      results,
    )
  })
})

describe('runtime validation and raw ingest', () => {
  it('keeps full command output only in transient spill while bounding persisted envelopes', () => {
    const adapter = new CodexEventAdapter(context())
    const full = 'x'.repeat(1024 * 1024)
    const result = adapter.adapt({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'cmd_large',
        delta: full,
      },
    })
    expect(result.spill?.data).toBe(full)
    expect(
      Buffer.byteLength(String((result.envelope.params as any).delta)),
    ).toBeLessThanOrEqual(64 * 1024)
    expect(Buffer.byteLength(JSON.stringify(result.event))).toBeLessThan(
      70 * 1024,
    )
  })
  it('rejects malformed JSON-RPC envelopes explicitly', () => {
    const adapter = new CodexEventAdapter(context())
    expect(() => adapter.adapt([])).toThrow(CodexEnvelopeValidationError)
    expect(() => adapter.adapt({ params: {} })).toThrow(
      'method must be a non-empty string',
    )
    expect(() => adapter.adapt({ id: {}, method: 'future/request' })).toThrow(
      'id must be a string or integer',
    )
  })

  it('rejects invalid params for a known method without casting', () => {
    const adapter = new CodexEventAdapter(context())
    expect(() =>
      adapter.adapt({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thr_1', delta: 42 },
      }),
    ).toThrow('Invalid params for known Codex method')
  })

  it('preserves a future item or enum as codex.unknown', () => {
    const adapter = new CodexEventAdapter(context())
    const result = adapter.adapt({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { type: 'futureItem', id: 'future_1', value: 42 },
        startedAtMs: 1000,
      },
    })

    expect(result.event).toMatchObject({
      type: 'codex.unknown',
      payload: {
        method: 'item/started',
        params: { item: { type: 'futureItem', value: 42 } },
      },
    })
  })

  it('redacts before producing a deterministic canonical checksum', () => {
    const left = ingestRawCodexEnvelope({
      method: 'future/secret',
      params: { safe: true, apiKey: 'secret-value' },
    })
    const right = ingestRawCodexEnvelope({
      params: { apiKey: 'different-secret', safe: true },
      method: 'future/secret',
    })

    expect(left.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(left.checksum).toBe(right.checksum)
    expect(JSON.stringify(left)).not.toContain('secret-value')
    expect(left.envelope).toEqual({
      method: 'future/secret',
      params: { safe: true, apiKey: '[REDACTED]' },
    })
  })

  it('uses an injected redaction hook before checksum calculation', () => {
    const result = ingestRawCodexEnvelope(
      { method: 'future/custom', params: { private: 'value' } },
      (envelope) => ({ ...envelope, params: '[CUSTOM REDACTION]' }),
    )
    const repeated = ingestRawCodexEnvelope(
      { method: 'future/custom', params: { private: 'other' } },
      (envelope) => ({ ...envelope, params: '[CUSTOM REDACTION]' }),
    )

    expect(result).toEqual(repeated)
  })
})

describe('approval normalization', () => {
  it('normalizes file approval without applying a decision', () => {
    const adapter = new CodexEventAdapter(context())
    const requested = adapter.adapt({
      id: 'req_file',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'file_1',
        startedAtMs: 1000,
        reason: 'outside root',
        grantRoot: '/allowed',
      },
    }).event
    const resolved = adapter.adapt({
      method: 'serverRequest/resolved',
      params: { threadId: 'thr_1', requestId: 'req_file' },
    }).event

    expect(requested).toMatchObject({
      type: 'approval.requested',
      payload: { approvalKind: 'file', grantRoot: '/allowed' },
    })
    expect(resolved).toMatchObject({
      type: 'approval.resolved',
      payload: { approvalKind: 'file' },
      codexTurnId: 'turn_1',
      codexItemId: 'file_1',
    })
  })
})

describe('delta notification normalization', () => {
  it('normalizes reasoning summaries and authoritative turn diffs', () => {
    const adapter = new CodexEventAdapter(context())
    const reasoning = adapter.adapt({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'reason_1',
        summaryIndex: 0,
        delta: 'Özet',
      },
    }).event
    const diff = adapter.adapt({
      method: 'turn/diff/updated',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        diff: 'diff --git a/a.ts b/a.ts',
      },
    }).event

    expect(reasoning).toMatchObject({
      type: 'reasoning.summary.delta',
      codexItemId: 'reason_1',
      payload: { text: 'Özet' },
    })
    expect(diff).toMatchObject({
      type: 'diff.updated',
      payload: { diff: 'diff --git a/a.ts b/a.ts' },
    })
  })
})

describe('completed snapshot reconciliation', () => {
  it('lets authoritative completed message and plan snapshots replace deltas', () => {
    const adapter = new CodexEventAdapter(context())
    const reconciler = new TimelineReconciler()
    const messageEvents = loadInputs('agent-message').map(
      (input) => adapter.adapt(input).event,
    )
    const planEvents = loadInputs('plan').map(
      (input) => adapter.adapt(input).event,
    )
    ;[...messageEvents, ...planEvents].forEach((event) =>
      reconciler.apply(event),
    )

    expect(reconciler.get('thr_1', 'turn_1', 'msg_1')).toMatchObject({
      completed: true,
      text: 'Yetkili son mesaj',
    })
    expect(reconciler.get('thr_1', 'turn_1', 'plan_1')).toMatchObject({
      completed: true,
      text: '1. Yetkili plan\n2. Doğrula',
    })
  })

  it('is idempotent for duplicate completion and isolates compound item ids', () => {
    const adapter = new CodexEventAdapter(context())
    const reconciler = new TimelineReconciler()
    const completed = adapter.adapt(loadInputs('agent-message')[1]).event
    const otherTurn = parseTimelineEvent({
      ...completed,
      eventId: 'evt_other',
      sequence: completed.sequence + 1,
      codexTurnId: 'turn_2',
      payload: { text: 'Other turn' },
    })

    const first = reconciler.apply(completed)
    const duplicate = reconciler.apply(completed)
    reconciler.apply(otherTurn)

    expect(duplicate).toBe(first)
    expect(reconciler.values()).toHaveLength(2)
    expect(reconciler.get('thr_1', 'turn_1', 'msg_1')?.text).toBe(
      'Yetkili son mesaj',
    )
    expect(reconciler.get('thr_1', 'turn_2', 'msg_1')?.text).toBe('Other turn')
  })

  it('uses completed command output instead of accumulated output deltas', () => {
    const adapter = new CodexEventAdapter(context())
    const reconciler = new TimelineReconciler()
    loadInputs('command-lifecycle')
      .map((input) => adapter.adapt(input).event)
      .forEach((event) => reconciler.apply(event))

    expect(reconciler.get('thr_1', 'turn_1', 'cmd_1')).toMatchObject({
      completed: true,
      output: 'authoritative output\n',
    })
  })
})
