# ADR-0039 — Self-hosted nested command sandbox

- Status: Accepted
- Date: 2026-08-01
- Scope: self-hosted workspace-agent

## Context

Codex `workspace-write` runs Linux commands inside a Bubblewrap user-namespace
sandbox. The self-hosted `workspace-agent` already runs as UID 10001 with no
effective capabilities, but Docker's default seccomp profile denies the namespace
creation syscall. Every command therefore failed before execution with `bwrap: No
permissions to create a new namespace`. Runs could then wait for an escalation
request that the background production worker does not expose to the user.

Running Codex with `danger-full-access` is not acceptable. The supervisor process
has internal service connectivity and runtime credentials, so removing the inner
filesystem sandbox would merge command execution with the trusted adapter boundary.

## Decision

The self-hosted Compose profile relaxes the outer Docker seccomp filter only for
`workspace-agent`. The container remains non-root, drops all Linux capabilities,
and enables `no-new-privileges`. This permits Bubblewrap to create its unprivileged
user namespace and enforce the narrower per-command sandbox.

Production threads explicitly start with:

- `sandbox: workspace-write`, limiting writes to the mounted workspace and Codex
  scratch locations;
- `approvalPolicy: never`, so denied escalation attempts fail instead of leaving a
  detached run waiting for an approval channel the worker does not implement.

`approvalPolicy: never` does not grant additional access. Network access and writes
outside the workspace remain denied by the Codex sandbox.

## Consequences

- Agents can create and edit files under `/workspace`.
- Commands cannot escape the workspace by requesting elevated execution.
- The outer worker loses Docker's syscall filtering as a defense-in-depth layer.
  This is bounded to one non-root, capability-free service; Bubblewrap remains the
  command boundary and all other services retain Docker's default seccomp profile.
- A future runtime split that removes internal credentials and control-plane access
  from the command runner would allow a stronger outer sandbox without changing the
  Codex protocol contract.

## Verification and rollback

Release verification must prove that Bubblewrap can start with all capabilities
dropped and `no-new-privileges`, that a Codex turn can create a file inside the
workspace, and that Compose does not apply `seccomp=unconfined` to another service.

Rollback removes the two explicit thread settings and the `workspace-agent`
security overrides, restoring the previous fail-closed (but non-functional)
behavior.
