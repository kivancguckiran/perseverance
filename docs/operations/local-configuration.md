# Local configuration boundary

Tracked repository content must be portable across contributors, machines, and
installations. Do not commit operator-specific hostnames, usernames, SSH
aliases, absolute home paths, tenant identifiers, public deployment origins, or
installation directories.

Use these locations consistently:

| Content                                 | Location                                   | Tracked |
| --------------------------------------- | ------------------------------------------ | ------- |
| Sanitized, runnable example             | `config/local.example/`                    | Yes     |
| Non-secret machine/operator coordinates | `config/local/`                            | No      |
| Local environment and credentials       | `.env.local` or documented secret provider | No      |
| Production application secrets          | Documented secret provider/state directory | No      |

Every ignored local config should have a sanitized counterpart with the same
basename under `config/local.example/`. Examples must use obvious placeholders
or neutral paths such as `deploy-host` and `/srv/<project>`.

`config/local/`, `.env`, `.env.*`, runtime state, logs, and local artifacts are
excluded from both Git and the root Docker build context. Adding a new local
configuration location requires updating both `.gitignore` and `.dockerignore`.

Local config is not a secret store. It may select an SSH alias or filesystem
root, but private keys, tokens, passwords, and provider credentials remain in
the SSH agent/keychain, an ignored env file, or the documented secret provider.
Scripts must not print credential values or copy local config into release
checkouts, images, fixtures, snapshots, or artifacts.

Public maintainer contacts, canonical repository URLs, and attributed corpus
authors are intentional repository/provenance data. Do not move or anonymize
them under this policy unless the owning public document or source record is
being intentionally revised.
