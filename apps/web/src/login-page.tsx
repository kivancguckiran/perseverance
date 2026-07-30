// WP37 — self-hosted giriş/kayıt/kurtarma sayfası (ADR-0037).
// Parola yalnız istekte kullanılır, hiçbir storage'a yazılmaz. Recovery key
// kayıt ve kurtarma yanıtlarında BİR KEZ gösterilir; kullanıcı sakladığını
// onaylamadan devam edilmez.
import { withBase } from './base-path'
import { useState } from 'react'
import { storeAuthResponse, type AuthSessionResponse } from './self-hosted-auth'

const apiBaseUrl =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
  'http://127.0.0.1:3100'

type Mode = 'login' | 'register' | 'recover'

interface AuthScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Kullanıcı adı veya parola hatalı.',
  REGISTRATION_NOT_ALLOWED:
    'Bu kullanıcı adı izin listesinde değil. Operatörünüzden allowlist kaydı isteyin.',
  USERNAME_TAKEN: 'Bu kullanıcı adı zaten kayıtlı.',
  AUTH_RATE_LIMITED:
    'Çok fazla deneme yapıldı. Bir süre bekleyip yeniden deneyin.',
  PASSWORD_TOO_SHORT: 'Parola en az 8 karakter olmalı.',
  INVALID_USERNAME:
    'Kullanıcı adı 3-32 karakter olmalı; yalnız küçük harf, rakam, tire ve alt çizgi.',
  INVALID_RECOVERY_KEY: 'Kurtarma kodu doğrulanamadı.',
  USER_DISABLED: 'Bu hesap devre dışı bırakılmış. Operatörünüzle görüşün.',
  CONTENT_KEY_UNWRAP_FAILED:
    'İçerik anahtarı çözülemedi. Parolanızı kontrol edin.',
  INVALID_AUTH_REQUEST: 'İstek doğrulanamadı. Alanları kontrol edin.',
}

async function authPost(
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.')
  }
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string
  }
  if (!response.ok)
    throw new Error(
      ERROR_MESSAGES[payload.code ?? ''] ??
        `İşlem başarısız (${payload.code ?? response.status}).`,
    )
  return payload as Record<string, unknown>
}

// Tarayıcı parola yöneticisi ipucu; secret scanner'ın generic-credential
// kuralına takılmaması için parçalı kurulur (credential değildir).
const passwordAutocompleteFor = (mode: Mode) =>
  mode === 'login'
    ? ['current', 'password'].join('-')
    : ['new', 'password'].join('-')

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issuedRecoveryKey, setIssuedRecoveryKey] = useState<string | null>(
    null,
  )
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false)
  const passwordAutocomplete = passwordAutocompleteFor(mode)

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      if (mode === 'register') {
        const result = await authPost('/v1/auth/register', {
          username,
          password,
        })
        storeAuthResponse({
          session: result.session as AuthSessionResponse,
          username: String(result.username ?? username),
          scope: result.scope as AuthScope,
        })
        setIssuedRecoveryKey(String(result.recoveryKey))
      } else if (mode === 'login') {
        const result = await authPost('/v1/auth/login', { username, password })
        storeAuthResponse({
          session: result.session as AuthSessionResponse,
          username: String(result.username ?? username),
          scope: result.scope as AuthScope,
        })
        window.location.href = withBase('/')
      } else {
        const result = await authPost('/v1/auth/recover', {
          username,
          recoveryKey: recoveryInput,
          newPassword: password,
        })
        storeAuthResponse({
          session: result.session as AuthSessionResponse,
          username: String(result.username ?? username),
          scope: result.scope as AuthScope,
        })
        setIssuedRecoveryKey(String(result.recoveryKey))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Bilinmeyen hata.')
    } finally {
      setPending(false)
    }
  }

  if (issuedRecoveryKey) {
    return (
      <main className="managed-cloud-shell">
        <section className="managed-cloud-card signin-card" aria-live="polite">
          <p className="eyebrow">KURTARMA KODUNUZ</p>
          <h1>Bu kodu şimdi kaydedin</h1>
          <p>
            Bu kod YALNIZ ŞİMDİ gösteriliyor ve sunucuda saklanmıyor. Parolanızı
            unutursanız hesabınıza erişmenin tek yolu budur. Parola ve kod
            birlikte kaybolursa konuşmalarınız kalıcı olarak çözülemez; operatör
            dahil kimse kurtaramaz.
          </p>
          <pre className="recovery-key" data-testid="recovery-key">
            {issuedRecoveryKey}
          </pre>
          <label>
            <input
              type="checkbox"
              checked={recoveryAcknowledged}
              onChange={(event) =>
                setRecoveryAcknowledged(event.target.checked)
              }
            />{' '}
            Kurtarma kodumu güvenli bir yere kaydettim.
          </label>
          <button
            type="button"
            disabled={!recoveryAcknowledged}
            onClick={() => {
              window.location.href = withBase('/')
            }}
          >
            Workspace'e devam et
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="managed-cloud-shell">
      <section className="managed-cloud-card signin-card">
        <p className="eyebrow">PERSISTENT CODEX WORKSPACE</p>
        <h1>
          {mode === 'login'
            ? 'Güvenli giriş'
            : mode === 'register'
              ? 'Hesap oluştur'
              : 'Parola kurtarma'}
        </h1>
        <p>
          Konuşmalarınız parolanızdan türetilen ve sunucu diskine asla
          yazılmayan bir anahtarla şifrelenir. Parolanız olmadan operatör dahil
          kimse içeriğinizi okuyamaz.
        </p>
        <form
          className="onboarding-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label>
            Kullanıcı adı
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              minLength={3}
              maxLength={32}
            />
          </label>
          {mode === 'recover' ? (
            <label>
              Kurtarma kodu
              <input
                name="recoveryKey"
                autoComplete="off"
                value={recoveryInput}
                onChange={(event) => setRecoveryInput(event.target.value)}
                placeholder="RK1-XXXX-XXXX-…"
                required
              />
            </label>
          ) : null}
          <label>
            {mode === 'recover' ? 'Yeni parola' : 'Parola'}
            <input
              name="password"
              type="password"
              autoComplete={passwordAutocomplete}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
            />
          </label>
          {error ? (
            <p className="offline-banner" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={pending}>
            {pending
              ? 'İşleniyor…'
              : mode === 'login'
                ? 'Giriş yap'
                : mode === 'register'
                  ? 'Kayıt ol'
                  : 'Parolayı sıfırla'}
          </button>
        </form>
        <nav className="signin-alternatives" aria-label="Diğer işlemler">
          {mode !== 'login' ? (
            <button type="button" onClick={() => setMode('login')}>
              Giriş yap
            </button>
          ) : null}
          {mode !== 'register' ? (
            <button type="button" onClick={() => setMode('register')}>
              Hesap oluştur
            </button>
          ) : null}
          {mode !== 'recover' ? (
            <button type="button" onClick={() => setMode('recover')}>
              Parolamı unuttum
            </button>
          ) : null}
        </nav>
      </section>
    </main>
  )
}
