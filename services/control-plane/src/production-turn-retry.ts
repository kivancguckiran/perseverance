export const PRODUCTION_TURN_RETRY_POLICY = {
  maxAttempts: 5,
  initialBackoffMs: 750,
  maxBackoffMs: 6_000,
  poisonAfterAttempts: 5,
} as const

export function productionTurnRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.trunc(attempt) - 1)
  return Math.min(
    PRODUCTION_TURN_RETRY_POLICY.maxBackoffMs,
    PRODUCTION_TURN_RETRY_POLICY.initialBackoffMs * 2 ** exponent,
  )
}
