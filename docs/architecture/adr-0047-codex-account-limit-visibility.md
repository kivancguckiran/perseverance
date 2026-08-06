# ADR-0047: Restricted visibility for Codex account limits

- Status: Accepted
- Date: 2026-08-04

## Context

Codex app-server exposes ChatGPT rate-limit windows through
`account/rateLimits/read`. In self-hosted production, the Codex authentication
file is operator-provisioned and may represent shared upstream capacity rather
than the signed-in Perseverance principal. Treating this data as ordinary
conversation usage would both mislabel it and expose account-level plan or
credit information too broadly.

## Decision

- Expose a read-only, workspace-scoped Codex limits contract separately from
  conversation usage and Perseverance billing quotas.
- Authorize the public endpoint with `billing.financial.read`; only owner,
  admin, and billing roles may render the control.
- Return rate-limit windows, plan type, reached-limit classification, and the
  upstream credit summary. Never return account email, tokens, credentials, or
  raw authentication envelopes.
- In the local topology, request the snapshot from the workspace's initialized
  app-server runtime. In production, cache a normalized snapshot under the
  explicit tenant, organization, and workspace tuple when the isolated runtime
  connects. Return `unavailable` until such a snapshot exists.
- Keep API-key authentication distinct: API-billed sessions return
  `unsupported` because ChatGPT usage-limit windows do not describe API spend.
- Do not expose rate-limit-reset consumption or other account mutations through
  this surface.

## Consequences

The UI can show remaining Codex capacity and reset times without parsing local
auth state or conflating upstream limits with product billing. Production data
may be temporarily stale or unavailable while no Codex runtime has connected;
the response includes `observedAt` and the UI labels this state explicitly.
