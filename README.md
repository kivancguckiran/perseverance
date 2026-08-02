# Perseverance

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Perseverance is a persistent, mobile-first, self-hosted agent workspace built
around Codex. It is an independent community project and
is not affiliated with or endorsed by any model provider. See [NOTICE](NOTICE).

The only supported deployment model is self-hosted. Perseverance does not
operate a hosted cloud service.

## Why it exists

Coding agents are still largely tied to desktop applications. Perseverance
provides a durable workspace where an agent can keep working after the client
disconnects, preserve context, surface approvals, and replay the same timeline
when the user returns from another device.

The product runs the real, pinned `codex app-server` inside each isolated
workspace. It preserves upstream messages as raw envelopes, normalizes them
into stable versioned events, and reconciles streaming deltas with completed
items and snapshots. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Core guarantees

- Tenant scope is explicit on domain records and storage keys.
- The control plane and workspace data plane remain separate process and
  security boundaries.
- Approval decisions are durable, idempotent, and protected by optimistic
  locking.
- Unknown protocol items are preserved as `codex.unknown`; they do not crash
  decoding.
- Secrets and sensitive environment values are never written to events,
  timelines, logs, fixtures, or snapshots.
- Large command output is bounded and spills to scoped, redacted artifacts.
- Conversation content is encrypted at rest with a user-passphrase-derived key
  that is never written to disk.

## Self-hosted installation

Requirements: Linux (`x86_64` or `aarch64`), Docker, OpenSSL, curl, and at least
20 GiB of free space.

```bash
git clone https://github.com/kivancguckiran/perseverance.git
cd perseverance
bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --acme-email admin@example.com \
  --provider-auth=defer
bash infra/self-hosted/self-hosted.sh codex-login
bash infra/self-hosted/self-hosted.sh workspace-import /path/to/repository
bash infra/self-hosted/self-hosted.sh set-allowed-users "your-user"
```

`workspace-import` copies the repository into the persistent, agent-writable
workspace volume. It never modifies the host repository directly. See the
[self-hosted guide](infra/self-hosted/README.md) for lifecycle commands.

The portable SSH release flow is documented in the
[remote deployment runbook](docs/operations/remote-deploy.md). Machine-specific
coordinates are loaded from the ignored `config/local/` directory; sanitized
templates live in `config/local.example/`. The repository-wide boundary is
described in the
[local configuration policy](docs/operations/local-configuration.md).

## Local development

Requirements: Node.js 24, pnpm 9.15.3 through Corepack, and Codex CLI 0.144.2.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm alpha:dev
```

`pnpm alpha:dev` starts the web client and control plane and stores persistent
runtime state under `.runtime/alpha`. The default endpoints are:

- Web: `http://localhost:3000`
- Control plane: `http://127.0.0.1:3100`
- Liveness: `http://127.0.0.1:3100/healthz`
- Readiness: `http://127.0.0.1:3100/readyz`

Optional real-provider smoke tests are never part of `pnpm verify` and run only
when explicitly requested:

```bash
pnpm demo:smoke
pnpm demo:golden:read-only
pnpm demo:golden:change
pnpm demo:golden:approval
```

## Repository map

```text
apps/       web client
services/   control-plane services
agents/     workspace-agent process boundary
packages/   protocol, domain, persistence, and security packages
infra/      self-hosted runtime, images, and policy
tests/      contract, replay, and isolation fixtures
docs/       machine-readable security and acceptance schemas
```

## License, security, and support

Perseverance is licensed under [GNU AGPL-3.0-only](LICENSE). Self-hosted release
artifacts bundle the pinned OpenAI Codex CLI/runtime under Apache-2.0; its
license and attribution are included under `third_party/openai-codex/` and in
the release installation bundle. Other provider CLIs are not bundled.

- Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
- Community support scope is defined in [SUPPORT.md](SUPPORT.md).
- Operational incident guidance is in [OPERATIONS.md](OPERATIONS.md).
- Contribution requirements are in [CONTRIBUTING.md](CONTRIBUTING.md) and
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
