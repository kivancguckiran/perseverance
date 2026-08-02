# Remote deployment

This is the portable deployment contract for a self-hosted remote instance. It
supplements the generic lifecycle documentation in
[`infra/self-hosted/README.md`](../../infra/self-hosted/README.md); it does not
replace `self-hosted.sh`.

## Configuration boundary

Tracked deployment configuration contains no real target hostnames, usernames,
SSH aliases, home directories, public origins, or installation paths. Copy the
sanitized template and edit only the ignored destination:

```bash
mkdir -p config/local
cp config/local.example/remote-deploy.sh config/local/remote-deploy.sh
chmod 600 config/local/remote-deploy.sh
```

The local file defines the deployment transport, SSH target, remote root, and
durable state path. It is sourced as trusted Bash configuration and uses default
assignments, so explicit environment values can override it for one invocation.
Set `PERSISTENT_DEPLOY_CONFIG_FILE` to use a different local config file.

`config/local/` is ignored by Git and excluded from Docker build contexts. It
must not contain credentials: private keys remain in the SSH agent/keychain and
application secrets remain in the documented secret store.

## Release procedure

Run from a clean local checkout after the commit has been pushed:

```bash
pnpm deploy:remote                 # local HEAD
pnpm deploy:remote -- <git-ref>   # explicit pushed ref
```

The wrapper fails closed and performs these steps:

1. Resolve the requested ref to a commit already reachable from `origin`.
2. Connect to the configured remote over OpenSSH, or `tailscale ssh` when
   `PERSISTENT_DEPLOY_SSH_BIN=tailscale`.
3. Require the installed env commit to match the last successfully completed
   release state. A mismatch identifies a previously interrupted deploy and
   stops before making another change.
4. Create an independent, clean, detached checkout at
   `<remote-root>/releases/<commit>`. A failed checkout is retained as
   `.failed-*`; an old release is never deleted by this flow.
5. Run `self-hosted.sh upgrade`. Its mandatory pre-upgrade encrypted backup
   must create a non-empty `backup-*.tar.enc` before service replacement.
6. Build the commit-addressed product image, apply pending PostgreSQL
   migrations, and recreate the application services through Docker Compose.
7. Require at least eight labeled self-hosted containers and require every one
   to report `healthy`.
8. Read the canonical public origin and base path from remote state and require
   public readiness at `<origin><base-path>/readyz` to return `"ready": true`.
9. Write the successful commit, timestamp, backup filename, and readiness URL
   to `<state-home>/state/last-remote-deploy.env`.

The wrapper never copies env files or secrets into the release checkout and
never prints their values.

## Failure and rollback

Do not modify a dirty or mismatched release to recover a failed deploy. Keep it
for inspection or fix forward with a new commit. Rollback and restore use the
canonical `self-hosted.sh` commands from the currently deployed release and are
consequential operator actions; the remote wrapper never performs them
automatically.
