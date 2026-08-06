# Self-hosted deployment

Install Perseverance on a Linux server with:

```bash
bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --acme-email admin@example.com \
  --provider-auth=defer
bash infra/self-hosted/self-hosted.sh codex-login
bash infra/self-hosted/self-hosted.sh workspace-import /path/to/repository
bash infra/self-hosted/self-hosted.sh set-allowed-users "your-user"
```

The runtime image includes `bash`, Git, ripgrep, and an OpenSSH client for agent
work. Imported repositories live in the persistent `workspace-data` volume owned
by runtime UID 10001; the original host repository is not modified.

To install without a checkout from a signed release bundle:

```bash
tar -xf self-hosted-dist.tar
SELF_HOSTED_RELEASE_BUNDLE=/path/to/release-bundle \
  bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --acme-email admin@example.com \
  --provider-auth=defer
```

The installer verifies and loads the product image matching the host architecture.

## User and lifecycle commands

- `set-allowed-users "name1,name2"` sets the registration allowlist.
- `list-users`, `disable-user`, and `reset-user --crypto-erase` manage accounts.
- `status`, `upgrade`, `rollback`, `backup`, `restore`, and `uninstall` manage the
  installation lifecycle.
- Routine `upgrade`, `rollback`, and same-host `reconfigure` operations preserve
  the memory-only content-key broker, so active users are not asked for their
  password merely because application containers were replaced. Host/broker
  restart, a release that changes the broker bundle, restore, lease expiry, and
  revocation still lock decrypted content.
- `reconfigure --domain <host> --base-path <path>` changes the canonical public
  URL as one backed-up operation. It preserves the installed PWA identity,
  rebuilds the base-path-specific image, recreates the stack, and rolls back the
  runtime configuration if public readiness fails. Reverse-proxy routing for the
  target URL must be staged before running it.
- `reconfigure ... --pwa-id /new-path/` intentionally rotates the installed app
  identity. Use it only when the old PWA identity should be retired; browsers
  can require users of that identity to reinstall the app.

Users register at `https://<domain>/login`. Conversation content is encrypted at
rest with a passphrase-derived key. Losing both the password and one-time recovery
code makes the encrypted content unrecoverable by design.
