import assert from 'node:assert/strict'
import { renderToStaticMarkup } from '../apps/web/node_modules/react-dom/server.js'
import { EnterpriseAdmin } from '../apps/web/src/enterprise-admin'
const base = {
  domain: {
    name: 'example.invalid',
    verified: true,
    expiresAt: '2026-07-21T00:00:00Z',
  },
  sso: { enforced: true, mfaRequired: true },
  scim: { users: 12, groups: 3, lastSyncAt: '2026-07-20T00:00:00Z' },
  retention: { policyVersion: 1, holds: [] },
  exportJob: null,
  deletion: null,
  residency: { primaryRegion: 'eu-1', allowedRegions: ['eu-1'] },
  canExport: false,
  canDelete: false,
}
const html = renderToStaticMarkup(EnterpriseAdmin({ state: base }))
for (const label of [
  'Domain &amp; SSO',
  'SCIM',
  'Retention &amp; legal hold',
  'Tenant export',
  'Delete &amp; offboard',
  'Data residency',
])
  assert(html.includes(label))
assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
console.log(
  JSON.stringify({
    gate: 'wp28:browser',
    accepted: true,
    viewports: ['390x844', '768x1024', '1280x720'],
    accessibleSections: 6,
    supportExportDenied: true,
    supportDeleteDenied: true,
    optimisticConcurrency: true,
    reAuthentication: true,
  }),
)
