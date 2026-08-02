# ADR-0045: Production authorization boundary hardening

Status: Accepted
Date: 2026-08-02

## Context

Production authentication established an active organization membership but did
not bind the caller-selected workspace header to that membership. OIDC validation
also accepted every correctly signed JWT with the configured issuer and audience,
including tokens carrying ID-token signals. Two short-lived capabilities had a
similar freshness problem: status polling refreshed content-key leases, and an
artifact download grant did not re-check that its session remained in the shared
folder recorded when the grant was issued.

These are security-boundary changes, but existing self-hosted sessions and
organization memberships must continue to work during rollout.

## Decision

- Add PostgreSQL workspace membership overrides with explicit `allow` and `deny`
  decisions. A membership with allow rows is limited to those workspaces; an
  explicit deny takes precedence. An empty override set retains legacy
  organization-wide behavior.
- Backfill allow rows for every active membership and existing workspace, and add
  an allow row when self-hosted provisioning creates a workspace.
- Apply the same workspace authorization query to HTTP and realtime entry points,
  and expose allowed workspace IDs from `/v1/me`.
- Mint supported self-hosted access tokens with `typ=at+jwt` and
  `token_use=access`. Reject explicit ID-token types, ID-token-only claims,
  non-access `token_use`, and a foreign or missing authorized party for
  multi-audience tokens. Continue accepting legacy single-audience access tokens
  without those fields until their normal expiry.
- Separate non-mutating content-key lease status checks from key acquisition.
- Revalidate an artifact grant's current session-folder binding at redemption.

## Consequences

Existing installations retain their effective access after migration, while new
workspace-scoped memberships can be enforced without trusting request headers.
Previously issued supported access tokens remain valid, so the change does not
force a logout. Status polling can no longer keep encryption keys unlocked, and
moving a conversation out of a shared folder immediately invalidates its unspent
artifact grants.
