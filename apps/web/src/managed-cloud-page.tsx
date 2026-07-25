import { useEffect, useState, type FormEvent } from 'react'

const apiBaseUrl =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
  'http://127.0.0.1:3100'

function accessToken() {
  if (typeof window === 'undefined') return null
  const injected = (
    window as typeof window & {
      __PERSISTENT_AUTH__?: { accessToken?: string }
    }
  ).__PERSISTENT_AUTH__?.accessToken
  if (injected) return injected
  try {
    return (
      (
        JSON.parse(
          window.sessionStorage.getItem('persistent.auth') ?? 'null',
        ) as { accessToken?: string } | null
      )?.accessToken ?? null
    )
  } catch {
    return null
  }
}

async function managedRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = accessToken()
  if (!token) throw new Error('SIGN_IN_REQUIRED')
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  const body = (await response.json()) as T & { code?: string }
  if (!response.ok) throw new Error(body.code ?? `HTTP_${response.status}`)
  return body
}

interface OnboardingResult {
  tenantId: string
  organizationId: string
  workspaceId: string
  firstTaskId: string
  state: string
}

interface Overview {
  plan: { displayName: string; planVersion: number; currency: string }
  quotas: Array<{ meter: string; hardLimit: number | null }>
  budgets: Array<{ hardLimitMicros: number | null; currency: string }>
  credits: { balance: { availableCreditsMicros: number } }
}

interface Usage {
  totals: {
    hostingMicros: number
    computeMicros: number
    storageMicros: number
    modelMicros: number
  }
  estimatesAreNotInvoices: boolean
}

interface Replay {
  state: 'running' | 'completed' | 'failed' | 'interrupted'
  output: string | null
}

export function ManagedCloudPage() {
  const [signedIn, setSignedIn] = useState(false)
  const [created, setCreated] = useState<OnboardingResult | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [replay, setReplay] = useState<Replay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSignedIn(Boolean(accessToken()))
    if (typeof window === 'undefined') return
    try {
      const saved = JSON.parse(
        window.localStorage.getItem('managed-cloud.onboarding') ?? 'null',
      ) as OnboardingResult | null
      if (saved) setCreated(saved)
    } catch {
      window.localStorage.removeItem('managed-cloud.onboarding')
    }
  }, [])

  useEffect(() => {
    if (!created || !signedIn) return
    let cancelled = false
    const refresh = async () => {
      try {
        const [nextOverview, nextUsage, nextReplay] = await Promise.all([
          managedRequest<Overview>(
            `/v1/managed-cloud/workspaces/${created.workspaceId}/overview`,
          ),
          managedRequest<Usage>(
            `/v1/managed-cloud/workspaces/${created.workspaceId}/usage`,
          ),
          managedRequest<Replay>(
            `/v1/managed-cloud/workspaces/${created.workspaceId}/tasks/${created.firstTaskId}/replay`,
          ),
        ])
        if (!cancelled) {
          setOverview(nextOverview)
          setUsage(nextUsage)
          setReplay(nextReplay)
        }
      } catch (refreshError) {
        if (!cancelled)
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : 'REFRESH_FAILED',
          )
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [created, signedIn])

  const signin = () => {
    if (typeof window === 'undefined') return
    const url =
      (import.meta.env.VITE_OIDC_SIGNIN_URL as string | undefined) ??
      `/v1/auth/login?returnTo=${encodeURIComponent('/managed-cloud')}`
    window.location.assign(url)
  }

  const onboard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const data = new FormData(event.currentTarget)
    try {
      const result = await managedRequest<OnboardingResult>(
        '/v1/managed-cloud/onboarding',
        {
          method: 'POST',
          headers: { 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({
            displayName: String(data.get('displayName')),
            workspaceName: String(data.get('workspaceName')),
            regionId: 'eu-1',
            planId: 'limited-beta',
            planVersion: 1,
            provider: String(data.get('provider')),
            authMode: 'customer-api-key',
            accessToken: String(data.get('providerCredential')),
            firstTaskPrompt: String(data.get('prompt')),
          }),
        },
      )
      window.localStorage.setItem(
        'managed-cloud.onboarding',
        JSON.stringify(result),
      )
      setCreated(result)
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'ONBOARDING_FAILED',
      )
    } finally {
      setBusy(false)
    }
  }

  if (!signedIn)
    return (
      <main className="managed-cloud-shell">
        <section className="managed-cloud-card signin-card">
          <p className="eyebrow">Managed Cloud · Limited Beta</p>
          <h1>Kalıcı agent workspace’inize giriş yapın</h1>
          <p>
            Kimliğiniz OIDC sağlayıcınız tarafından doğrulanır. Tenant veya
            workspace kapsamı tarayıcı header’larından alınmaz.
          </p>
          <button type="button" onClick={signin}>
            Güvenli giriş
          </button>
        </section>
      </main>
    )

  return (
    <main className="managed-cloud-shell">
      <header className="managed-cloud-hero">
        <div>
          <p className="eyebrow">Managed Cloud · Limited Beta</p>
          <h1>Telefondan başlatın, agent arka planda sürsün.</h1>
          <p>
            Plan, kota ve bütçe sunucu kataloğundan çözülür; tahminler fatura
            değildir.
          </p>
        </div>
        <span className="managed-cloud-status">
          {replay?.state ?? created?.state ?? 'hazır'}
        </span>
      </header>

      {!created ? (
        <form className="managed-cloud-card onboarding-form" onSubmit={onboard}>
          <h2>Workspace oluştur</h2>
          <label>
            Görünen ad
            <input name="displayName" defaultValue="Beta kullanıcı" required />
          </label>
          <label>
            Workspace adı
            <input name="workspaceName" defaultValue="Mobile Agent" required />
          </label>
          <label>
            Plan
            <select name="plan" disabled>
              <option>Managed Cloud Limited Beta · v1</option>
            </select>
          </label>
          <label>
            Provider
            <select name="provider" defaultValue="claude">
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini API key</option>
            </select>
          </label>
          <label>
            Provider credential
            <input
              name="providerCredential"
              type="password"
              autoComplete="off"
              minLength={8}
              required
            />
          </label>
          <label>
            İlk task
            <textarea
              name="prompt"
              defaultValue="Repository durumunu incele ve kısa bir özet hazırla."
              required
            />
          </label>
          <button disabled={busy} type="submit">
            {busy ? 'Hazırlanıyor…' : 'Workspace ve ilk task’ı başlat'}
          </button>
        </form>
      ) : (
        <section className="managed-cloud-grid">
          <article className="managed-cloud-card">
            <h2>Plan ve sınırlar</h2>
            <strong>
              {overview?.plan.displayName ?? 'Canonical plan yükleniyor'}
            </strong>
            <p>
              {overview
                ? `v${overview.plan.planVersion} · ${overview.plan.currency}`
                : 'Sunucu kataloğu doğrulanıyor…'}
            </p>
            <ul>
              {overview?.quotas.map((quota) => (
                <li key={quota.meter}>
                  {quota.meter}: {quota.hardLimit ?? 'limitsiz'}
                </li>
              ))}
              {overview?.budgets.map((budget, index) => (
                <li key={`${budget.currency}-${index}`}>
                  bütçe: {budget.hardLimitMicros ?? 'limitsiz'} µ
                  {budget.currency}
                </li>
              ))}
            </ul>
          </article>

          <article className="managed-cloud-card">
            <h2>Kullanım ayrımı</h2>
            <dl className="managed-usage">
              <div>
                <dt>Hosting</dt>
                <dd>{usage?.totals.hostingMicros ?? 0} µ</dd>
              </div>
              <div>
                <dt>Compute</dt>
                <dd>{usage?.totals.computeMicros ?? 0} µ</dd>
              </div>
              <div>
                <dt>Storage</dt>
                <dd>{usage?.totals.storageMicros ?? 0} µ</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{usage?.totals.modelMicros ?? 0} µ</dd>
              </div>
            </dl>
            <small>Tahmini değerler kesin fatura verisi değildir.</small>
          </article>

          <article className="managed-cloud-card task-output">
            <h2>Durable task</h2>
            <p>
              İstemci kapalı olsa da server-side task çalışmayı sürdürür.
              Yeniden açıldığında replay burada görünür.
            </p>
            <pre>{replay?.output ?? 'Task çıktısı bekleniyor…'}</pre>
          </article>
        </section>
      )}
      {error ? <p className="managed-cloud-error">{error}</p> : null}
    </main>
  )
}
