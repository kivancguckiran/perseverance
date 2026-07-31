# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-07-30

The first public, supported self-hosted Perseverance release.

### Product

- Durable threads and turns, replay, reconnect, approvals, steer/interrupt, and
  bounded artifact flows on the real, pinned `codex app-server`.
- Provider-neutral conversations for Codex, Claude, Gemini, and Cursor, with a usage
  ledger, PWA, mobile approvals and push, and multi-device continuity.
- Tenant/RLS isolation, envelope encryption, audit and metrics, corpus ingestion,
  hybrid retrieval, and workspace-local MCP.
- Allowlisted registration and sign-in with passphrase-derived at-rest conversation
  privacy and a one-time recovery code.

### Self-hosted distribution

- Digest-pinned Docker Compose topology, TLS reverse proxy, migrations, admin
  bootstrap, encrypted backup/restore, upgrade/rollback, and export-aware uninstall.
- Linux AMD64 and ARM64 release artifacts with checksums, cosign signatures,
  CycloneDX SBOM, and SLSA/in-toto provenance.
- Configurable reverse-proxy base path across the PWA, service worker, API, realtime,
  and offline replay.

### Security and governance

- AGPL-3.0-only license, DCO contribution model, private vulnerability reporting,
  deterministic public preflight, and full Git-history secret scanning.
- The supported boundary is the self-hosted community distribution. Historical cloud
  contracts remain in code, but no hosted service is operated or supported.

[1.0.0]: https://github.com/kivancguckiran/perseverance/releases/tag/v1.0.0
