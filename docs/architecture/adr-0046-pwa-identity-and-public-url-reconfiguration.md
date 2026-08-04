# ADR-0046: Durable PWA identity and public URL reconfiguration

Status: Accepted
Date: 2026-08-04

## Context

Self-hosted installations can move to a new public hostname or reverse-proxy
base path. The web app manifest previously used relative values for `id`,
`start_url`, and `scope`. Relative launch and scope values are correct for a
configurable base path, but a relative `id` also changes the installed
application identity when that base path changes. Browsers can then treat the
same deployment as a second PWA instead of updating the existing installation.

Changing the public origin also updates the control-plane CORS boundary, Caddy
site address, web runtime substitution, and base-path-specific product image.
Editing those values independently can leave a partially migrated installation.

## Decision

- Persist `SELF_HOSTED_PWA_ID` as root-relative installation state. Derive it
  from the base path at first install and preserve it across later base-path
  changes. Existing installations derive the same identity browsers already
  computed from their relative manifest ID.
- Preserve that identity by default, but permit an explicit `--pwa-id` rotation
  when an operator intentionally retires the old installed-app identity. Treat
  this as a user-visible reinstall boundary, not as a silent migration.
- Render the self-hosted manifest at runtime with the durable identity and with
  `start_url`, `scope`, and icon paths rooted at the current base path. Reject
  IDs containing an origin, query, fragment, traversal, or invalid segment.
- Add a canonical `self-hosted.sh reconfigure --domain <host> --base-path <path>`
  lifecycle operation. It validates inputs, creates and verifies an encrypted
  backup, builds the base-path-specific product image, updates origin/CORS and
  proxy configuration together, recreates the stack, and requires public
  readiness before recording success.
- If reconfiguration fails after mutation begins, restore the prior domain,
  public origin, base path, PWA identity, product image, Caddy configuration,
  and running stack. The encrypted pre-change backup remains available.
- Store those public URL/PWA coordinates in current and previous release state,
  so the ordinary rollback command restores a matching image and configuration
  rather than combining an old base-path build with a new base path.
- This mechanism supports a same-origin path migration. Browser storage,
  permissions, service workers, and installed-app identity cannot be silently
  transferred between unrelated origins; that remains a user-visible reinstall.

## Consequences

Future base-path moves do not intentionally create duplicate installed PWAs.
The current launch URL and service-worker scope still follow the deployed base
path. Public URL changes have one backed-up, fail-closed lifecycle instead of a
sequence of manual env and container edits. Reverse proxies may retain the old
path as a compatibility redirect or manifest/service-worker bridge during a
same-origin transition, but that operator routing remains outside the product
security boundary.
