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
available. The control-plane stores every non-empty file unchanged with the
existing tenant, workspace, session, name, canonical-path, and symlink checks.

PNG, JPEG, WebP, and GIF retain the upstream `localImage` input. Every other
attachment, including ZIP files and unrecognized image formats, is sent to the
pinned Codex app-server as a `mention` with its original filename and canonical
local path. Codex may inspect or extract an archive through its normal tools and
sandbox; the control-plane does not extract it automatically.

## Consequences

- The composer accepts any local file that the browser can upload.
- ZIP and other archives reach Codex without a product-specific allowlist.
- Existing supported images keep their native image-input behavior.
- Archive extraction remains visible in the Codex turn and subject to the
  workspace sandbox and approval policy.
- Upload storage requirements remain unchanged because files are not expanded.

## Verification and rollback

Contract, attachment-storage, API, and web tests cover generic media types,
octet-stream fallback, ZIP upload, canonical path mentions, and the existing
path/symlink protections. Rollback restores the media-type enum and browser
picker allowlist; stored generic attachment metadata must then be retained or
migrated before older code reads it.
