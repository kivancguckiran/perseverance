// Self-hosted auth composition (ADR-0048). Password verification and wrapped
// key storage remain in the control plane; decrypted content-key leases live
// in the separately supervised, memory-only broker.
import { readFileSync } from 'node:fs'
import type pg from 'pg'
import { HttpContentKeyLeaseStore } from './content-key-lease-client'
import { SelfHostedAuthService, parseAllowedUsers } from './self-hosted-auth'

export interface SelfHostedAuthComposition {
  service: SelfHostedAuthService
  close(): Promise<void>
}

export function createSelfHostedAuthFromEnv(
  env: NodeJS.ProcessEnv,
  pool: pg.Pool,
  databaseUrl: string,
): SelfHostedAuthComposition | null {
  if (!env.OIDC_SIGNING_KEY_FILE) return null
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`Self-hosted auth requires ${name}`)
    return value
  }
  const signingKeyPem = readFileSync(required('OIDC_SIGNING_KEY_FILE'), 'utf8')
  const internalToken = readFileSync(
    required('INTERNAL_RUNTIME_TOKEN_FILE'),
    'utf8',
  ).trim()
  const leases = new HttpContentKeyLeaseStore(
    required('CONTENT_KEY_BROKER_URL'),
    internalToken,
  )
  const service = new SelfHostedAuthService({
    pool,
    databaseUrl,
    allowedUsers: parseAllowedUsers(env.SELF_HOSTED_ALLOWED_USERS),
    issuer: required('OIDC_ISSUER'),
    audience: required('OIDC_AUDIENCE'),
    signingKeyPem,
    signingKeyId: env.OIDC_SIGNING_KEY_ID ?? 'self-hosted',
    ...(env.SELF_HOSTED_ADMIN_SUBJECT
      ? { supportSubject: env.SELF_HOSTED_ADMIN_SUBJECT }
      : {}),
    leases,
    ...(env.ACCESS_TOKEN_TTL_SECONDS
      ? { accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS) }
      : {}),
  })

  return {
    service,
    // Closing a control-plane release must not revoke broker-held leases.
    async close() {},
  }
}
