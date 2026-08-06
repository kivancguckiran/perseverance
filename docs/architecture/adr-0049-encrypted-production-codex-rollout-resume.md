# ADR-0049: Encrypted production Codex rollout resume

- Status: Accepted
- Date: 2026-08-05
- Scope: production conversation context and Codex rollout custody

## Context

The production scheduler created a disposable Codex home and a new app-server
thread for every turn. The session row retained the latest Codex thread ID, but
the next run neither retained the corresponding rollout nor resumed that
thread. Only the current prompt reached Codex, so a conversation displayed a
durable multi-turn timeline while the model experienced every message as a new
conversation.

Persisting the Codex home directly in the unencrypted `codex-home` volume would
restore native thread continuation but would leave prompts, model output, and
tool context in plaintext rollout files. That conflicts with the existing
user-content encryption boundary. Reconstructing a transcript inside a new
prompt would also lose native Codex turn semantics and make prior model output
indistinguishable from new user instructions.

## Decision

Continue using a fresh, server-owned temporary Codex home for each production
run. Before starting a subsequent turn, Workspace Agent loads the
tenant/organization/workspace/session-scoped rollout snapshot from object
storage, authenticates and decrypts it with the active user content key, and
restores only regular Codex state files below that temporary home. Provisioned
`auth.json` and `config.toml` are never included in the snapshot. Absolute
paths, traversal, duplicates, symlinks, special files, excessive file counts,
and oversized snapshots fail closed.

When a valid snapshot and bound Codex thread ID exist, Workspace Agent calls
`thread/read` with turns included, verifies thread identity, calls
`thread/resume` with the production workspace/sandbox policy, and starts the
new turn on that same thread. A new `thread/start` is used only for a session
without restorable rollout state. This provides a one-time compatibility path
for conversations created before this decision: their stale thread binding is
replaced on the first post-upgrade turn, and all later turns resume normally.
Corrupt or identity-mismatched snapshots are not silently replaced.

After Codex reports a completed or interrupted turn, Workspace Agent stops the
app-server so rollout writes are closed, captures the temporary home, encrypts
the snapshot with the user content key using a distinct `codex_rollout`
encryption context, and atomically replaces the scoped object before making the
run terminal. The plaintext temporary home is then removed. Missing or expired
content-key access fails closed; rollout plaintext never becomes durable
storage, logs, events, fixtures, or traces.

## Consequences

- Production conversations preserve native Codex context across turns and
  Workspace Agent process replacement.
- Conversation rollout state remains protected by the same password-bound
  content-key custody as prompts and model output.
- Existing conversations cannot recover rollout files that the former worker
  already deleted; they reset once after upgrade and then become resumable.
- Snapshot serialization adds bounded object-storage and memory overhead at
  turn boundaries. A snapshot persistence failure leaves the run non-terminal
  rather than claiming context was durably preserved.
- Soft-deleted sessions retain their encrypted rollout under the existing
  operational retention policy, alongside their encrypted prompts and output.

## Verification and rollback

Tests cover first-thread creation, same-ID read/resume, encrypted snapshot
round-trip, credential exclusion, missing legacy snapshots, and symlink
rejection. Production verification must include two turns in one session and a
Workspace Agent restart between turns. Rollback can ignore retained rollout
objects; the older worker cannot decrypt or consume them and resumes its former
stateless behavior.
