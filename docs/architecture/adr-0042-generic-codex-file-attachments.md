# ADR-0042 — Generic Codex file attachments

- Status: Accepted
- Date: 2026-08-01
- Scope: conversation attachment contract and Codex turn input

## Context

Conversation attachments used a fixed media-type allowlist for images, text,
JSON, and PDF files. Codex app-server's `mention` turn input is path-based and
does not impose that document allowlist, so the product rejected archives,
office documents, source files, and other ordinary files before Codex could use
its normal workspace tools to inspect them.

Automatically extracting archives in the public control-plane would create a
second file-processing boundary with zip-slip, symlink, path traversal, and
decompression-bomb risks. It would also make attachment upload mutate workspace
contents before a Codex turn and its normal approval policy.

## Decision

The attachment contract accepts any syntactically valid media type. Browsers
preserve a declared media type and use `application/octet-stream` when none is
available. The local control-plane stores every non-empty file unchanged with
the existing tenant, workspace, session, name, canonical-path, and symlink
checks.

The production control-plane encrypts attachment bytes and metadata with the
user content key and writes them to tenant/organization/workspace/session-scoped
object keys. A turn stores an encrypted versioned input envelope containing the
prompt and selected attachment manifests. The workspace worker authenticates
and decrypts that envelope, validates every manifest against the claimed run
scope, and materializes the bytes below the selected physical conversation
workspace before starting Codex. The materialized path is stable and visible
inside the same Bubblewrap mount as the conversation workspace.

PNG, JPEG, WebP, and GIF retain the upstream `localImage` input. Every other
attachment, including ZIP files and unrecognized image formats, is sent to the
pinned Codex app-server as a `mention` with its original filename and canonical
local path. Codex may inspect or extract an archive through its normal tools and
sandbox; the control-plane does not extract it automatically.

For archive attachments, the turn context also defines an explicit safe-update
contract. When the user's request is to install, apply, update, merge, import,
or extract the archive into the current workspace, a non-empty destination and
path collisions do not stop the turn. Codex validates archive paths, rejects
path and link escapes, compares collisions, backs up differing destination
files below the private `.perseverance/archive-backups/` area, overwrites only
package-owned collisions, preserves unrelated destination-only files, and then
runs the package's validation commands. Replacing `.git` or deleting unrelated
files still requires an explicit full-replacement request and the normal
approval policy.

## Consequences

- The composer accepts any local file that the browser can upload.
- ZIP and other archives reach Codex without a product-specific allowlist.
- Existing supported images keep their native image-input behavior.
- Production attachments remain encrypted at rest and cross the
  control-plane/workspace boundary through object storage rather than a shared
  host mount.
- Archive extraction remains visible in the Codex turn and subject to the
  workspace sandbox and approval policy.
- Explicit archive installation requests can update a populated conversation
  workspace without treating ordinary package collisions as a blocker.
- Upload storage requirements remain unchanged because files are not expanded.

## Verification and rollback

Contract, attachment-storage, API, and web tests cover generic media types,
octet-stream fallback, ZIP upload, canonical path mentions, and the existing
path/symlink protections. Rollback restores the media-type enum and browser
picker allowlist; stored generic attachment metadata must then be retained or
migrated before older code reads it.
