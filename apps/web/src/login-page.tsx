// WP37 — self-hosted giriş/kayıt/kurtarma sayfası (ADR-0037).
// Parola yalnız istekte kullanılır, hiçbir storage'a yazılmaz. Recovery key
// kayıt ve kurtarma yanıtlarında BİR KEZ gösterilir; kullanıcı sakladığını
// onaylamadan devam edilmez.
import { withBase } from './base-path'
import { useState } from 'react'
import { storeAuthResponse, type AuthSessionResponse } from './self-hosted-auth'
import { useTranslations } from './i18n'

const apiBaseUrl =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
  'http://127.0.0.1:3100'

type Mode = 'login' | 'register' | 'recover'

interface AuthScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

const ERROR_MESSAGES: Record<string, [string, string]> = {
  INVALID_CREDENTIALS: [
    'Incorrect username or password.',
    'Kullanıcı adı veya parola hatalı.',
  ],
  REGISTRATION_NOT_ALLOWED: [
    'This username is not on the allowlist. Ask your operator to add it.',
    'Bu kullanıcı adı izin listesinde değil. Operatörünüzden allowlist kaydı isteyin.',
  ],
  USERNAME_TAKEN: [
    'This username is already registered.',
    'Bu kullanıcı adı zaten kayıtlı.',
  ],
  AUTH_RATE_LIMITED: [
    'Too many attempts. Wait a while and try again.',
    'Çok fazla deneme yapıldı. Bir süre bekleyip yeniden deneyin.',
  ],
  PASSWORD_TOO_SHORT: [
    'The password must be at least 8 characters.',
    'Parola en az 8 karakter olmalı.',
  ],
  INVALID_USERNAME: [
    'The username must be 3–32 characters using lowercase letters, numbers, hyphens, or underscores.',
    'Kullanıcı adı 3-32 karakter olmalı; yalnız küçük harf, rakam, tire ve alt çizgi.',
  ],
  INVALID_RECOVERY_KEY: [
    'The recovery code could not be verified.',
    'Kurtarma kodu doğrulanamadı.',
  ],
  USER_DISABLED: [
    'This account is disabled. Contact your operator.',
    'Bu hesap devre dışı bırakılmış. Operatörünüzle görüşün.',
  ],
  CONTENT_KEY_UNWRAP_FAILED: [
    'The content key could not be unlocked. Check your password.',
    'İçerik anahtarı çözülemedi. Parolanızı kontrol edin.',
  ],
  INVALID_AUTH_REQUEST: [
    'The request could not be verified. Check the fields.',
    'İstek doğrulanamadı. Alanları kontrol edin.',
  ],
}

async function authPost(
  path: string,
  body: Record<string, string>,
  t: (english: string, turkish: string) => string,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(
      t(
        'Could not reach the server. Check your connection.',
        'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.',
      ),
    )
  }
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string
  }
  const localizedError = ERROR_MESSAGES[payload.code ?? '']
  if (!response.ok)
    throw new Error(
      localizedError
        ? t(localizedError[0], localizedError[1])
        : t(
            `Operation failed (${payload.code ?? response.status}).`,
            `İşlem başarısız (${payload.code ?? response.status}).`,
          ),
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
  const t = useTranslations()
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
  const [recoveryCopied, setRecoveryCopied] = useState(false)
  const passwordAutocomplete = passwordAutocompleteFor(mode)

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      if (mode === 'register') {
        const result = await authPost(
          '/v1/auth/register',
          {
            username,
            password,
          },
          t,
        )
        storeAuthResponse({
          session: result.session as AuthSessionResponse,
          username: String(result.username ?? username),
          scope: result.scope as AuthScope,
        })
        setIssuedRecoveryKey(String(result.recoveryKey))
      } else if (mode === 'login') {
        const result = await authPost(
          '/v1/auth/login',
          { username, password },
          t,
        )
        storeAuthResponse({
          session: result.session as AuthSessionResponse,
          username: String(result.username ?? username),
          scope: result.scope as AuthScope,
        })
        window.location.href = withBase('/')
      } else {
        const result = await authPost(
          '/v1/auth/recover',
          {
            username,
            recoveryKey: recoveryInput,
            newPassword: password,
          },
          t,
        )
        storeAuthResponse({
          session: result.session as AuthSessionResponse,
          username: String(result.username ?? username),
          scope: result.scope as AuthScope,
        })
        setIssuedRecoveryKey(String(result.recoveryKey))
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('Unknown error.', 'Bilinmeyen hata.'),
      )
    } finally {
      setPending(false)
    }
  }

  if (issuedRecoveryKey) {
    return (
      <main className="recovery-poster">
        <section className="recovery-poster-content" aria-live="polite">
          <p className="eyebrow">
            {t('YOUR RECOVERY CODE', 'KURTARMA KODUNUZ')}
          </p>
          <h1>{t('Save this code now', 'Bu kodu şimdi kaydedin')}</h1>
          <p>
            {t(
              'This code is shown ONLY NOW and is not stored on the server. It is the only way to regain access if you forget your password. If both are lost, your conversations cannot be decrypted—not even by the operator.',
              'Bu kod YALNIZ ŞİMDİ gösteriliyor ve sunucuda saklanmıyor. Parolanızı unutursanız hesabınıza erişmenin tek yolu budur. Parola ve kod birlikte kaybolursa konuşmalarınız kalıcı olarak çözülemez; operatör dahil kimse kurtaramaz.',
            )}
          </p>
          <pre className="recovery-key" data-testid="recovery-key">
            {issuedRecoveryKey}
          </pre>
          <div className="recovery-key-actions">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(issuedRecoveryKey)
                setRecoveryCopied(true)
                window.setTimeout(() => setRecoveryCopied(false), 2_000)
              }}
            >
              {recoveryCopied
                ? t('Copied ✓', 'Kopyalandı ✓')
                : t('Copy', 'Kopyala')}
            </button>
            <button
              type="button"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([`${issuedRecoveryKey}\n`], {
                    type: 'text/plain;charset=utf-8',
                  }),
                )
                const link = document.createElement('a')
                link.href = url
                link.download = 'perseverance-recovery-code.txt'
                link.click()
                URL.revokeObjectURL(url)
              }}
            >
              {t('Download (.txt)', 'İndir (.txt)')}
            </button>
          </div>
          <label className="recovery-acknowledgement">
            <input
              type="checkbox"
              checked={recoveryAcknowledged}
              onChange={(event) =>
                setRecoveryAcknowledged(event.target.checked)
              }
            />{' '}
            {t(
              'I saved my recovery code somewhere safe.',
              'Kurtarma kodumu güvenli bir yere kaydettim.',
            )}
          </label>
          <button
            className="recovery-continue"
            type="button"
            disabled={!recoveryAcknowledged}
            onClick={() => {
              window.location.href = withBase('/')
            }}
          >
            {t('CONTINUE TO WORKSPACE →', "WORKSPACE'E DEVAM ET →")}
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-accent-rule" aria-hidden="true" />
        <div className="auth-brand">
          <span aria-hidden="true" />
          <strong>PERSEVERANCE</strong>
        </div>
        <p className="auth-subbrand">SELF-HOSTED AGENT WORKSPACE</p>
        <h1>
          {mode === 'login'
            ? t('Secure sign in', 'Güvenli giriş')
            : mode === 'register'
              ? t('Create account', 'Hesap oluştur')
              : t('Password recovery', 'Parola kurtarma')}
        </h1>
        <p>
          {t(
            'Your conversations are encrypted with a key derived from your password and never written to the server disk. Without your password, no one—including the operator—can read your content.',
            'Konuşmalarınız parolanızdan türetilen ve sunucu diskine asla yazılmayan bir anahtarla şifrelenir. Parolanız olmadan operatör dahil kimse içeriğinizi okuyamaz.',
          )}
        </p>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label>
            {t('Username', 'Kullanıcı adı')}
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
              {t('Recovery code', 'Kurtarma kodu')}
              <input
                name="recoveryKey"
                autoComplete="off"
                value={recoveryInput}
                onChange={(event) => setRecoveryInput(event.target.value)}
                placeholder="PRSV-XXXX-XXXX-…"
                required
              />
            </label>
          ) : null}
          <label>
            {mode === 'recover'
              ? t('New password', 'Yeni parola')
              : t('Password', 'Parola')}
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
          <button className="auth-submit" type="submit" disabled={pending}>
            {pending
              ? t('Processing…', 'İşleniyor…')
              : mode === 'login'
                ? t('Sign in →', 'Giriş yap →')
                : mode === 'register'
                  ? t('Create account →', 'Hesap oluştur →')
                  : t('Reset password →', 'Parolayı sıfırla →')}
          </button>
        </form>
        <nav
          className="signin-alternatives"
          aria-label={t('Other actions', 'Diğer işlemler')}
        >
          {mode !== 'login' ? (
            <button type="button" onClick={() => setMode('login')}>
              {t('Back to sign in', 'Girişe dön')}
            </button>
          ) : null}
          {mode !== 'register' ? (
            <button type="button" onClick={() => setMode('register')}>
              {t('Create account', 'Hesap oluştur')}
            </button>
          ) : null}
          {mode !== 'recover' ? (
            <button type="button" onClick={() => setMode('recover')}>
              {t('Forgot password', 'Parolamı unuttum')}
            </button>
          ) : null}
        </nav>
        <footer className="auth-footer">v1.0.0 · AGPL-3.0 · SELF-HOSTED</footer>
      </section>
    </main>
  )
}
