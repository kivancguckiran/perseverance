# ADR-0044: Self-hosted-only public product surface

Status: Accepted
Date: 2026-08-02

## Context

Perseverance currently supports only self-hosted deployment, but the repository
still exposes historical managed-cloud and enterprise routes, packages, acceptance
harnesses, and work-package labels. Those surfaces are not operated, supported, or
required by the self-hosted release. They increase the shipped code and contributor
surface and make the public product boundary ambiguous.

The repository also contains a private workspace corpus with user-provided prose.
That corpus is not a runtime fixture or part of the self-hosted product.

Existing installations have already applied numbered PostgreSQL migrations. Their
filenames are durable migration identities and cannot be renamed or removed without
making upgrades replay old schema changes.

## Decision

- The public product and documentation describe self-hosted deployment only.
- Remove managed-cloud and enterprise HTTP/UI surfaces and their dedicated packages.
- Remove the repository-internal workspace corpus and its user-provided sources.
- Remove obsolete phase/work-package acceptance harnesses and infrastructure.
- Rename maintained public-release and self-hosted validation code by capability,
  without work-package identifiers.
- Preserve numbered PostgreSQL migration filenames and behavior as an explicit
  compatibility exception, even when a historical filename contains a work-package
  identifier.
- Retain generic multi-tenant isolation, billing/usage accounting, production
  topology, observability, and release validation components that the self-hosted
  runtime still imports.
- Keep local development as an implementation mode, not as a supported deployment
  product.

## Consequences

The web bundle and production control plane no longer expose unsupported cloud or
enterprise entry points. Public documentation and CI have one supported product
boundary. Installed databases remain upgrade-compatible. Reintroducing a hosted or
enterprise product requires a new ADR and a fresh, explicitly supported composition.
