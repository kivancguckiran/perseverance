# ADR-0040 — Production conversation home and workspace file viewer

- Status: Accepted
- Date: 2026-08-01
- Scope: production session metadata and self-hosted workspace file reads

## Context

The production control-plane stored only execution identity for a session. Its
public response consequently replaced every folder and title with constants, and
the production composition omitted conversation listing and mutation routes. A
browser could retain a folder locally, but reopening the conversation lost that
association. Relative Markdown links also resolved against the session URL even
though the control-plane must not mount or directly expose the workspace volume.

The workspace-agent already owns the workspace data-plane boundary. Moving the
volume into the control-plane would merge that boundary and give the public API
process unnecessary filesystem access.

## Decision

Production sessions persist tenant-scoped conversation metadata in
`persistent_codex.ha_sessions`: folder, title, requested policy, resolved model,
reasoning effort, and automatic-title completion time. Existing and new sessions
without an explicit folder use the stable `fol_default` home. The production API
implements paginated listing, folder/title mutation, and archive/restore against
the same durable rows.

The `Default` folder is a non-shareable system conversation home. User-created
folders continue to use the shared-folder aggregate and its authorization checks.
The web client may use its minimized local history once to restore folder
associations that predate this migration; the server remains authoritative after
that reconciliation.

Automatic titles run as a separate, read-only Codex invocation using the Luna
title model and `reasoningEffort: none`. The title call receives only a bounded
prefix of the user's first prompt, runs concurrently with the main turn, and
updates the row only while its title is still the untouched default.

Each durable folder maps to a tenant-scoped physical home below the workspace
volume. The mapping uses a hash of tenant, organization, and workspace identity
plus the validated folder ID; folder display names never become filesystem paths.
`fol_default` therefore has the same persistent semantics as a named folder.

The production worker launches the real Codex app-server inside an outer
Bubblewrap namespace. It contains only read-only OS/runtime trees, the Codex
binary, and the single authentication file required by app-server; the container
root, `/workspace`, service secrets, and product source are absent. Only the
selected physical home is rebound read-write at `/scoped-workspace`. The
disposable Codex home is the only other writable bind.
The child receives a minimal environment without database, object-store, or
internal-runtime credentials. Codex retains its inner `workspace-write` sandbox
for commands. This makes a folder an execution boundary rather than merely a
`cwd` hint: sibling homes and the product checkout are not visible to the agent.

Workspace file reads remain in the workspace-agent. It exposes a bounded internal
JSON endpoint on the existing private runtime listener. The control-plane calls it
with the existing internal runtime token and exposes the result only through the
authenticated tenant- and session-scoped API. The session selects the same
physical folder home used for execution. Paths are canonicalized with `realpath`; absolute
paths, `..`, symlink escape, binary files, and files over 2 MiB are rejected.

## Consequences

- Conversations consistently appear under a durable folder after reload and on
  another browser.
- A folderless conversation has full access to its persistent Default home but
  cannot see the product root or another conversation folder.
- Legacy folderless rows remain visible under `Default`.
- Generated titles do not contaminate the main Codex thread or delay its start.
- The control-plane still has no workspace volume mount or direct filesystem
  access.
- The internal file endpoint can read text files and bounded directory listings;
  editing, binary preview, and downloads remain separate future capabilities.

## Verification and rollback

Contract tests cover production session mapping, Default-folder creation/listing,
conversation mutation, title normalization, and traversal/symlink rejection. Web
tests cover workspace link rewriting and nullable production history metadata.

Rollback removes the new routes and worker endpoint, then stops writing the added
columns. The columns and migrated `fol_default` values may remain in place during
rollback because older production code ignores them.
