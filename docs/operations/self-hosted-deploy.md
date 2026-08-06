# Same-host deployment

This is the deployment contract for a self-hosted instance when Codex and the
repository checkout are already on the installation host. It supplements the
generic lifecycle documentation in
[`infra/self-hosted/README.md`](../../infra/self-hosted/README.md); it does not
replace `self-hosted.sh`.

## Configuration boundary

Tracked deployment configuration contains no real home directories, public
origins, or installation paths. Copy the sanitized template on the installation
host and edit only the ignored destination:

```bash
mkdir -p config/local
cp config/local.example/self-hosted-deploy.sh config/local/self-hosted-deploy.sh
chmod 600 config/local/self-hosted-deploy.sh
```

The local file defines the release root, durable self-hosted state path, idle
window, and polling interval. It is sourced as trusted Bash configuration and
uses default assignments, so explicit environment values can override it for
one invocation. Set `PERSISTENT_DEPLOY_CONFIG_FILE` to use a different local
config file.

`config/local/` is ignored by Git and excluded from Docker build contexts. It
must not contain credentials; application secrets remain in the documented
secret store.

## Release procedure

Run on the installation host from a clean checkout after the commit has been
pushed:

```bash
pnpm deploy:self-hosted                 # local HEAD
pnpm deploy:self-hosted -- <git-ref>   # explicit pushed ref
```

The submitter prepares the pushed commit locally and returns after the host
worker has started. The worker is detached from the invoking terminal and
continues waiting if the session closes. No SSH or Tailscale transport is used.
The flow fails closed and performs these steps:

1. Resolve the requested ref to a commit already reachable from `origin`.
2. Require the installed env commit to match the last successfully completed
   release state. A mismatch identifies a previously interrupted deploy and
   stops before making another change.
3. Create an independent, clean, detached checkout at
   `<deploy-root>/releases/<commit>`. A failed checkout is retained as
   `.failed-*`; an old release is never deleted by this flow.
4. Atomically write the desired commit to
   `<state-home>/state/pending-remote-deploy.env`. A newer submission
   replaces the pending target; it does not start a competing upgrade.
5. Observe durable run and event activity directly from PostgreSQL without
   storing or printing user content.
6. Wait until both conditions are true:
   - no queued or executing turn remains; and
   - the last observed activity is at least 3,600 seconds old.

   If the installation is already idle for an hour, the upgrade starts
   immediately. Otherwise the host worker continues polling by itself.

7. Run `self-hosted.sh upgrade`. Its mandatory pre-upgrade encrypted backup
   must create a non-empty `backup-*.tar.enc` before service replacement.
8. Build the commit-addressed product image, apply pending PostgreSQL
   migrations, preserve the memory-only content-key broker, and recreate the
   remaining application services through Docker Compose.
9. Require at least nine labeled self-hosted containers and require every one
   to report `healthy`.
10. Read the canonical public origin and base path from state and require public
    readiness at `<origin><base-path>/readyz` to return `"ready": true`.
11. Write the successful commit, timestamp, backup filename, and readiness URL
    to `<state-home>/state/last-remote-deploy.env`.

The defaults can be changed only in ignored local configuration:

```bash
PERSISTENT_DEPLOY_IDLE_SECONDS=3600
PERSISTENT_DEPLOY_POLL_SECONDS=60
```

Both values are validated before release creation. The idle window accepts 60
seconds through 7 days; polling accepts 5 seconds through 1 hour.

Worker state and diagnostics stay outside release checkouts:

- pending target: `<state-home>/state/pending-remote-deploy.env`
- worker PID/lock: `<state-home>/state/remote-deploy-worker.{pid,lock}`
- worker log: `<state-home>/state/remote-deploy-worker.log`

These established state filenames are intentionally retained so an in-flight
worker from the former SSH-based submitter shares the same queue and lock during
an upgrade; they do not imply a network hop.

The submitter never copies env files or secrets into a release checkout and
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
consequential operator actions; the submitter never performs them automatically.

If a worker is interrupted by a host reboot, the pending state remains intact.
Re-running `pnpm deploy:self-hosted -- <same-or-newer-ref>` safely restarts the
worker; the exact detached release is reused after validation.
