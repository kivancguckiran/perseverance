import { describe, expect, it } from 'vitest'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@persistent-codex/domain-events'
import {
  boundedTail,
  coalesceTimelineEvents,
  sessionScopedCursor,
} from './workspace-page'
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
