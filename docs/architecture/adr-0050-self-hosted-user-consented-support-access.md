# ADR-0050: Self-hosted user-consented support access

- Status: Accepted
- Date: 2026-08-05
- Scope: self-hosted production support access to conversation content

## Context

The control plane already models session-scoped support grants, MFA approval,
short-lived one-time JIT leases, revocation, and an immutable audit chain. The
self-hosted production server did not expose that model, while the web support
button opened community links. An operator therefore had no narrow,
user-controlled way to inspect a conversation when diagnosing a support case.

Giving the self-hosted administrator ordinary workspace membership would be a
standing access path and would bypass the grant, expiry, and audit controls.
Copying a user's password or content key to the administrator would also break
the existing user-held content-key boundary.

## Decision

The configured `SELF_HOSTED_ADMIN_SUBJECT` is provisioned as a `support` member
of every self-hosted user organization and workspace. The `support` role is not
ordinary workspace access: the production server denies that role all regular
conversation, event, file, and mutation routes. It may use only the support
governance and JIT-content endpoints.

An authenticated user can request access only for the conversation currently
in scope and only for the configured support principal. The initial supported
action is `content.view`. The grant lasts 5–60 minutes and defaults to 10
minutes in the UI. Creating a grant does not activate it.

The support-access repository is shared by the generic control plane, whose
session rows live in `sessions`, and the production/self-hosted control plane,
whose rows live in `ha_sessions`. Session-scoped support records therefore use
a database trigger that requires a matching tenant/organization/workspace/
session row in either canonical backend. A single-backend foreign key is not
used because it would reject valid sessions from the other control plane.

The requester must perform a fresh password verification. The password is a
request-only value: it is verified by the self-hosted authentication service
and is never stored, logged, placed in an event, or included in audit metadata.
Only an opaque verification evidence identifier is retained. A separate
administrator access token with an MFA assurance claim must then approve the
grant. Existing multi-approver and KMS rules remain in force for higher-risk
actions.

After approval, the named support principal may issue a short-lived, one-time
JIT lease bound to tenant, organization, workspace, session, action, grant
generation, and principal. Consuming a `content.view` lease returns only that
session's materialized event stream. Every request, verification, approval,
lease issue, lease consumption, expiry, denial, and revocation remains in the
immutable security audit chain.

Conversation payload decryption still requires the active user content-key
broker lease. Support access does not unwrap, export, escrow, or copy a user's
content key and does not add an offline KMS bypass. If that lease is absent,
content access fails closed even when the support grant is active.

## Consequences

- Users can explicitly grant and revoke time-bounded access to one conversation.
- Administrators have no standing route to browse user conversations.
- A grant is ineffective until both fresh requester verification and MFA-backed
  administrator approval complete.
- Support reads are attributable, one-time, scope-bound, and auditable.
- Support cannot inspect encrypted content while the user's content key is
  locked; the user must remain signed in or unlock the workspace.
- Database-level support session validation accepts both canonical session
  backends while rejecting identifiers outside the requested scope.
- Existing installations need an idempotent bootstrap backfill for the support
  membership and workspace override.

## Verification and rollback

Contract tests cover the profile and password-verification request shape.
Production tests cover create, fresh verification, MFA approval, regular-route
denial for the support role, one-time scoped content consumption, and
revocation. Authentication tests verify that credentials do not enter durable
records. Provisioning tests cover new-user and upgrade backfill behavior. Web
tests cover the session-scoped panel and removal of community-support links.

Rollback removes the production support routes and UI while leaving inert
support-role memberships and immutable audit records in place. Those
memberships grant no ordinary content access.
