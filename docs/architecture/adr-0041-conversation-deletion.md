# ADR-0041 — Recoverable conversation deletion

- Status: Accepted
- Date: 2026-08-01
- Scope: conversation lifecycle

## Context

Archiving is reversible and remains visible in the conversation history. Users
also need a delete action that removes a conversation from their workspace view.
Physically deleting a session row would cascade across execution events, usage,
approvals, audit evidence, and object-store content without an established
retention or erasure workflow.

## Decision

Conversation deletion is a tenant-scoped soft delete. The session receives a
`deleted_at` timestamp and is excluded from reads, active lists, archived lists,
metadata mutations, and future turns. Existing execution and audit records remain
intact for operational retention. A conversation with an active run cannot be
deleted; the user must stop or wait for the turn first.

The API exposes `DELETE /v1/sessions/:sessionId` and returns `204` when deletion
succeeds, `404` for missing or already-deleted sessions, and `409` while a run is
active. The web client requires an explicit confirmation and removes the current
conversation from the active view after success.

The local app-server adapter also sends the pinned upstream `thread/delete`
request when a Codex thread exists before hiding its local session record.

## Consequences

- Deleted conversations disappear from both active and archived history.
- Accidental deletion still requires confirmation, while backend retention keeps
  audit and execution evidence available to a future governed erasure workflow.
- This endpoint is not a cryptographic erasure promise.

## Verification and rollback

Repository tests cover tenant scoping, list/read exclusion, repeated deletion,
and active-run rejection. API and web tests cover the route and confirmation
surface. Rollback removes the route and UI action; the nullable column may remain
because older code ignores it.
