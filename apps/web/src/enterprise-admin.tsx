import * as React from 'react'
import type {
  DeletionJob,
  ExportJob,
  LegalHold,
} from '@persistent-codex/enterprise-lifecycle/contracts'

export type EnterpriseAdminState = {
  domain: { name: string; verified: boolean; expiresAt: string }
  sso: { enforced: boolean; mfaRequired: boolean }
  scim: { users: number; groups: number; lastSyncAt: string | null }
  retention: { policyVersion: number; holds: LegalHold[] }
  exportJob: ExportJob | null
  deletion: DeletionJob | null
  residency: { primaryRegion: string; allowedRegions: string[] }
  canExport: boolean
  canDelete: boolean
  exportManifest?: {
    watermark: string
    archiveSha256: string
    archiveByteLength: number
    objects: unknown[]
  } | null
}
export function destructiveConfirmationMatches(
  input: string,
  tenantLabel: string,
) {
  return input.trim() === tenantLabel
}
export function EnterpriseAdmin({ state }: { state: EnterpriseAdminState }) {
  return (
    <main className="enterprise-admin" aria-labelledby="enterprise-title">
      <header>
        <p className="eyebrow">Enterprise controls</p>
        <h1 id="enterprise-title">Identity &amp; data lifecycle</h1>
      </header>
      <section aria-labelledby="domain-title">
        <h2 id="domain-title">Domain &amp; SSO</h2>
        <p>
          {state.domain.name} ·{' '}
          {state.domain.verified ? 'Verified' : 'Verification pending'}
        </p>
        <dl>
          <dt>Enforced SSO</dt>
          <dd>{state.sso.enforced ? 'On' : 'Off'}</dd>
          <dt>MFA policy</dt>
          <dd>{state.sso.mfaRequired ? 'Required' : 'Optional'}</dd>
        </dl>
      </section>
      <section aria-labelledby="scim-title">
        <h2 id="scim-title">SCIM</h2>
        <p>
          {state.scim.users} users · {state.scim.groups} groups
        </p>
        <p role="status">Last sync: {state.scim.lastSyncAt ?? 'Never'}</p>
      </section>
      <section aria-labelledby="retention-title">
        <h2 id="retention-title">Retention &amp; legal hold</h2>
        <p>Policy v{state.retention.policyVersion}</p>
        <ul>
          {state.retention.holds.map((h) => (
            <li key={h.holdId}>
              {h.reasonCode} · {h.state} · expires {h.expiresAt}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="export-title">
        <h2 id="export-title">Tenant export</h2>
        <p role="status">{state.exportJob?.state ?? 'No export running'}</p>
        <button disabled={!state.canExport}>Request export</button>
        {state.exportManifest ? (
          <dl id="export-manifest">
            <dt>Watermark</dt>
            <dd>{state.exportManifest.watermark}</dd>
            <dt>Objects</dt>
            <dd>{state.exportManifest.objects.length}</dd>
            <dt>Archive bytes</dt>
            <dd>{state.exportManifest.archiveByteLength}</dd>
            <dt>Checksum</dt>
            <dd>{state.exportManifest.archiveSha256}</dd>
          </dl>
        ) : null}
      </section>
      <section className="danger-zone" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete &amp; offboard</h2>
        <p role="status">
          {state.deletion
            ? `${state.deletion.state}: ${state.deletion.currentStep}`
            : 'Not started'}
        </p>
        <button disabled={!state.canDelete}>Review destructive delete</button>
      </section>
      <section aria-labelledby="region-title">
        <h2 id="region-title">Data residency</h2>
        <p>
          {state.residency.primaryRegion} ·{' '}
          {state.residency.allowedRegions.join(', ')}
        </p>
      </section>
    </main>
  )
}
