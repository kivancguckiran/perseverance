# Perseverance Agent Guide

This repository is a persistent, multi-tenant Codex workspace product built on
`codex app-server`. Communicate with users in their chosen language; keep code,
protocol fields, and technical terms in natural English.

## Sources of truth

1. Product entry point: `README.md`.
2. Architecture and security boundaries: `ARCHITECTURE.md`.
3. Accepted behavior: shared contracts, schemas, and their tests.
4. A closer `AGENTS.md` takes precedence within its directory.

If code and specification disagree, do not invent a new architecture silently.
Make a narrow, reversible change. Add or update an ADR before changing a security
boundary, protocol, or data model.

## Architecture boundaries

- Do not reimplement Codex orchestration; use the real, pinned `codex app-server`.
- The MVP Workspace Agent communicates with app-server over `stdio`/JSONL.
- Workspace Agent is an adapter and supervisor, not a model agent.
- Preserve upstream messages as raw envelopes before normalization.
- Unknown items, enums, and events must survive as `codex.unknown` without a crash.
- Treat UI deltas as provisional and reconcile them with completed items/snapshots.
- Keep control plane and workspace data plane separate process/security boundaries.
- Preserve the default assumption of one active turn per workspace.

## Security invariants

- Tenant scope is explicit on every domain record and storage key.
- Never write secrets, API keys, bearer tokens, or sensitive environment values to
  events, logs, traces, fixtures, or snapshots.
- Canonicalize file paths and reject `..`, symlink escape, `/proc`, and `/sys`.
- Never expose app-server directly to the internet.
- Network and external-write actions are default-deny and require scoped approval.
- Approval resolution is idempotent and protected by optimistic locking.
- Never request, store, or expose hidden chain of thought. Only use explicit protocol
  reasoning summaries.

## Implementation and verification

- Generate Codex protocol types from the pinned binary; never hand-edit generated files.
- A normalized event requires type/schema, adapter mapping, unknown fallback, and a
  contract fixture/test together.
- Keep command output bounded and preserve backpressure/artifact spill behavior.
- Domain/adapter work: unit test, golden replay, and type check.
- App-server bridge: handshake/contract test against the real pinned binary.
- Approval: state-machine, concurrent-decision, and crash/recovery tests.
- Realtime: reconnect, sequence gap, duplicate-event, and reconciliation tests.
- Files/Git: traversal, symlink escape, and dirty-state fixtures.
- UI: responsive timeline, reconnect, locale behavior, and mobile approval context.

Do not claim a network-, account-, secret-, or container-dependent check passed when
it could not run. State skipped verification explicitly.

## Git and scope discipline

- Do not commit, push, rebase, or run destructive Git operations unless requested.
- Preserve existing user changes.
- Do not scaffold unrelated billing, mobile, corpus, or production infrastructure.
- Keep unresolved product decisions visible; use an ADR draft instead of deciding
  them arbitrarily.

## Local configuration hygiene

- Keep tracked configuration portable and anonymous. Machine-, operator-,
  tenant-, and installation-specific values belong under the ignored
  `config/local/` directory; track sanitized counterparts under
  `config/local.example/`. Follow `docs/operations/local-configuration.md`.
- Local configuration is not a secret store. Credentials and tokens still
  belong in ignored env files or the documented secret provider, and must not
  enter logs, images, fixtures, or snapshots.
- Public maintainer metadata and attributed corpus provenance are source data,
  not local runtime configuration; preserve them unless their owning document
  is intentionally changed.

## Remote deployment

- Use `pnpm deploy:remote -- <pushed-ref>` and follow
  `docs/operations/remote-deploy.md`.
- The deployment target is reached over the operator-configured SSH transport.
  The wrapper owns clean detached release creation, mandatory backup
  verification, the canonical `self-hosted.sh upgrade`, container health
  checks, and public `<base-path>/readyz` validation.
- Do not deploy from a mutable or dirty remote checkout, bypass the encrypted
  backup, copy secrets into a release, or replace the canonical self-hosted
  lifecycle with ad hoc `docker compose` commands.
