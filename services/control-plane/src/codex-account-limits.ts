import { codexAccountLimitsResponseSchema } from '@perseverance/control-plane-contracts'
import type { codexV2 } from '@perseverance/codex-protocol-generated'

export type CodexAccountAuthMode = 'chatgpt' | 'apiKey' | 'other' | 'unknown'

export function codexAccountAuthMode(account: unknown): CodexAccountAuthMode {
  if (!account || typeof account !== 'object') return 'unknown'
  const type = (account as { type?: unknown }).type
  if (type === 'chatgpt') return 'chatgpt'
  if (type === 'apiKey') return 'apiKey'
  return typeof type === 'string' ? 'other' : 'unknown'
}

function normalizeSnapshot(snapshot: codexV2.RateLimitSnapshot) {
  return {
    limitId: snapshot.limitId,
    limitName: snapshot.limitName,
    primary: snapshot.primary,
    secondary: snapshot.secondary,
    planType: snapshot.planType === null ? null : String(snapshot.planType),
    rateLimitReachedType:
      snapshot.rateLimitReachedType === null
        ? null
        : String(snapshot.rateLimitReachedType),
    credits: snapshot.credits,
  }
}

export function normalizeCodexAccountLimits(
  response: codexV2.GetAccountRateLimitsResponse,
  observedAt = new Date().toISOString(),
) {
  return codexAccountLimitsResponseSchema.parse({
    status: 'available',
    observedAt,
    authMode: 'chatgpt',
    rateLimits: normalizeSnapshot(response.rateLimits),
    rateLimitsByLimitId: Object.fromEntries(
      Object.entries(response.rateLimitsByLimitId ?? {}).flatMap(
        ([limitId, snapshot]) =>
          snapshot ? [[limitId, normalizeSnapshot(snapshot)]] : [],
      ),
    ),
  })
}

export function unavailableCodexAccountLimits(
  authMode: CodexAccountAuthMode,
  status: 'unsupported' | 'unavailable',
  observedAt = new Date().toISOString(),
) {
  return codexAccountLimitsResponseSchema.parse({
    status,
    observedAt,
    authMode,
    rateLimits: null,
    rateLimitsByLimitId: {},
  })
}
