import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_SESSION_KEY,
  readStoredAuth,
  refreshStoredSession,
} from './self-hosted-auth'

class MemoryStorage {
  readonly #values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value)
  }

  removeItem(key: string): void {
    this.#values.delete(key)
  }
}

const persistentKey = 'persistent.auth.wp37'
const expiredAccess = {
  accessToken: 'old-access',
  accessTokenExpiresAt: '2026-08-01T00:00:00.000Z',
  refreshToken: 'rt1_old_refresh',
  refreshTokenExpiresAt: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('self-hosted silent session refresh', () => {
  it('deduplicates concurrent refreshes and stores a non-expiring session', async () => {
    const sessionStorage = new MemoryStorage()
    const localStorage = new MemoryStorage()
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(expiredAccess))
    localStorage.setItem(persistentKey, JSON.stringify(expiredAccess))
    vi.stubGlobal('window', { sessionStorage, localStorage })
    const request = vi.fn(async () =>
      Response.json({
        username: 'alice',
        scope: {
          tenantId: 'org_u_1',
          organizationId: 'org_u_1',
          workspaceId: 'wsp_u_1',
        },
        session: {
          accessToken: 'new-access',
          accessTokenExpiresAt: '2026-08-02T01:00:00.000Z',
          refreshToken: 'rt1_new_refresh',
          refreshTokenExpiresAt: null,
        },
      }),
    )
    vi.stubGlobal('fetch', request)

    const results = await Promise.all([
      refreshStoredSession('http://control.test'),
      refreshStoredSession('http://control.test'),
    ])

    expect(results).toEqual(['refreshed', 'refreshed'])
    expect(request).toHaveBeenCalledTimes(1)
    expect(readStoredAuth()).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'rt1_new_refresh',
      refreshTokenExpiresAt: null,
    })
  })

  it('does not erase a newer cross-tab token after an old token is rejected', async () => {
    const sessionStorage = new MemoryStorage()
    const localStorage = new MemoryStorage()
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(expiredAccess))
    localStorage.setItem(
      persistentKey,
      JSON.stringify({
        ...expiredAccess,
        accessToken: 'newer-access',
        refreshToken: 'rt1_newer_refresh',
      }),
    )
    vi.stubGlobal('window', { sessionStorage, localStorage })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 401 })),
    )

    await expect(refreshStoredSession('http://control.test')).resolves.toBe(
      'failed',
    )
    expect(readStoredAuth()).toMatchObject({
      accessToken: 'newer-access',
      refreshToken: 'rt1_newer_refresh',
    })
  })
})
