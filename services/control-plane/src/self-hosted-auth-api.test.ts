// WP37 — auth API sözleşme testleri (ADR-0037): route modülü stub servis ile
// fastify inject üzerinden doğrulanır; tam DB'li akış wp37:privacy gate'inde.
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  SELF_HOSTED_AUTH_PUBLIC_PATHS,
  registerSelfHostedAuthRoutes,
} from './self-hosted-auth-api'
import {
  SelfHostedAuthError,
  type SelfHostedAuthService,
} from './self-hosted-auth'

describe('wp37 auth API sözleşmesi', () => {
  const buildApp = (service: Partial<SelfHostedAuthService>) => {
    const app = Fastify({ logger: false })
    registerSelfHostedAuthRoutes(app, {
      service: service as SelfHostedAuthService,
    })
    return app
  }

  it('public path listesi kayıt/giriş/refresh/recover/logout uçlarını kapsar', () => {
    expect([...SELF_HOSTED_AUTH_PUBLIC_PATHS]).toEqual([
      '/v1/auth/register',
      '/v1/auth/login',
      '/v1/auth/refresh',
      '/v1/auth/recover',
      '/v1/auth/logout',
    ])
    expect(
      (SELF_HOSTED_AUTH_PUBLIC_PATHS as readonly string[]).includes(
        '/v1/auth/session',
      ),
    ).toBe(false)
    expect(
      (SELF_HOSTED_AUTH_PUBLIC_PATHS as readonly string[]).includes(
        '/v1/auth/unlock',
      ),
    ).toBe(false)
  })

  it('register yanıtında recovery key bir kez döner; hatalar koda eşlenir', async () => {
    const app = buildApp({
      register: async () => ({
        userId: 'usr_1',
        username: 'alice',
        scope: {
          tenantId: 'org_u_1',
          organizationId: 'org_u_1',
          workspaceId: 'wsp_u_1',
        },
        recoveryKey: 'RK1-TEST',
        session: {
          accessToken: 'token',
          accessTokenExpiresAt: '2026-07-28T01:00:00.000Z',
          refreshToken: 'rt1_x',
          refreshTokenExpiresAt: '2026-08-27T00:00:00.000Z',
        },
      }),
    })
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { username: 'alice', password: 'long-enough-pass' },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json() as { recoveryKey: string }
    expect(body.recoveryKey).toBe('RK1-TEST')
    await app.close()
  })

  it('allowlist dışı kayıt 403, geçersiz gövde 400, rate limit 429 döner', async () => {
    const app = buildApp({
      register: async () => {
        throw new SelfHostedAuthError('REGISTRATION_NOT_ALLOWED', 403)
      },
      login: async () => {
        throw new SelfHostedAuthError('AUTH_RATE_LIMITED', 429)
      },
    })
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { username: 'mallory', password: 'long-enough-pass' },
    })
    expect(denied.statusCode).toBe(403)
    expect((denied.json() as { code: string }).code).toBe(
      'REGISTRATION_NOT_ALLOWED',
    )
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { username: 'x' },
    })
    expect(invalid.statusCode).toBe(400)
    expect((invalid.json() as { code: string }).code).toBe(
      'INVALID_AUTH_REQUEST',
    )
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'alice', password: 'long-enough-pass' },
    })
    expect(limited.statusCode).toBe(429)
    await app.close()
  })

  it('logout refresh token olmadan da 204 döner (idempotent)', async () => {
    const app = buildApp({ logout: async () => undefined })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: {},
    })
    expect(response.statusCode).toBe(204)
    await app.close()
  })
})
