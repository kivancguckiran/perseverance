import { describe, expect, it } from 'vitest'
import {
  serverMessageSchema,
  sessionResponseSchema,
} from '@perseverance/control-plane-contracts'
import {
  productionRealtimeSubscription,
  productionCodexNotificationEvent,
  productionSessionResponse,
  productionTimelineEvent,
  productionUserMessageEvent,
} from './production-server'
import type {
  ProductionEvent,
  ProductionSession,
} from '@perseverance/production-topology/production-postgres'

const storedSession = (
  overrides: Partial<ProductionSession> = {},
): ProductionSession => ({
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
  status: 'active',
  providerId: 'codex',
  codexThreadId: null,
  highWaterSequence: 0,
  version: 1,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  ...overrides,
})

const storedEvent = (
  overrides: Partial<ProductionEvent> = {},
): ProductionEvent => ({
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
  runId: 'run-a',
  eventId: 'event-a',
  sequence: 1,
  eventType: 'turn.started',
  fencingToken: 1,
  payload: {},
  byteLength: 2,
  occurredAt: '2026-07-31T09:00:00.000Z',
  ...overrides,
})

describe('production session API contract', () => {
  it('maps a durable production session to the public SessionResponse', () => {
    const response = productionSessionResponse(
      storedSession({ highWaterSequence: 7 }),
    )

    expect(sessionResponseSchema.parse(response)).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      provider: 'codex',
      status: 'active',
      replay: { afterSequence: 7, highWaterSequence: 7 },
    })
  })

  it('preserves a recovery-required session with actionable options', () => {
    const response = productionSessionResponse(
      storedSession({ status: 'recovery_required' }),
    )

    expect(response.recoveryErrorCode).toBe('RECOVERY_OUTCOME_UNKNOWN')
    expect(response.recoveryOptions).toEqual([
      'retry_resume',
      'start_new_session',
      'view_read_only',
    ])
  })

  it('accepts the shared realtime subscribe contract without an organization field', () => {
    expect(
      productionRealtimeSubscription({
        type: 'subscribe',
        accessToken: 'access-token',
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        afterSequence: 4,
      }),
    ).toEqual({
      accessToken: 'access-token',
      sessionId: 'session-a',
      afterSequence: 4,
      scope: {
        tenantId: 'tenant-a',
        organizationId: 'tenant-a',
        workspaceId: 'workspace-a',
      },
    })
  })

  it('preserves an explicit organization scope when supplied', () => {
    expect(
      productionRealtimeSubscription({
        type: 'subscribe',
        accessToken: 'access-token',
        tenantId: 'tenant-a',
        organizationId: 'organization-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        afterSequence: 0,
      })?.scope.organizationId,
    ).toBe('organization-a')
  })

  it('normalizes production events into the shared realtime envelope', () => {
    const event = productionTimelineEvent(
      storedEvent({
        eventType: 'agent.message.completed',
        payload: {
          outputObjectKey: 'protected/output',
          codexThreadId: 'thread-a',
          codexItemId: 'message-a',
        },
      }),
      'OK',
    )

    expect(
      serverMessageSchema.parse({
        type: 'event',
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        event,
      }),
    ).toMatchObject({
      type: 'event',
      event: {
        type: 'agent.message.completed',
        codexThreadId: 'thread-a',
        codexTurnId: 'run-a',
        codexItemId: 'message-a',
        payload: { text: 'OK' },
      },
    })
  })

  it('materializes protected prompts as user-message timeline events', () => {
    expect(productionUserMessageEvent(storedEvent(), 'Merhaba')).toMatchObject({
      type: 'codex.unknown',
      payload: {
        method: 'item/completed',
        params: {
          item: {
            type: 'userMessage',
            content: [{ type: 'text', text: 'Merhaba' }],
          },
        },
      },
    })
  })

  it('normalizes protected Codex activity through the shared adapter', () => {
    const event = productionCodexNotificationEvent(
      storedEvent({ eventType: 'codex.notification', sequence: 9 }),
      {
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          itemId: 'reasoning-a',
          summaryIndex: 0,
          delta: 'Inspecting the workspace',
        },
      },
    )

    expect(event).toMatchObject({
      eventId: 'event-a',
      sequence: 9,
      codexTurnId: 'run-a',
      type: 'reasoning.summary.delta',
      payload: { text: 'Inspecting the workspace' },
    })
    expect(
      serverMessageSchema.parse({
        type: 'event',
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        event,
      }),
    ).toBeTruthy()
  })
})
