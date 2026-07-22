import { useEffect, useMemo, useState } from 'react'

type ProductionSession = {
  sessionId: string
  status: string
  highWaterSequence: number
}

type ProductionApproval = {
  approvalId: string
  sessionId: string
  state: 'pending' | 'accepted' | 'declined' | 'expired'
  version: number
  context: Record<string, unknown>
}

const apiBaseUrl =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
  'http://127.0.0.1:3100'

function accessToken() {
  if (typeof window === 'undefined') return undefined
  try {
    return (
      JSON.parse(
        window.sessionStorage.getItem('persistent.auth') ?? 'null',
      ) as { accessToken?: string } | null
    )?.accessToken
  } catch {
    return undefined
  }
}

export function ProductionSessionPage({ sessionId }: { sessionId: string }) {
  const query =
    typeof window === 'undefined'
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search)
  const tenantId = query.get('tenant') ?? 'tenant-a'
  const organizationId = query.get('organization') ?? 'organization-a'
  const workspaceId = query.get('workspace') ?? 'workspace-a'
  const headers = useMemo(
    () => ({
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-organization-id': organizationId,
      'x-workspace-id': workspaceId,
      ...(accessToken() ? { authorization: `Bearer ${accessToken()}` } : {}),
    }),
    [organizationId, tenantId, workspaceId],
  )
  const [session, setSession] = useState<ProductionSession>()
  const [approvals, setApprovals] = useState<ProductionApproval[]>([])
  const [realtime, setRealtime] = useState('connecting')
  const [reconnectCount, setReconnectCount] = useState(0)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const [sessionResponse, approvalsResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            headers,
          }),
          fetch(`${apiBaseUrl}/v1/approvals`, { headers }),
        ])
        if (!sessionResponse.ok || !approvalsResponse.ok)
          throw new Error(
            `production API ${sessionResponse.status}/${approvalsResponse.status}`,
          )
        if (!active) return
        setSession((await sessionResponse.json()) as ProductionSession)
        setApprovals(
          (
            (await approvalsResponse.json()) as {
              approvals: ProductionApproval[]
            }
          ).approvals.filter((value) => value.sessionId === sessionId),
        )
        setError(undefined)
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [headers, sessionId])

  useEffect(() => {
    let active = true
    let socket: WebSocket | undefined
    let timer: number | undefined
    const connect = () => {
      if (!active) return
      const url = new URL('/v1/realtime', apiBaseUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
      setRealtime('connecting')
      socket.addEventListener('open', () => {
        setRealtime('connected')
        socket?.send(
          JSON.stringify({
            type: 'subscribe',
            accessToken: accessToken(),
            tenantId,
            organizationId,
            workspaceId,
            sessionId,
            afterSequence: 0,
          }),
        )
      })
      socket.addEventListener('message', () => setRealtime('connected'))
      socket.addEventListener('close', () => {
        if (!active) return
        setReconnectCount((value) => value + 1)
        setRealtime('reconnecting')
        timer = window.setTimeout(connect, 200)
      })
    }
    connect()
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
      socket?.close()
    }
  }, [organizationId, sessionId, tenantId, workspaceId])

  const decide = async (approval: ProductionApproval) => {
    const response = await fetch(
      `${apiBaseUrl}/v1/approvals/${encodeURIComponent(approval.approvalId)}/decision`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          decision: 'accept',
          expectedVersion: approval.version,
        }),
      },
    )
    if (!response.ok) setError(`approval decision ${response.status}`)
  }

  return (
    <main
      className="production-session"
      data-production-session-ready={Boolean(session) || undefined}
      data-realtime-state={realtime}
      data-reconnect-count={reconnectCount}
    >
      <style>{`
        .production-session{box-sizing:border-box;max-width:72rem;min-height:100vh;margin:auto;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere}
        .production-session header,.production-approval{border:1px solid #2e4d43;border-radius:1rem;padding:1rem;background:#10231e}
        .production-approval{margin-top:1rem}.production-approval button{min-height:44px;padding:.65rem 1rem}
        .production-status{display:flex;gap:.75rem;flex-wrap:wrap}.production-error{color:#ff9d8e}
      `}</style>
      <header>
        <p>Production HA session</p>
        <h1>{session?.sessionId ?? 'Session yükleniyor'}</h1>
        <div className="production-status">
          <span data-session-state>{session?.status ?? 'loading'}</span>
          <span data-realtime>{realtime}</span>
          <span data-high-water>{session?.highWaterSequence ?? 0}</span>
        </div>
      </header>
      {error ? (
        <p className="production-error" data-error-overlay>
          {error}
        </p>
      ) : null}
      <section aria-label="Approvals">
        {approvals.map((approval) => (
          <article
            className="production-approval"
            data-approval-id={approval.approvalId}
            data-approval-state={approval.state}
            key={approval.approvalId}
          >
            <strong>Komut onayı</strong>
            <pre>{String(approval.context.command ?? 'opaque-command')}</pre>
            <p>{approval.state}</p>
            {approval.state === 'pending' ? (
              <button type="button" onClick={() => void decide(approval)}>
                Onayla
              </button>
            ) : null}
          </article>
        ))}
      </section>
    </main>
  )
}
