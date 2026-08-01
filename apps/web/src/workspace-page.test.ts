import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@perseverance/domain-events'
import {
  boundedTail,
  attachmentMediaType,
  sourceMediaType,
  chatFollowStateAfterScroll,
  coalesceTimelineEvents,
  ConversationHistory,
  conversationFolderPickerState,
  conversationFolderDisplayName,
  conversationFeed,
  conversationMessages,
  describeConversationWork,
  describeTimelineEvent,
  isNearScrollEnd,
  normalizeReadinessResponse,
  readStoredProviderSelection,
  providerPickerSelection,
  providerAuthMessage,
  formatUsageCost,
  MessageCopyButton,
  parseOfflineConversation,
  parseOfflineHistory,
  parseStoredProviderSelection,
  sessionScopedCursor,
  serverOwnedRunLabel,
  supportGrantStatusLabel,
  shouldSubmitComposer,
  turnSubmitBlocked,
  userFacingApiError,
} from './workspace-page'
import MessageMarkdown from './message-markdown'
import {
  offlineConversationKey,
  offlineHistoryKey,
  tenantCacheNamespace,
} from './tenant-cache'

describe('tenant-aware client cache namespace', () => {
  it('changes for principal, organization and workspace switches', () => {
    const a = tenantCacheNamespace('user-a', 'org-a', 'wsp-a')
    expect(tenantCacheNamespace('user-b', 'org-a', 'wsp-a')).not.toBe(a)
    expect(tenantCacheNamespace('user-a', 'org-b', 'wsp-a')).not.toBe(a)
    expect(tenantCacheNamespace('user-a', 'org-a', 'wsp-b')).not.toBe(a)
    expect(offlineHistoryKey(a)).toContain(a)
    expect(offlineConversationKey(a, 'ses-a')).toContain(a)
  })

  it('does not address tenant A snapshots after logout, revoke, or organization switch', () => {
    const tenantA = tenantCacheNamespace('user-a', 'org-a', 'wsp-a')
    const snapshots = new Map([
      [
        offlineConversationKey(tenantA, 'ses-a'),
        JSON.stringify({ version: 1 }),
      ],
    ])

    for (const nextNamespace of [
      tenantCacheNamespace('anonymous', 'org-a', 'wsp-a'),
      tenantCacheNamespace('user-a', 'org-a', 'revoked-workspace'),
      tenantCacheNamespace('user-a', 'org-b', 'wsp-b'),
      tenantCacheNamespace('user-b', 'org-a', 'wsp-a'),
    ])
      expect(
        snapshots.get(offlineConversationKey(nextNamespace, 'ses-a')),
      ).toBeUndefined()
  })
})

describe('readiness response compatibility', () => {
  it('keeps the workspace readiness response unchanged', () => {
    const readiness = normalizeReadinessResponse({
      status: 'setup_required',
      checkedAt: '2026-07-31T09:00:00.000Z',
      checks: [{ name: 'auth', status: 'failed', code: 'AUTH_REQUIRED' }],
      recovery: {
        code: 'AUTH_REQUIRED',
        instruction: 'codex login',
        retryable: true,
        readOnlyAvailable: true,
      },
    })

    expect(readiness.status).toBe('setup_required')
    expect(readiness.recovery.code).toBe('AUTH_REQUIRED')
  })

  it('maps healthy production topology readiness to composer readiness', () => {
    const readiness = normalizeReadinessResponse({
      schemaVersion: 1,
      mode: 'production',
      ready: true,
      checkedAt: '2026-07-31T09:00:00.000Z',
      dependencies: [],
    })

    expect(readiness.status).toBe('ready')
    expect(readiness.checks).toEqual([
      { name: 'provisioning', status: 'ready', code: null },
    ])
  })

  it('keeps an unhealthy production topology blocked and retryable', () => {
    const readiness = normalizeReadinessResponse({
      ready: false,
      checkedAt: '2026-07-31T09:00:00.000Z',
    })

    expect(readiness.status).toBe('degraded')
    expect(readiness.recovery.retryable).toBe(true)
  })
})

describe('WP20 support access presentation', () => {
  it('distinguishes pending, active, revoked and expired states', () => {
    expect(supportGrantStatusLabel('pending_approval')).toContain('Awaiting')
    expect(supportGrantStatusLabel('active')).toBe('Active')
    expect(supportGrantStatusLabel('revoked')).toContain('Revoked')
    expect(supportGrantStatusLabel('expired')).toContain('Expired')
  })
})

describe('API error presentation', () => {
  it('turns prepaid credit codes into an actionable user message', () => {
    expect(
      userFacingApiError(
        {
          code: 'USAGE_LIMIT_REACHED',
          message: 'Prepaid credit balance is insufficient',
          reasonCode: 'HARD_LIMIT_PREPAID_CREDIT',
          policyVersion: 24,
          measurementWatermark: 'credit:0',
        },
        429,
      ),
    ).toContain('Usage credits are depleted')
  })

  it('keeps safe server messages for unknown errors', () => {
    expect(
      userFacingApiError({ code: 'UNKNOWN', message: 'Tekrar deneyin' }, 500),
    ).toBe('Tekrar deneyin')
  })

  it('explains that a password is required when the content key lease is lost', () => {
    expect(userFacingApiError(null, 428)).toContain(
      'Reauthenticate with your password',
    )
  })

  it('explains concurrent-turn admission denials', () => {
    expect(
      userFacingApiError(
        {
          code: 'COMMERCIAL_ADMISSION_DENIED',
          message: 'HARD_LIMIT_TENANT_CONCURRENT_TURN',
          reasonCode: 'HARD_LIMIT_TENANT_CONCURRENT_TURN',
        },
        429,
      ),
    ).toContain('concurrent turn limit')
  })
})

const base = {
  schemaVersion: 1 as const,
  tenantId: 'ten',
  workspaceId: 'wsp',
  sessionId: 'ses',
  codexThreadId: 'thr',
  codexTurnId: 'turn',
  codexItemId: 'cmd',
  occurredAt: '2026-07-14T00:00:00.000Z',
  receivedAt: '2026-07-14T00:00:00.000Z',
  source: 'codex-app-server' as const,
  sourceVersion: 'x',
  sourceMethod: 'item/commandExecution/outputDelta',
  visibility: 'user' as const,
}
function delta(sequence: number, text: string): TimelineEvent {
  return parseTimelineEvent({
    ...base,
    eventId: `evt_${sequence}`,
    sequence,
    type: 'command.output.delta',
    payload: {
      commandId: 'cmd',
      stream: 'combined',
      chunkIndex: sequence - 1,
      byteLength: Buffer.byteLength(text),
      text,
      truncated: false,
      artifact: null,
    },
  })
}
describe('bounded browser timeline state', () => {
  it('allows choosing a folder before the conversation session exists', () => {
    expect(
      conversationFolderPickerState({
        sessionFolderId: undefined,
        selectedFolderId: 'fol_selected',
        online: true,
      }),
    ).toEqual({ value: 'fol_selected', disabled: false })
    expect(
      conversationFolderPickerState({
        sessionFolderId: 'fol_session',
        selectedFolderId: 'fol_selected',
        online: true,
      }),
    ).toEqual({ value: 'fol_session', disabled: false })
    expect(
      conversationFolderPickerState({
        sessionFolderId: undefined,
        cachedSessionFolderId: 'fol_cached',
        selectedFolderId: 'fol_stale',
        online: true,
      }),
    ).toEqual({ value: 'fol_cached', disabled: false })
    expect(
      conversationFolderPickerState({
        sessionFolderId: null,
        cachedSessionFolderId: 'fol_cached',
        selectedFolderId: 'fol_stale',
        online: true,
      }),
    ).toEqual({ value: '', disabled: false })
    expect(
      conversationFolderPickerState({
        sessionFolderId: null,
        selectedFolderId: null,
        online: false,
      }),
    ).toEqual({ value: '', disabled: true })
  })

  it('resolves personal, shared, and cached folder names', () => {
    const folders = [{ folderId: 'fol_personal', name: 'Drafts' }]
    const sharedFolders = [
      { folder: { folderId: 'fld_shared', name: 'Editorial' } },
    ]
    expect(
      conversationFolderDisplayName({
        folderId: 'fol_personal',
        folders,
        sharedFolders,
      }),
    ).toBe('Drafts')
    expect(
      conversationFolderDisplayName({
        folderId: 'fld_shared',
        folders,
        sharedFolders,
      }),
    ).toBe('Editorial')
    expect(
      conversationFolderDisplayName({
        folderId: 'fol_cached',
        folders: [],
        sharedFolders: [],
        cachedFolderName: 'Cached folder',
      }),
    ).toBe('Cached folder')
  })

  it('distinguishes estimated, partial, and reconciled cost labels', () => {
    const baseUsage = {
      tenantId: 'ten',
      workspaceId: 'wsp',
      sessionId: 'ses',
      turnId: null,
      counters: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
        toolUnits: 0,
      },
      outcome: 'completed' as const,
      completeness: 'complete' as const,
      reconciliationStatus: 'unreconciled' as const,
      estimatedCostMicros: 1250,
      officialCostMicros: null,
      currency: 'USD' as const,
      priceCatalogVersions: ['v1'],
    }
    expect(formatUsageCost(baseUsage)).toMatchObject({
      detail: 'API list-price estimate · complete',
    })
    expect(
      formatUsageCost({
        ...baseUsage,
        counters: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolUnits: 0,
        },
        estimatedCostMicros: null,
      }),
    ).toMatchObject({
      amount: 'No measured usage yet',
      detail: 'Calculated after the first token record',
    })
    expect(
      formatUsageCost({
        ...baseUsage,
        completeness: 'partial',
        estimatedCostMicros: null,
      }),
    ).toMatchObject({
      amount: 'Unavailable',
      detail: 'No price for this model · partial',
    })
    expect(
      formatUsageCost({
        ...baseUsage,
        reconciliationStatus: 'reconciled',
        officialCostMicros: 1000,
      }),
    ).toMatchObject({ detail: 'Actual provider cost · complete' })
  })

  it('keeps only versioned minimized offline history metadata', () => {
    expect(
      parseOfflineHistory(
        JSON.stringify({
          version: 1,
          sessions: [
            {
              sessionId: 'ses',
              title: 'Başlık',
              status: 'active',
              provider: 'codex',
              resolvedModel: 'model',
              reasoningEffort: 'medium',
              folderId: 'fol_writing',
              folderName: 'Writing',
              archivedAt: null,
              updatedAt: '2026-07-15T00:00:00.000Z',
              secret: 'discard',
            },
          ],
        }),
      ),
    ).toEqual([
      {
        sessionId: 'ses',
        title: 'Başlık',
        status: 'active',
        provider: 'codex',
        resolvedModel: 'model',
        reasoningEffort: 'medium',
        folderId: 'fol_writing',
        folderName: 'Writing',
        archivedAt: null,
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    ])
  })

  it('retains production history while model resolution is still null', () => {
    expect(
      parseOfflineHistory(
        JSON.stringify({
          version: 1,
          sessions: [
            {
              sessionId: 'ses_default',
              title: 'Yeni konuşma',
              status: 'active',
              provider: 'codex',
              resolvedModel: null,
              reasoningEffort: 'medium',
              folderId: 'fol_default',
              folderName: 'Default',
              archivedAt: null,
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId: 'ses_default',
        resolvedModel: null,
        folderId: 'fol_default',
      }),
    ])
  })

  it('keeps only bounded read-only conversation message fields offline', () => {
    expect(
      parseOfflineConversation(
        JSON.stringify({
          version: 1,
          sessionId: 'ses',
          savedAt: '2026-07-15T00:00:00.000Z',
          messages: [
            {
              key: 'message-1',
              role: 'assistant',
              text: 'Redacted final answer',
              sequence: 4,
              turnId: 'turn-1',
              attachmentBody: 'discard',
              authorization: 'discard',
            },
          ],
        }),
        'ses',
      ),
    ).toEqual({
      version: 1,
      sessionId: 'ses',
      savedAt: '2026-07-15T00:00:00.000Z',
      messages: [
        {
          key: 'message-1',
          role: 'assistant',
          text: 'Redacted final answer',
          sequence: 4,
          turnId: 'turn-1',
        },
      ],
    })
  })
  it('defaults provider selection to Codex + sol + medium during SSR', () => {
    expect(readStoredProviderSelection()).toEqual({
      provider: 'codex',
      modelId: '',
      effort: 'medium',
    })
  })
  it('maps each provider catalog default in the provider picker', () => {
    expect(
      providerPickerSelection('claude', [
        {
          modelId: 'claude-sonnet',
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: 'high',
        },
      ]),
    ).toEqual({ modelId: 'claude-sonnet', effort: 'high' })
    expect(
      providerPickerSelection('gemini', [
        {
          modelId: 'gemini-flash',
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: 'none',
        },
      ]),
    ).toEqual({ modelId: 'gemini-flash', effort: 'none' })
    expect(
      providerPickerSelection('cursor', [
        {
          modelId: 'cursor-model',
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: 'max',
        },
      ]),
    ).toEqual({ modelId: 'cursor-model', effort: 'max' })
  })
  it('renders actionable auth and unknown/capacity guidance', () => {
    expect(providerAuthMessage('claude', 'required', 'Run login')).toContain(
      'login gerekli',
    )
    expect(providerAuthMessage('gemini', 'unknown')).toContain('capacity')
    expect(
      providerAuthMessage('cursor', 'required', 'Run cursor-agent login'),
    ).toContain('cursor-agent login')
  })
  it('restores provider, model, and effort selection after reload', () => {
    expect(
      parseStoredProviderSelection(
        JSON.stringify({
          provider: 'claude',
          modelId: 'claude-sonnet',
          effort: 'high',
        }),
      ),
    ).toEqual({
      provider: 'claude',
      modelId: 'claude-sonnet',
      effort: 'high',
    })
    expect(
      parseStoredProviderSelection(
        JSON.stringify({
          provider: 'cursor',
          modelId: 'cursor-model',
          effort: 'none',
        }),
      ),
    ).toEqual({
      provider: 'cursor',
      modelId: 'cursor-model',
      effort: 'none',
    })
    expect(
      parseStoredProviderSelection(
        JSON.stringify({
          provider: 'cursor',
          modelId: 'claude-opus-4-8',
          effort: 'max',
        }),
      ),
    ).toEqual({
      provider: 'cursor',
      modelId: 'claude-opus-4-8',
      effort: 'max',
    })
  })
  it('resets the realtime cursor when navigating between sessions', () => {
    expect(sessionScopedCursor('ses_a', 'ses_b', 42)).toBe(0)
    expect(sessionScopedCursor('ses_a', 'ses_a', 42)).toBe(42)
  })

  it('coalesces 1600 command chunks into one 64 KiB item snapshot', () => {
    let state = new Map<string, TimelineEvent>()
    for (let index = 1; index <= 1600; index++)
      state = coalesceTimelineEvents(state, [delta(index, 'x'.repeat(65536))])
    expect(state.size).toBe(1)
    const event = [...state.values()][0]!
    expect(event.type).toBe('command.output.delta')
    if (event.type === 'command.output.delta')
      expect(new TextEncoder().encode(event.payload.text).length).toBe(65536)
  })
  it('keeps UTF-8 tails bounded', () =>
    expect(
      new TextEncoder().encode(boundedTail('', '🙂'.repeat(40000))).length,
    ).toBeLessThanOrEqual(65536))
})

describe('Codex-style timeline presentation', () => {
  it('renders an accessible copy action for both message authors', () => {
    const assistant = renderToStaticMarkup(
      createElement(MessageCopyButton, {
        text: 'Codex response',
        author: 'assistant',
      }),
    )
    const user = renderToStaticMarkup(
      createElement(MessageCopyButton, {
        text: 'User prompt',
        author: 'user',
      }),
    )

    expect(assistant).toContain('aria-label="Copy Codex message"')
    expect(user).toContain('aria-label="Copy your message"')
    expect(assistant).toContain('message-copy-button')
    expect(assistant).toContain('<svg')
  })

  it('gives known upstream notifications a human-readable operation name', () => {
    const event = parseTimelineEvent({
      ...base,
      eventId: 'evt_unknown_thread_started',
      sequence: 14,
      sourceMethod: 'thread/started',
      type: 'codex.unknown',
      payload: {
        envelopeKind: 'notification',
        method: 'thread/started',
        params: { thread: { status: 'inProgress' } },
      },
    })

    expect(
      describeTimelineEvent({
        key: event.eventId,
        event,
        completed: false,
      }),
    ).toMatchObject({
      title: 'Codex task started',
      summary: 'inProgress',
      tone: 'activity',
      expanded: false,
    })
  })

  it('uses a calm generic label for future Codex events', () => {
    const event = parseTimelineEvent({
      ...base,
      eventId: 'evt_future',
      sequence: 15,
      sourceMethod: 'future/operation/updated',
      type: 'codex.unknown',
      payload: {
        envelopeKind: 'notification',
        method: 'future/operation/updated',
        params: {},
      },
    })

    expect(
      describeTimelineEvent({
        key: event.eventId,
        event,
        completed: false,
      }).title,
    ).toBe('Codex event')
  })
})

describe('conversation projection', () => {
  it('shows pending work immediately for an accepted turn', () => {
    expect(conversationFeed([], 'turn_accepted')).toEqual([
      expect.objectContaining({
        key: 'work:turn_accepted:pending',
        role: 'work',
        running: true,
      }),
    ])
  })

  it('projects upstream user items and normalized assistant messages into chat', () => {
    const user = parseTimelineEvent({
      ...base,
      eventId: 'evt_user',
      sequence: 20,
      sourceMethod: 'item/completed',
      type: 'codex.unknown',
      payload: {
        envelopeKind: 'notification',
        method: 'item/completed',
        params: {
          item: {
            type: 'userMessage',
            content: [{ type: 'text', text: 'Merhaba Codex' }],
          },
        },
      },
    })
    const assistant = parseTimelineEvent({
      ...base,
      eventId: 'evt_assistant',
      sequence: 21,
      sourceMethod: 'item/completed',
      type: 'agent.message.completed',
      payload: { text: 'Merhaba!' },
    })

    expect(conversationMessages([user, assistant])).toEqual([
      expect.objectContaining({ role: 'user', text: 'Merhaba Codex' }),
      expect.objectContaining({ role: 'assistant', text: 'Merhaba!' }),
    ])
  })

  it('streams agent deltas into one message and reconciles the final item', () => {
    const first = parseTimelineEvent({
      ...base,
      codexItemId: 'message_stream',
      eventId: 'evt_stream_1',
      sequence: 22,
      sourceMethod: 'item/agentMessage/delta',
      type: 'agent.message.delta',
      payload: { text: 'Mer' },
    })
    const second = parseTimelineEvent({
      ...base,
      codexItemId: 'message_stream',
      eventId: 'evt_stream_2',
      sequence: 23,
      sourceMethod: 'item/agentMessage/delta',
      type: 'agent.message.delta',
      payload: { text: 'haba' },
    })
    const completed = parseTimelineEvent({
      ...base,
      codexItemId: 'message_stream',
      eventId: 'evt_stream_final',
      sequence: 24,
      sourceMethod: 'item/completed',
      type: 'agent.message.completed',
      payload: { text: 'Merhaba' },
    })

    expect(conversationMessages([first, second])).toMatchObject([
      { role: 'assistant', text: 'Merhaba' },
    ])
    expect(conversationMessages([first, second, completed])).toMatchObject([
      { role: 'assistant', text: 'Merhaba' },
    ])
  })

  it('places compact Codex work between the user prompt and assistant reply', () => {
    const events = [
      parseTimelineEvent({
        ...base,
        codexItemId: undefined,
        eventId: 'evt_turn',
        sequence: 19,
        sourceMethod: 'turn/started',
        type: 'turn.started',
        payload: { status: 'in_progress' },
      }),
      parseTimelineEvent({
        ...base,
        codexItemId: 'usr_feed',
        eventId: 'evt_user_feed',
        sequence: 20,
        sourceMethod: 'item/completed',
        type: 'codex.unknown',
        payload: {
          envelopeKind: 'notification',
          method: 'item/completed',
          params: {
            item: {
              type: 'userMessage',
              content: [{ type: 'text', text: 'Kontrol et' }],
            },
          },
        },
      }),
      parseTimelineEvent({
        ...base,
        codexItemId: 'tool_feed',
        eventId: 'evt_tool',
        sequence: 21,
        sourceMethod: 'item/started',
        type: 'tool.started',
        payload: {
          toolKind: 'dynamic',
          tool: 'rg',
          arguments: {},
          provider: 'local',
          status: 'in_progress',
        },
      }),
      parseTimelineEvent({
        ...base,
        codexItemId: 'asst_feed',
        eventId: 'evt_assistant_feed',
        sequence: 22,
        sourceMethod: 'item/completed',
        type: 'agent.message.completed',
        payload: { text: 'Kontrol ettim.' },
      }),
    ]

    const feed = conversationFeed(events)
    expect(feed.map((item) => item.role)).toEqual([
      'user',
      'work',
      'assistant',
      'work',
    ])
    expect(feed[1]).toMatchObject({ role: 'work', running: false })
    expect(feed[1] && 'cards' in feed[1] ? feed[1].cards : []).toHaveLength(2)
    if (feed[1]?.role === 'work')
      expect(describeConversationWork(feed[1])).toBe('Inspected the workspace')
    expect(feed.at(-1)).toMatchObject({
      role: 'work',
      running: true,
      cards: [],
    })
  })

  it('shows work before an assistant message even without a user item', () => {
    const events = [
      parseTimelineEvent({
        ...base,
        codexItemId: undefined,
        eventId: 'evt_startup',
        sequence: 1,
        sourceMethod: 'thread/started',
        type: 'codex.unknown',
        payload: {
          envelopeKind: 'notification',
          method: 'thread/started',
          params: {},
        },
      }),
      parseTimelineEvent({
        ...base,
        codexItemId: 'asst_first',
        eventId: 'evt_first_answer',
        sequence: 2,
        sourceMethod: 'item/completed',
        type: 'agent.message.completed',
        payload: { text: 'Hazırım.' },
      }),
    ]
    expect(conversationFeed(events).map((item) => item.role)).toEqual([
      'work',
      'assistant',
    ])
  })

  it('submits with Enter while preserving Shift+Enter and IME composition', () => {
    expect(
      shouldSubmitComposer({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true)
    expect(
      shouldSubmitComposer({
        key: 'Enter',
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false)
    expect(
      shouldSubmitComposer({
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false)
  })

  it('keeps the work block identity stable while realtime events arrive', () => {
    const started = parseTimelineEvent({
      ...base,
      codexItemId: undefined,
      eventId: 'evt_stable_turn',
      sequence: 30,
      sourceMethod: 'turn/started',
      type: 'turn.started',
      payload: { status: 'in_progress' },
    })
    const command = parseTimelineEvent({
      ...base,
      codexItemId: 'cmd_stable',
      eventId: 'evt_stable_command',
      sequence: 31,
      sourceMethod: 'item/started',
      type: 'command.proposed',
      payload: { command: 'pnpm test', cwd: '/workspace', status: 'proposed' },
    })
    const assistant = parseTimelineEvent({
      ...base,
      codexItemId: 'asst_stable',
      eventId: 'evt_stable_assistant',
      sequence: 32,
      sourceMethod: 'item/completed',
      type: 'agent.message.completed',
      payload: { text: 'Bitti.' },
    })
    const terminal = parseTimelineEvent({
      ...base,
      codexTurnId: undefined,
      codexItemId: undefined,
      eventId: 'evt_stable_terminal',
      sequence: 33,
      sourceMethod: 'turn/completed',
      type: 'turn.completed',
      payload: { status: 'completed' },
    })
    const activeWork = conversationFeed([started, command]).find(
      (item) => item.role === 'work',
    )
    const completedWork = conversationFeed([started, command, assistant]).find(
      (item) => item.role === 'work',
    )
    expect(activeWork?.key).toBe(completedWork?.key)
    expect(activeWork).toMatchObject({ running: true })
    if (activeWork?.role === 'work')
      expect(describeConversationWork(activeWork)).toBe('Running tests')
    expect(
      conversationFeed([started, command, assistant, terminal]).filter(
        (item) => item.role === 'work',
      ),
    ).toHaveLength(1)
  })

  it('places active tool work after commentary and keeps its loading state', () => {
    const started = parseTimelineEvent({
      ...base,
      codexItemId: undefined,
      eventId: 'evt_commentary_turn',
      sequence: 40,
      sourceMethod: 'turn/started',
      type: 'turn.started',
      payload: { status: 'in_progress' },
    })
    const commentary = parseTimelineEvent({
      ...base,
      codexItemId: 'asst_commentary',
      eventId: 'evt_commentary',
      sequence: 41,
      sourceMethod: 'item/completed',
      type: 'agent.message.completed',
      payload: { text: 'Kaynakları tarıyorum.' },
    })
    const search = parseTimelineEvent({
      ...base,
      codexItemId: 'tool_search',
      eventId: 'evt_search',
      sequence: 42,
      sourceMethod: 'item/started',
      type: 'tool.started',
      payload: {
        toolKind: 'dynamic',
        tool: 'webSearch',
        arguments: {},
        provider: 'local',
        status: 'in_progress',
      },
    })
    const activeFeed = conversationFeed([started, commentary, search])
    expect(activeFeed.map((item) => item.role)).toEqual([
      'work',
      'assistant',
      'work',
    ])
    const currentWork = activeFeed.at(-1)
    expect(currentWork).toMatchObject({ role: 'work', running: true })
    if (currentWork?.role === 'work')
      expect(describeConversationWork(currentWork)).toBe('Researching sources')
  })

  it('shows a generic thinking state while an active turn has no visible work', () => {
    const started = parseTimelineEvent({
      ...base,
      codexItemId: undefined,
      eventId: 'evt_thinking_turn',
      sequence: 45,
      sourceMethod: 'turn/started',
      type: 'turn.started',
      payload: { status: 'in_progress' },
    })
    const assistant = parseTimelineEvent({
      ...base,
      codexItemId: 'asst_thinking',
      eventId: 'evt_thinking_commentary',
      sequence: 46,
      sourceMethod: 'item/completed',
      type: 'agent.message.completed',
      payload: { text: 'Bir sonraki adımı hazırlıyorum.' },
    })

    const feed = conversationFeed([started, assistant])
    expect(feed.map((item) => item.role)).toEqual(['work', 'assistant', 'work'])
    const pending = feed.at(-1)
    expect(pending).toMatchObject({ role: 'work', cards: [], running: true })
    if (pending?.role === 'work')
      expect(describeConversationWork(pending)).toBe('Thinking')
  })

  it('places initial turn loading after the user message', () => {
    const started = parseTimelineEvent({
      ...base,
      codexItemId: undefined,
      eventId: 'evt_initial_turn',
      sequence: 50,
      sourceMethod: 'turn/started',
      type: 'turn.started',
      payload: { status: 'in_progress' },
    })
    const user = parseTimelineEvent({
      ...base,
      codexItemId: 'usr_initial',
      eventId: 'evt_initial_user',
      sequence: 51,
      sourceMethod: 'item/completed',
      type: 'codex.unknown',
      payload: {
        envelopeKind: 'notification',
        method: 'item/completed',
        params: {
          item: {
            type: 'userMessage',
            content: [{ type: 'text', text: 'test' }],
          },
        },
      },
    })
    expect(conversationFeed([started, user])).toMatchObject([
      { role: 'user', text: 'test' },
      { role: 'work', running: true },
    ])
  })

  it('follows only when the viewport is near the conversation end', () => {
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 430,
        clientHeight: 500,
      }),
    ).toBe(true)
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 200,
        clientHeight: 500,
      }),
    ).toBe(false)
  })

  it('locks chat following on upward scroll until the user returns to bottom', () => {
    expect(
      chatFollowStateAfterScroll({
        wasFollowing: true,
        previousScrollTop: 430,
        scrollHeight: 1_000,
        scrollTop: 420,
        clientHeight: 500,
      }),
    ).toBe(false)
    expect(
      chatFollowStateAfterScroll({
        wasFollowing: false,
        previousScrollTop: 420,
        scrollHeight: 1_000,
        scrollTop: 470,
        clientHeight: 500,
      }),
    ).toBe(false)
    expect(
      chatFollowStateAfterScroll({
        wasFollowing: false,
        previousScrollTop: 470,
        scrollHeight: 1_000,
        scrollTop: 480,
        clientHeight: 500,
      }),
    ).toBe(true)
  })

  it('renders safe GitHub-flavored Markdown in messages', () => {
    const html = renderToStaticMarkup(
      createElement(MessageMarkdown, {
        children:
          '## Başlık\n\n- [x] Tamam\n\n`inline` ve [bağlantı](https://example.com)',
      }),
    )
    expect(html).toContain('<h2>Başlık</h2>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('<script')
  })

  it('keeps attachment-only user messages visible in history', () => {
    const user = parseTimelineEvent({
      ...base,
      eventId: 'evt_user_attachment',
      sequence: 22,
      sourceMethod: 'item/completed',
      type: 'codex.unknown',
      payload: {
        envelopeKind: 'notification',
        method: 'item/completed',
        params: {
          item: {
            type: 'userMessage',
            content: [
              { type: 'mention', name: 'brief.pdf', path: '/safe/brief.pdf' },
            ],
          },
        },
      },
    })

    expect(conversationMessages([user])).toEqual([
      expect.objectContaining({
        role: 'user',
        text: '',
        attachments: [{ kind: 'file', name: 'brief.pdf' }],
      }),
    ])
  })

  it('hides internal attachment context while preserving the file chip', () => {
    const user = parseTimelineEvent({
      ...base,
      eventId: 'evt_user_attachment_context',
      sequence: 23,
      sourceMethod: 'item/completed',
      type: 'codex.unknown',
      payload: {
        envelopeKind: 'notification',
        method: 'item/completed',
        params: {
          item: {
            type: 'userMessage',
            content: [
              {
                type: 'text',
                text: 'Bu nedir?\n\n<perseverance-attachments>\n- brief.pdf: /private/path/brief.pdf\n</perseverance-attachments>',
              },
              { type: 'mention', name: 'brief.pdf', path: '/safe/brief.pdf' },
            ],
          },
        },
      },
    })

    expect(conversationMessages([user])).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'Bu nedir?',
        attachments: [{ kind: 'file', name: 'brief.pdf' }],
      }),
    ])
  })
})

describe('attachment selection', () => {
  it('accepts supported MIME types and infers common text extensions', () => {
    expect(attachmentMediaType({ name: 'image.png', type: 'image/png' })).toBe(
      'image/png',
    )
    expect(attachmentMediaType({ name: 'notes.md', type: '' })).toBe(
      'text/markdown',
    )
    expect(
      attachmentMediaType({ name: 'archive.zip', type: '' }),
    ).toBeUndefined()
  })
})

describe('corpus source selection', () => {
  it('accepts the bounded WP21 source file set', () => {
    expect(sourceMediaType({ name: 'paper.pdf', type: '' })).toBe(
      'application/pdf',
    )
    expect(sourceMediaType({ name: 'notes.md', type: '' })).toBe(
      'text/markdown',
    )
    expect(sourceMediaType({ name: 'worker.ts', type: '' })).toBe(
      'application/typescript',
    )
    expect(sourceMediaType({ name: 'archive.zip', type: '' })).toBeUndefined()
  })
})

describe('durable background run status', () => {
  it('distinguishes server-owned work from realtime connectivity', () => {
    expect(serverOwnedRunLabel('running', 'yeniden bağlanıyor')).toBe(
      'Running in the background · reconnecting',
    )
    expect(serverOwnedRunLabel('running', 'canlı')).toBe(
      'Running on the server',
    )
    expect(serverOwnedRunLabel('interrupting', 'canlı')).toBe('Stopping…')
  })
})

describe('draft conversation and lazy session provisioning', () => {
  const base = {
    session: undefined,
    prompt: 'merhaba',
    attachmentCount: 0,
    turnPending: false,
    turnActive: false,
    online: true,
    authReady: true,
    selectedProvider: 'codex' as const,
  }

  it('allows submitting a turn before any session exists', () => {
    expect(turnSubmitBlocked(base)).toBe(false)
  })

  it('still requires a prompt or attachment for a draft conversation', () => {
    expect(turnSubmitBlocked({ ...base, prompt: '   ' })).toBe(true)
    expect(turnSubmitBlocked({ ...base, prompt: '', attachmentCount: 1 })).toBe(
      false,
    )
  })

  it('blocks non-active sessions but not the missing-session draft state', () => {
    expect(
      turnSubmitBlocked({
        ...base,
        session: { status: 'recovery_required', provider: 'codex' },
      }),
    ).toBe(true)
    expect(
      turnSubmitBlocked({
        ...base,
        session: { status: 'active', provider: 'codex' },
      }),
    ).toBe(false)
  })

  it('applies codex auth readiness to the provider the draft will provision', () => {
    expect(turnSubmitBlocked({ ...base, authReady: false })).toBe(true)
    expect(
      turnSubmitBlocked({
        ...base,
        authReady: false,
        selectedProvider: 'claude',
      }),
    ).toBe(false)
    expect(
      turnSubmitBlocked({
        ...base,
        authReady: false,
        selectedProvider: 'claude',
        session: { status: 'active', provider: 'codex' },
      }),
    ).toBe(true)
  })

  it('blocks while a turn is pending, active, or the client is offline', () => {
    expect(turnSubmitBlocked({ ...base, turnPending: true })).toBe(true)
    expect(turnSubmitBlocked({ ...base, turnActive: true })).toBe(true)
    expect(turnSubmitBlocked({ ...base, online: false })).toBe(true)
  })
})

describe('conversation archiving history surface', () => {
  const historySession = (overrides: {
    sessionId: string
    title: string
    archivedAt: string | null
  }) => ({
    folderId: null,
    status: 'active' as const,
    ...overrides,
  })

  const historyProps = (overrides: {
    sessions: ReturnType<typeof historySession>[]
    archivedSessions: ReturnType<typeof historySession>[]
  }) => ({
    folders: [],
    folderName: '',
    folderPending: false,
    readOnly: false,
    onFolderNameChange: () => {},
    onCreateFolder: () => {},
    onNewConversation: () => {},
    onSelectConversation: () => {},
    onArchiveConversation: () => {},
    onRestoreConversation: () => {},
    onSelectFolder: () => {},
    onArchiveFolder: () => {},
    onRestoreFolder: () => {},
    onDeleteFolder: () => {},
    ...overrides,
  })

  it('renders an archive action for every active conversation', () => {
    const markup = renderToStaticMarkup(
      createElement(
        ConversationHistory,
        historyProps({
          sessions: [
            historySession({
              sessionId: 'ses-1',
              title: 'Aktif sohbet',
              archivedAt: null,
            }),
          ],
          archivedSessions: [],
        }),
      ),
    )
    expect(markup).toContain('Aktif sohbet')
    expect(markup).toContain('Archive conversation')
    expect(markup).toContain('Archive Aktif sohbet conversation')
    expect(markup).not.toContain('Archived conversations')
  })

  it('groups archived conversations behind a restore surface', () => {
    const markup = renderToStaticMarkup(
      createElement(
        ConversationHistory,
        historyProps({
          sessions: [],
          archivedSessions: [
            historySession({
              sessionId: 'ses-2',
              title: 'Eski sohbet',
              archivedAt: '2026-07-23T00:00:00.000Z',
            }),
            historySession({
              sessionId: 'ses-3',
              title: 'Daha eski sohbet',
              archivedAt: '2026-07-22T00:00:00.000Z',
            }),
          ],
        }),
      ),
    )
    expect(markup).toContain('Archived conversations · 2')
    expect(markup).toContain('Eski sohbet')
    expect(markup).toContain('Daha eski sohbet')
    expect(markup).toContain('Restore')
  })
})
