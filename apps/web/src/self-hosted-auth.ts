import { withBase } from './base-path'
import { localize } from './i18n'
import {
  selfHostedSessionTokensSchema,
  type SelfHostedSessionTokens,
} from '@perseverance/control-plane-contracts'
//  self-hosted oturum saklama ve yenileme yardımcıları (ADR-0037).
// Access/refresh token ve scope tarayıcı storage'ında tutulur; parola ve
// content key HİÇBİR ZAMAN saklanmaz. sessionStorage 'persistent.auth'
// anahtarı mevcut operatör/acil akışıyla geriye uyumludur; PWA kalıcılığı
// için kopya localStorage'da durur.
export interface StoredAuthSession {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken?: string | undefined
  refreshTokenExpiresAt?: string | null | undefined
  subject?: string | undefined
  username?: string | undefined
  tenantId?: string | undefined
  organizationId?: string | undefined
  workspaceId?: string | undefined
}

export const AUTH_SESSION_KEY = 'persistent.auth'
const AUTH_PERSISTENT_KEY = 'persistent.auth.session'
type RefreshResult = 'refreshed' | 'none' | 'failed'
let refreshInFlight: Promise<RefreshResult> | null = null

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

function clearStoredAuthToken(refreshToken: string): void {
  if (typeof window === 'undefined') return
  if (
    parse(window.sessionStorage.getItem(AUTH_SESSION_KEY))?.refreshToken ===
    refreshToken
  )
    window.sessionStorage.removeItem(AUTH_SESSION_KEY)
  if (
    parse(window.localStorage.getItem(AUTH_PERSISTENT_KEY))?.refreshToken ===
    refreshToken
  )
    window.localStorage.removeItem(AUTH_PERSISTENT_KEY)
}

export type AuthSessionResponse = SelfHostedSessionTokens

export function storeAuthResponse(input: {
  session: AuthSessionResponse
  username?: string
  scope?: { tenantId: string; organizationId: string; workspaceId: string }
}): void {
  const previous = readStoredAuth()
  const session = selfHostedSessionTokensSchema.parse(input.session)
  writeStoredAuth({
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
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
// Eşzamanlı sorgular aynı refresh token'ı yarış halinde döndürmesin diye
// yenileme, sekme içinde tek uçuş olarak yürütülür.
async function performStoredSessionRefresh(
  apiBaseUrl: string,
): Promise<RefreshResult> {
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
      if (response.status === 401) clearStoredAuthToken(auth.refreshToken)
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

export function refreshStoredSession(
  apiBaseUrl: string,
): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = performStoredSessionRefresh(apiBaseUrl).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export interface ContentKeySessionStatus {
  subject: string | null
  tenantId: string
  organizationId: string
  workspaceId: string
  contentKeyUnlocked: boolean
}

export async function readContentKeySession(
  apiBaseUrl: string,
  headers: Record<string, string>,
): Promise<ContentKeySessionStatus> {
  const response = await fetch(`${apiBaseUrl}/v1/auth/session`, { headers })
  if (!response.ok)
    throw new Error(
      localize(
        `Could not read content-key status (${response.status}).`,
        `İçerik anahtarı durumu okunamadı (${response.status}).`,
      ),
    )
  const body = (await response.json()) as Partial<ContentKeySessionStatus>
  if (
    typeof body.contentKeyUnlocked !== 'boolean' ||
    typeof body.tenantId !== 'string' ||
    typeof body.organizationId !== 'string' ||
    typeof body.workspaceId !== 'string'
  )
    throw new Error(
      localize(
        'Invalid content-key status.',
        'İçerik anahtarı durumu geçersiz.',
      ),
    )
  return body as ContentKeySessionStatus
}

const UNLOCK_ERROR_MESSAGES: Record<string, [string, string]> = {
  INVALID_CREDENTIALS: ['Incorrect password.', 'Parola hatalı.'],
  CONTENT_KEY_UNWRAP_FAILED: [
    'The content key could not be unlocked. Check your password.',
    'İçerik anahtarı açılamadı. Parolanızı kontrol edin.',
  ],
  AUTH_RATE_LIMITED: [
    'Too many attempts. Wait a while and try again.',
    'Çok fazla deneme yapıldı. Bir süre bekleyip yeniden deneyin.',
  ],
  AUTHORIZATION_DENIED: [
    'Reauthentication was denied for this workspace.',
    'Bu workspace için yeniden doğrulama reddedildi.',
  ],
  INVALID_AUTH_REQUEST: [
    'The password must be at least 8 characters.',
    'Parola en az 8 karakter olmalı.',
  ],
}

export async function unlockStoredContentKey(
  apiBaseUrl: string,
  headers: Record<string, string>,
  password: string,
): Promise<void> {
  const username = readStoredAuth()?.username
  if (!username)
    throw new Error(
      localize(
        'Session username not found.',
        'Oturum kullanıcı adı bulunamadı.',
      ),
    )
  const response = await fetch(`${apiBaseUrl}/v1/auth/unlock`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, password }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    code?: string
    contentKeyUnlocked?: boolean
  }
  const localizedError = UNLOCK_ERROR_MESSAGES[body.code ?? '']
  if (!response.ok)
    throw new Error(
      localizedError
        ? localize(localizedError[0], localizedError[1])
        : localize(
            `Reauthentication failed (${response.status}).`,
            `Yeniden doğrulama başarısız (${response.status}).`,
          ),
    )
  if (body.contentKeyUnlocked !== true)
    throw new Error(
      localize(
        'The content key could not be unlocked.',
        'İçerik anahtarı açılamadı.',
      ),
    )
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
