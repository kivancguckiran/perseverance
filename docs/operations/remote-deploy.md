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

The wrapper submits the pushed commit and returns after the remote worker has
been started. The worker is detached from the SSH session, so the invoking
terminal does not need to remain open. It fails closed and performs these steps:

1. Resolve the requested ref to a commit already reachable from `origin`.
2. Connect to the configured remote over OpenSSH, or `tailscale ssh` when
   `PERSISTENT_DEPLOY_SSH_BIN=tailscale`.
3. Require the installed env commit to match the last successfully completed
   release state. A mismatch identifies a previously interrupted deploy and
   stops before making another change.
4. Create an independent, clean, detached checkout at
   `<remote-root>/releases/<commit>`. A failed checkout is retained as
   `.failed-*`; an old release is never deleted by this flow.
5. Atomically write the desired commit to
   `<state-home>/state/pending-remote-deploy.env`. A newer submission replaces
   the pending target; it does not start a competing upgrade.
6. Observe durable run and event activity directly from PostgreSQL without
   storing or printing user content.
7. Wait until both conditions are true:
   - no queued or executing turn remains; and
   - the last observed activity is at least 3,600 seconds old.

   If the installation is already idle for an hour, the upgrade starts
   immediately. Otherwise the remote machine continues polling after SSH exits.

8. Run `self-hosted.sh upgrade`. Its mandatory pre-upgrade encrypted backup
   must create a non-empty `backup-*.tar.enc` before service replacement.
9. Build the commit-addressed product image, apply pending PostgreSQL
   migrations, preserve the memory-only content-key broker, and recreate the
   remaining application services through Docker Compose.
10. Require at least nine labeled self-hosted containers and require every one
    to report `healthy`.
11. Read the canonical public origin and base path from remote state and require
    public readiness at `<origin><base-path>/readyz` to return `"ready": true`.
12. Write the successful commit, timestamp, backup filename, and readiness URL
    to `<state-home>/state/last-remote-deploy.env`.

The defaults can be changed only in ignored local configuration:

```bash
PERSISTENT_DEPLOY_IDLE_SECONDS=3600
PERSISTENT_DEPLOY_POLL_SECONDS=60
```

Both values are validated before any SSH action. The idle window accepts
60 seconds through 7 days; polling accepts 5 seconds through 1 hour.

Worker state and diagnostics stay outside release checkouts:

- pending target: `<state-home>/state/pending-remote-deploy.env`
- worker PID/lock: `<state-home>/state/remote-deploy-worker.{pid,lock}`
- worker log: `<state-home>/state/remote-deploy-worker.log`

The wrapper never copies env files or secrets into the release checkout and
never prints their values.

## Public URL or base-path migration

Deploy the release containing the desired lifecycle behavior first. Stage the
external reverse-proxy route for the target URL, while keeping the old path
available, then run from the installed release:

```bash
SELF_HOSTED_HOME=<state-home> bash infra/self-hosted/self-hosted.sh reconfigure \
  --domain workspace.example.com --base-path /perseverance
```

`reconfigure` creates and verifies an encrypted backup before mutation, keeps
the existing root-relative PWA identity, rebuilds for the new base path, updates
the web origin/CORS and Caddy site together, and rolls the runtime configuration
back if public readiness fails. An unrelated hostname change still requires
users to reinstall the PWA because browser origin storage and permissions do not
migrate across sites.

To deliberately retire the old same-origin PWA identity as well, pass a
root-relative target identity explicitly:

```bash
SELF_HOSTED_HOME=<state-home> bash infra/self-hosted/self-hosted.sh reconfigure \
  --domain workspace.example.com --base-path /perseverance \
  --pwa-id /perseverance/
```

Identity rotation is not silent: installed apps using the retired identity can
require reinstallation.

## Failure and rollback

Do not modify a dirty or mismatched release to recover a failed deploy. Keep it
for inspection or fix forward with a new commit. Rollback and restore use the
canonical `self-hosted.sh` commands from the currently deployed release and are
consequential operator actions; the remote wrapper never performs them
automatically.

If a worker is interrupted by a host reboot, the pending state remains intact.
Re-running `pnpm deploy:remote -- <same-or-newer-ref>` safely restarts the worker;
the exact detached release is reused after validation.
