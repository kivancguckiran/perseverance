# ADR-0043: Non-expiring self-hosted sign-in sessions

- Status: Accepted
- Date: 2026-08-02
- Scope: self-hosted browser authentication and refresh-token persistence

## Context

Self-hosted sign-in used one-hour access tokens backed by rotating refresh
tokens with a fixed 30-day lifetime. The web client stored the refresh token so
the access token could be renewed silently, but the fixed refresh-token deadline
eventually forced an otherwise active user through the login screen again.

The product should keep a signed-in browser signed in until the user or an
operator takes an explicit account action. This changes authentication and
persistence behavior, so it is recorded as a security and data-model decision.

## Decision

New self-hosted refresh tokens have no time-based expiration. The database
stores `expires_at = NULL`, and the public session response returns
`refreshTokenExpiresAt: null`. The shared contract temporarily accepts the old
datetime representation so the web and control-plane can be rolled out without
an API parsing gap.

One-hour access tokens remain unchanged. The web client renews them silently,
rotates the refresh token on every successful renewal, and retries `/v1/me` once
when a stale access token receives `401`. Temporary network and `5xx` failures
during a service restart are retried every two seconds; they do not clear stored
credentials or send the user to the login screen.

A refresh session still ends when:

- the user signs out and the presented refresh token is revoked;
- the account is disabled and all active refresh tokens are revoked;
- account recovery rotates credentials and revokes existing refresh tokens; or
- the account is crypto-erased.

The migration revokes refresh tokens that had already expired. It removes the
deadline only from sessions that were still valid, avoiding resurrection of an
old expired credential.

## Consequences

Users no longer encounter a scheduled sign-in deadline. A copied refresh token
also remains useful for longer, so explicit logout, disable, recovery, and
crypto-erasure revocation paths remain mandatory. Short-lived access tokens,
refresh-token hashing at rest, rotation, tenant scoping, and audit behavior are
unchanged.

The content-key lease remains a separate, time-bounded control. A persistent
identity session does not keep decrypted workspace content resident forever.
