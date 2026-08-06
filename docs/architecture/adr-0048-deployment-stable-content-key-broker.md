# ADR-0048: Deployment-stable in-memory content-key broker

- Status: Accepted
- Date: 2026-08-04
- Scope: self-hosted content-key lease ownership and deployment lifecycle

## Context

Self-hosted login unwraps a user's content key with password-derived key
material. The decrypted key previously lived in the control-plane process. A
normal release recreates that process, so an otherwise valid browser identity
session became content-locked and asked the user for their password after every
deployment.

Writing the decrypted key to disk, persisting the password-derived KEK, or
wrapping the key with a colocated server secret would remove that prompt but
would weaken the password-bound at-rest privacy decision. Routine application
replacement should not be equivalent to a machine or key-custody restart.

## Decision

Run a dedicated `content-key-broker` service on an isolated internal network
shared only with the control plane and Workspace Agent.
It owns the existing `ContentKeyLeaseManager` and therefore keeps decrypted
32-byte content keys only in process memory. The control plane retains password
verification, wrapped-key persistence, identity sessions, and authorization.
Workspace Agent and the control plane acquire keys through a versioned internal
HTTP contract.

All broker operations require the existing internal runtime bearer token. The
broker has no public proxy route, database credentials, workspace mount, or
durable volume. Its container is read-only, capability-free, and runs as the
non-root product user. Request schemas bound key size and tenant/workspace
scope; consumers validate responses and fail closed on broker or scope errors.

Lease lifecycle audit events contain only scope, user ID, action, and lease ID.
The broker buffers these bounded, non-secret events in memory while the control
plane is unavailable and retries the authenticated internal audit endpoint.
Content-key bytes never enter audit payloads, logs, traces, fixtures, or durable
storage.

Self-hosted lifecycle commands compare the SHA-256 digest of the running broker
bundle with the bundle in the target product image. When they match, commands
start the broker with `--no-recreate`, then recreate application services with
dependencies disabled. Thus a routine upgrade, rollback, or same-host public
URL reconfiguration preserves the broker process even when the product image
tag changes. A broker code or dependency change deliberately recreates the
broker so a security fix cannot remain pinned behind old process memory, and
the lifecycle log states that active content will relock. Restore explicitly
stops the broker because restored encrypted data must not be paired with
pre-restore key state. Uninstall and host shutdown retain their existing
process/volume semantics.

The internal protocol is backward-compatible within an active broker's lease
window. Any broker bundle change intentionally locks active content until
password re-entry; application-only changes do not.

## Consequences

Routine deployments no longer require password re-entry for users with an
active content-key lease. Browser identity refresh and content-key custody
remain separate controls.

A host reboot, broker crash/restart, restore, lease expiry, explicit logout, or
security revocation still removes in-memory access and may require the password
to unlock content. This preserves the property that copied database, object
storage, release, and secret-store files alone do not contain a server-usable
decrypted content key.

The broker initially uses the product image but exposes only its small broker
entrypoint and the restricted runtime profile above. Because lifecycle commands
preserve the running container, ordinary product-image changes do not restart
it. A future dedicated minimal image is compatible with this boundary but is
not required for the protocol or custody decision.
