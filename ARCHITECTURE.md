# Architecture

Perseverance is a TypeScript monorepo built around an explicit control-plane and
workspace data-plane boundary.

## Runtime model

- The control plane owns tenant-scoped APIs, durable sessions, replay, approvals,
  scheduling, and browser realtime delivery.
- Workspace Agent supervises the real, pinned `codex app-server` process and adapts
  its versioned JSONL protocol. It is not a model agent.
- Raw upstream envelopes are stored before conversion to versioned normalized events.
- Completed items and final snapshots are authoritative and reconcile transient deltas.
- Unknown protocol values are retained as `codex.unknown` rather than rejected.
- One active turn per workspace is the default concurrency boundary.

## Security model

- Every domain record, database operation, cache entry, and object key carries tenant
  scope explicitly.
- The control plane never mounts a tenant workspace filesystem directly.
- Paths are canonicalized; traversal, symlink escape, `/proc`, and `/sys` are denied.
- Network and external writes are default-deny and require scoped approval.
- Approval decisions use idempotency keys, optimistic locking, and durable state.
- Credentials and sensitive environment values do not enter events, logs, traces,
  fixtures, or snapshots.
- Conversation data is encrypted at rest with passphrase-derived user key material;
  workspace files remain outside that encryption boundary.

## Event and output behavior

The web client consumes ordered normalized events, reconnects from a high-water mark,
and handles duplicates and sequence gaps. Large command output remains bounded in
memory and spills to tenant/workspace-scoped redacted artifacts. The user interface
never exposes hidden chain of thought; it may display explicit reasoning summaries
provided by the upstream protocol.

## Package boundaries

```text
apps/web/                    responsive PWA and timeline
services/control-plane/      tenant-scoped API and orchestration
agents/workspace-agent/      app-server supervision and workspace adapter
packages/*                   shared contracts, events, persistence, and security
infra/self-hosted/           supported deployment profile
```

Changes to a security boundary, protocol, or persisted data model require an ADR in
English. Generated protocol sources must be regenerated from the pinned binary and
must never be edited by hand.
