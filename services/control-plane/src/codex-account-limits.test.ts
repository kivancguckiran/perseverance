import { describe, expect, it } from 'vitest'
import type { codexV2 } from '@perseverance/codex-protocol-generated'
import {
  codexAccountAuthMode,
  normalizeCodexAccountLimits,
  unavailableCodexAccountLimits,
} from './codex-account-limits'

const snapshot: codexV2.RateLimitSnapshot = {
  limitId: 'codex',
  limitName: 'Codex',
  primary: {
    usedPercent: 25,
    windowDurationMins: 300,
    resetsAt: 1_730_947_200,
  },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: '42' },
  individualLimit: null,
  planType: 'plus',
  rateLimitReachedType: null,
}

describe('Codex account limits contract', () => {
  it('normalizes the primary and multi-bucket app-server response', () => {
    const result = normalizeCodexAccountLimits(
      {
        rateLimits: snapshot,
        rateLimitsByLimitId: {
          codex: snapshot,
          other: { ...snapshot, limitId: 'other', primary: null },
        },
        rateLimitResetCredits: null,
      },
      '2026-08-04T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      status: 'available',
      authMode: 'chatgpt',
      observedAt: '2026-08-04T00:00:00.000Z',
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 25, resetsAt: 1_730_947_200 },
        credits: { balance: '42' },
      },
    })
    expect(Object.keys(result.rateLimitsByLimitId)).toEqual(['codex', 'other'])
  })

  it('keeps API-key billing distinct from ChatGPT limits', () => {
    expect(codexAccountAuthMode({ type: 'apiKey' })).toBe('apiKey')
    expect(
      unavailableCodexAccountLimits(
        'apiKey',
        'unsupported',
        '2026-08-04T00:00:00.000Z',
      ),
    ).toEqual({
      status: 'unsupported',
      observedAt: '2026-08-04T00:00:00.000Z',
      authMode: 'apiKey',
      rateLimits: null,
      rateLimitsByLimitId: {},
    })
  })
})
