# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to **kivancguckiran@gmail.com**
with the subject prefix `[SECURITY]`. Do not open a public issue. Include the
affected component and version or commit, reproduction steps, impact, and any
suggested remediation.

We aim to acknowledge reports within 7 days and coordinate a fix and disclosure
within 90 days. Active exploitation may shorten that timeline. Please keep
details private until a fix is released. There is currently no paid bug bounty.

## Scope

In scope: source code in this repository, build and release scripts, and
published release artifacts.

Out of scope: third-party provider CLIs and SDKs, configuration mistakes in a
user-operated self-hosted installation, and any separate managed infrastructure.

Security fixes target `main` and the latest release; older releases are not
guaranteed backports. Secret policy is enforced by the public-release preflight,
which scans the working tree and Git history.
