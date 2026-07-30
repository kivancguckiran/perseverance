import { withBase } from './base-path'
// WP37 — self-hosted oturum saklama ve yenileme yardımcıları (ADR-0037).
// Access/refresh token ve scope tarayıcı storage'ında tutulur; parola ve
// content key HİÇBİR ZAMAN saklanmaz. sessionStorage 'persistent.auth'
// anahtarı mevcut operatör/acil akışıyla geriye uyumludur; PWA kalıcılığı
// için kopya localStorage'da durur.
export interface StoredAuthSession {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken?: string | undefined
  refreshTokenExpiresAt?: string | undefined
  subject?: string | undefined
  username?: string | undefined
  tenantId?: string | undefined
  organizationId?: string | undefined
  workspaceId?: string | undefined
}

export const AUTH_SESSION_KEY = 'persistent.auth'
const AUTH_PERSISTENT_KEY = 'persistent.auth.wp37'

const parse = (raw: string | null): StoredAuthSession | null => {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as StoredAuthSession | null
    return value && typeof value.accessToken === 'string' ? value : null
  } catch {
    return null
  }
}

export function readStoredAuth(): StoredAuthSession | null {
  if (typeof window === 'undefined') return null
  return (
    parse(window.sessionStorage.getItem(AUTH_SESSION_KEY)) ??
    parse(window.localStorage.getItem(AUTH_PERSISTENT_KEY))
  )
}

export function writeStoredAuth(session: StoredAuthSession): void {
  if (typeof window === 'undefined') return
  const raw = JSON.stringify(session)
  window.sessionStorage.setItem(AUTH_SESSION_KEY, raw)
  window.localStorage.setItem(AUTH_PERSISTENT_KEY, raw)
}

export function clearStoredAuth(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(AUTH_SESSION_KEY)
  window.localStorage.removeItem(AUTH_PERSISTENT_KEY)
}

export interface AuthSessionResponse {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string
}

export function storeAuthResponse(input: {
  session: AuthSessionResponse
  username?: string
  scope?: { tenantId: string; organizationId: string; workspaceId: string }
}): void {
  const previous = readStoredAuth()
  writeStoredAuth({
    accessToken: input.session.accessToken,
    accessTokenExpiresAt: input.session.accessTokenExpiresAt,
    refreshToken: input.session.refreshToken,
    refreshTokenExpiresAt: input.session.refreshTokenExpiresAt,
    subject: input.username
      ? `user:${input.username}`
      : (previous?.subject ?? undefined),
    username: input.username ?? previous?.username ?? undefined,
    tenantId: input.scope?.tenantId ?? previous?.tenantId ?? undefined,
    organizationId:
      input.scope?.organizationId ?? previous?.organizationId ?? undefined,
    workspaceId: input.scope?.workspaceId ?? previous?.workspaceId ?? undefined,
  })
}

// Access token'ın süresi yaklaştıysa refresh token ile sessizce yeniler.
// 'refreshed' dönerse çağıran sayfayı yeniden yüklemelidir (modül-scope
// header'lar yeni token'ı görür).
export async function refreshStoredSession(
  apiBaseUrl: string,
): Promise<'refreshed' | 'none' | 'failed'> {
  const auth = readStoredAuth()
  if (!auth?.refreshToken) return 'none'
  const remaining = Date.parse(auth.accessTokenExpiresAt) - Date.now()
  if (Number.isFinite(remaining) && remaining > 5 * 60_000) return 'none'
  try {
    const response = await fetch(`${apiBaseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    })
    if (!response.ok) {
      if (response.status === 401) clearStoredAuth()
      return 'failed'
    }
    const body = (await response.json()) as {
      session: AuthSessionResponse
      scope?: { tenantId: string; organizationId: string; workspaceId: string }
      username?: string
    }
    storeAuthResponse(body)
    return 'refreshed'
  } catch {
    return 'failed'
  }
}

export async function signOut(apiBaseUrl: string): Promise<void> {
  const auth = readStoredAuth()
  try {
    if (auth?.refreshToken)
      await fetch(`${apiBaseUrl}/v1/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
      })
  } catch {
    // logout best-effort: yerel oturum her durumda temizlenir
  } finally {
    clearStoredAuth()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('perseverance:sign-out'))
      window.location.href = withBase('/login')
    }
  }
}
