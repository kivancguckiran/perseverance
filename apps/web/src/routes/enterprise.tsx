import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { EnterpriseAdmin, type EnterpriseAdminState } from '../enterprise-admin'

type BrowserState = EnterpriseAdminState & {
  exportManifest: {
    watermark: string
    archiveSha256: string
    archiveByteLength: number
    objects: unknown[]
  } | null
  holdVersion: number
  deletionVersion: number
}

export const Route = createFileRoute('/enterprise')({
  component: EnterpriseRoute,
})

function EnterpriseRoute() {
  const [state, setState] = React.useState<BrowserState | null>(null)
  const [reauth, setReauth] = React.useState('')
  const [holdVersion, setHoldVersion] = React.useState(0)
  const [deleteVersion, setDeleteVersion] = React.useState(0)
  const [status, setStatus] = React.useState<Record<string, string>>({})
  const load = React.useCallback(async () => {
    const next = (await fetch('/wp28-enterprise-api/state').then((response) =>
      response.json(),
    )) as BrowserState
    setState(next)
    setHoldVersion((current) => current || Math.max(1, next.holdVersion - 1))
    setDeleteVersion(
      (current) => current || Math.max(1, next.deletionVersion - 1),
    )
  }, [])
  React.useEffect(() => void load(), [load])
  const authenticate = async () => {
    setStatus((value) => ({ ...value, reauth: 'Re-authenticating…' }))
    const response = await fetch('/wp28-enterprise-api/reauth', {
      method: 'POST',
    })
    const body = (await response.json()) as { token: string }
    setReauth(body.token)
    setStatus((value) => ({ ...value, reauth: 'Re-authenticated' }))
  }
  const mutate = async (kind: 'legal-hold' | 'delete') => {
    setStatus((value) => ({ ...value, [kind]: 'Pending…' }))
    const expectedVersion = kind === 'legal-hold' ? holdVersion : deleteVersion
    const response = await fetch(`/wp28-enterprise-api/${kind}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-reauth': reauth,
      },
      body: JSON.stringify({ expectedVersion }),
    })
    setReauth('')
    const body = (await response.json()) as {
      code?: string
      currentVersion?: number
    }
    if (response.status === 409 && body.currentVersion) {
      if (kind === 'legal-hold') setHoldVersion(body.currentVersion)
      else setDeleteVersion(body.currentVersion)
    }
    setStatus((value) => ({
      ...value,
      [kind]: `${response.status} ${body.code ?? 'OK'}`,
    }))
    if (response.ok) await load()
  }
  const supportProbe = async (kind: 'export' | 'delete') => {
    const response = await fetch(`/wp28-enterprise-api/support-${kind}`, {
      method: 'POST',
    })
    setStatus((value) => ({
      ...value,
      [`support-${kind}`]:
        `${response.status} ${(value[`support-${kind}`] ?? '').includes('403') ? '' : 'FORBIDDEN'}`.trim(),
    }))
  }
  const download = async () => {
    const response = await fetch('/wp28-enterprise-api/export/download', {
      headers: { Range: 'bytes=0-31' },
    })
    const bytes = await response.arrayBuffer()
    setStatus((value) => ({
      ...value,
      download: `${response.status} ${bytes.byteLength} bytes`,
    }))
  }
  if (!state)
    return <main id="enterprise-loading">Loading enterprise state…</main>
  return (
    <div className="enterprise-page">
      <EnterpriseAdmin state={state} />
      <aside className="acceptance-controls" aria-label="Acceptance controls">
        <h2>Live acceptance controls</h2>
        <button id="support-export" onClick={() => void supportProbe('export')}>
          Support export attempt
        </button>
        <output id="support-export-status">{status['support-export']}</output>
        <button id="support-delete" onClick={() => void supportProbe('delete')}>
          Support delete attempt
        </button>
        <output id="support-delete-status">{status['support-delete']}</output>
        <button id="reauth" onClick={() => void authenticate()}>
          Re-authenticate
        </button>
        <output id="reauth-status">{status.reauth}</output>
        <button id="release-hold" onClick={() => void mutate('legal-hold')}>
          Release legal hold
        </button>
        <output id="legal-hold-status">{status['legal-hold']}</output>
        <button id="continue-delete" onClick={() => void mutate('delete')}>
          Continue delete
        </button>
        <output id="delete-status">{status.delete}</output>
        <button id="download-export" onClick={() => void download()}>
          Download export range
        </button>
        <output id="download-status">{status.download}</output>
      </aside>
    </div>
  )
}
