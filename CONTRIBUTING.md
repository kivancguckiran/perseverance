# Contributing

Contributions to Perseverance are welcome.

## Requirements

- Node.js 24
- pnpm 9.15.3 through Corepack
- Git
- Optional: Codex CLI 0.144.2 and Docker for real-provider smoke tests

## Build and test from a clean checkout

```bash
git clone <repository-url>
cd perseverance
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` is the main local gate: formatting, type checks, tests, build, and
the SSR smoke test. Keep changes focused and include tests for behavior changes.
All project documentation, code identifiers, and commit messages must be in
English. Record changes to security boundaries, protocols, or data models in an
ADR before implementation.

## Developer Certificate of Origin

Contributions are accepted under the
[Developer Certificate of Origin 1.1](https://developercertificate.org).
Sign every commit with `git commit -s`:

```text
Signed-off-by: Your Name <you@example.com>
```

## Secrets and security

- Never place real credentials, tokens, or customer data in files, tests,
  fixtures, logs, or commit messages.
- Clearly label test-only credential-shaped values, for example
  `sk-fixture-not-a-real-key`.
- Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue.

See [SUPPORT.md](SUPPORT.md) for supported channels and scope.
