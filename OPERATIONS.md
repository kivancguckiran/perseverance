# Operations

This is the compact operator reference for the supported self-hosted deployment.

## API availability

1. Check the public `/healthz` and `/readyz` endpoints.
2. Run `bash infra/self-hosted/self-hosted.sh status`.
3. Inspect proxy, control-plane, workspace-agent, database, and broker logs without
   copying credentials or user content into an incident record.
4. If a dependency is degraded, stop new work admission while allowing durable work
   to reach a safe terminal state.
5. Restore service, confirm readiness, and verify replay from the last high-water mark.

## Backup and restore

Use the self-hosted CLI `backup` and `restore` commands. Backups are encrypted; keep
the backup key outside the product host. Provider credentials are excluded unless the
operator explicitly requests their inclusion. After restore, verify tenant isolation,
conversation replay, attachment access, and the audit chain before reopening admission.

## Region failover

The open-source self-hosted profile does not provide automatic multi-region failover.
When operating a custom redundant topology, fence the previous writer before promoting
another instance, preserve tenant placement policy, and validate monotonic scheduler
leases and event sequences before accepting work.

## Incident handling

Treat logs and evidence as sensitive. Redact tokens, credentials, prompts, model output,
attachments, and environment values. Record timestamps, affected versions, tenant-safe
opaque identifiers, actions, and recovery validation. Report product vulnerabilities
through [SECURITY.md](SECURITY.md).
