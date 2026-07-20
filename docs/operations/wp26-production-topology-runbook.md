# WP26 production topology, failover and rollback runbook

## Deployment order

1. Verify PostgreSQL backup/PITR and replica lag under the separate WP27 operations
   policy; this runbook does not claim WP27 coverage.
2. Apply `0028_ha_scheduler_capacity.sql`, then
   `0029_wp26_production_execution.sql` as expand-only migrations.
3. Start N-1 readers and run schema/read compatibility while all N writers remain off.
4. Seed/verify commercial plan, quota, prepaid credit and tenant scheduling policies.
   Missing billing policy is an admission failure, never a free-tier fallback.
5. Start at least two production API/realtime instances with the production entrypoint.
   Do not set `PERSISTENT_CODEX_LOCAL_ALPHA=1`.
6. Require PostgreSQL, RabbitMQ-compatible broker, S3-compatible object storage,
   runtime-control and KMS probes to be ready before routing admission traffic.
7. Start one scheduler, verify lease renewal plus capacity-reservation renewal, then
   start the second scheduler against the same PostgreSQL queue.
8. Register at least two ready runtime nodes. A node is not ready until cgroup v2 CPU,
   memory, pids, io byte/IOPS, disk/inode and default-deny egress policies are applied.

## Required production environment

Production API requires `TOPOLOGY_DATABASE_URL`, `PERSISTENT_INSTANCE_ID`,
`PERSISTENT_REGION_ID`, object-storage credentials, RabbitMQ management credentials,
`RUNTIME_CONTROL_READINESS_URL` and `KMS_READINESS_URL`. Scheduler additionally
requires a unique `SCHEDULER_OWNER_ID`, a pinned `WP26_CODEX_BIN` 0.144.2 and a
region-pinned workspace root.

SQLite, local artifact/attachment/source paths, in-memory queue/lock and cache lock are
configuration errors. Cache loss may reduce performance only; it cannot validate a
lease or fence.

## Instance and scheduler failure

- API/realtime: remove the failed instance from routing. Clients reconnect to another
  instance and request PostgreSQL replay after their last sequence. Never synthesize a
  high-water value in process memory.
- Scheduler before upstream intent: wait for lease expiry. Recovery sets
  `recovery_required`, releases capacity, claims with a higher fence and may start Codex.
- Scheduler after upstream intent: do not issue another `turn/start`. Persist
  `outcome_unknown` for operator reconciliation; the start-intent fence trades
  availability for duplicate-start safety.
- A stale owner cannot append an event, complete a run, settle billing or mutate output:
  every durable write verifies the current workspace/run fence.

## Drain procedure

1. Insert/update `drain_states`, set node or region to `cordoned`/`draining`, and stop
   new placements on that target.
2. Keep committed queue, approvals, event high-water and object keys intact.
3. Allow active work to checkpoint if supported. If the owner is lost before upstream
   intent, expire its lease and reschedule to a ready node with a higher token.
4. Record `recovery_outcomes`, measured RPO/RTO and previous/next placements. Mark the
   drain `drained` only after active reservations are released or recovered.

## Dependency-loss response

For PostgreSQL, broker, object storage, runtime-control or KMS loss, return readiness
503 and reject new admission with 503. Existing committed rows and objects remain
read-only until dependencies recover. Do not switch to SQLite, local disk, memory queue
or cache locks. On recovery, verify session high-water, outstanding billing reservations,
leases and outbox rows before reopening admission.

## Capacity incident response

OOM, PID exhaustion, disk/inode full, io throttling and egress saturation are tenant
cgroup/volume/network outcomes. Persist the typed tenant-scoped capacity outcome and
audit metadata. Never raise another tenant's limits or place work on a drained node to
hide the incident. `wp26:capacity` requires `WP26_IO_DEVICE`; unsupported kernels or
devices fail the gate.

## Compatibility and rollback

N and N-1 readers coexist for one rollout window. Stop admission, cordon placement and
drain active leases before stopping N writers. Start the N-1 binary and verify its read
probe. Do not drop/truncate WP26 tables, event outbox, billing reservations or fence
counters. If N-1 cannot read safely, keep admission closed and roll forward.

## Acceptance commands

```sh
pnpm wp26:test
pnpm wp26:postgres
WP26_CODEX_BIN=/absolute/path/to/codex pnpm wp26:scheduler
WP26_CODEX_BIN=/absolute/path/to/codex pnpm wp26:ha
WP26_IO_DEVICE=/dev/vda pnpm wp26:capacity
WP26_CODEX_BIN=/absolute/path/to/codex pnpm wp26:browser
WP26_CODEX_BIN=/absolute/path/to/codex WP26_IO_DEVICE=/dev/vda pnpm wp26:accept
pnpm verify
```

After each run, verify `docker ps -a --format '{{.Names}}'` and
`docker volume ls --format '{{.Name}}'` contain no `wp26-` resource. Never copy prompt,
output, secret or tenant payload into logs or fixtures.
