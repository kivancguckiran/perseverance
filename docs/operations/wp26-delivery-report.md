# WP26 delivery and acceptance evidence

- Evidence date: 2026-07-20
- Contract: `production-topology.v1`
- ADR: `adr-0026-ha-production-topology-scheduler-capacity.md`
- Migrations: `0028_ha_scheduler_capacity.sql`, `0029_wp26_production_execution.sql`
- Plan status: unchanged; this report does not advance WP27 or edit roadmap completion state.

## Production execution path

The production entrypoint is fail-closed by default. Only the explicit
`PERSISTENT_CODEX_LOCAL_ALPHA=1` entrypoint can compose SQLite, local filesystem and
in-memory development adapters. Production API/realtime instances keep no queue,
lease, event or runtime ownership state. Turn admission executes the existing durable
billing `admit`/credit reservation, writes the prompt to S3-compatible object storage,
and atomically enqueues the run in PostgreSQL. Scheduler workers bind the billing
decision to the durable run and settle/release it on terminal completion.

The measured topology used two Node API/realtime processes, two independent scheduler
processes, PostgreSQL 17 with pgvector, RabbitMQ 4 management, MinIO, Vault dev KMS
readiness, two runtime-node records and real `codex-cli 0.144.2 app-server` processes.
RabbitMQ and MinIO are real services, not in-process emulators. Vault dev mode is used
only as a live KMS dependency/readiness target; this is not a production key durability
claim.

## Identity and failover evidence

Latest HA evidence used:

- region `eu-1`; initial node `node-1`; recovery node `node-2`
- workspace `workspace-a`
- session `ses_8e0c0a3c-7f18-4c41-afae-268898050f89`
- run `run_da2ab2b0-ca21-4a06-a5f8-b899bf1d0345`
- first fencing token `1`; recovery fencing token `2`

The first API process was killed while the accepted turn and approval were durable.
The remaining API preserved approval context, high-water replay and completed
reconciliation. The owning scheduler was killed before upstream start, its lease
expired, and the other scheduler recovered the same run with token 2. Node 1 was in
`draining`; placement moved to node 2. Exactly one Codex turn was started. A write with
token 1 was rejected by `append_fenced_ha_event` after recovery.

- measured RPO: `0 ms`
- scheduler kill + lease expiry + Codex completion RTO: `14,448 ms`
- PostgreSQL-only lease recovery transaction RTO: `12 ms`
- accepted runs lost during drain: `0`
- browser completed high-water: `3` (HA API harness high-water: `4`)

The RTO includes the configured 3-second lease window and real Codex completion. It is
an acceptance measurement on the local Docker Linux VM, not a multi-region SLO.

## Scheduler fairness, retry and billing

`weighted-fair-v1` remained deterministic: for 1,000 Tenant A and 20 Tenant B items,
Tenant B's maximum selection position was 40. The live gate additionally ran two real
scheduler processes against one PostgreSQL queue and real Codex runtimes. With three
Tenant A turns backlogged, Tenant B completed in `9,685 ms` while Tenant A remained
backlogged. Both worker identities executed work, provider concurrency was bounded at
2 and workspace concurrency at 1.

A durable poison fixture deleted its object before approval release. Workers performed
bounded exponential retry and persisted `poisoned` at attempt 4. Billing admission,
reservation binding, zero-measurement acceptance settlement and admission release used
the existing billing repository; no scheduler-local billing authority was introduced.

## Capacity and noisy-neighbor evidence

`WP26_IO_DEVICE=/dev/vda pnpm wp26:capacity` ran on the Docker Linux cgroup v2 kernel:

- `cpu.max=50000 100000`
- `memory.max=67108864`; a separate 32 MiB container was OOM-killed with exit 137
- `pids.max=32`; a 16-pid fixture reached kernel `EAGAIN`
- `io.max`: 1 MiB/s read/write and 100 read/write IOPS on `/dev/vda`
- tenant disk tmpfs: 8 MiB and 128 inodes; both limits produced `ENOSPC`
- egress: `--network none`; outbound request was rejected

The HA gate also exercised actual fenced admission rejection for event byte/s, output,
artifact and corpus-index limits. Rejections persisted tenant-scoped typed
`capacity_limit_outcomes`; prompt/output content was not included in evidence.

## Dependency loss, migration and fallback

Pausing PostgreSQL, RabbitMQ, MinIO, both runtime-control workers, or Vault produced
readiness failure and HTTP 503 for new admission. After restoration, the committed
session high-water was unchanged. Cache is not a correctness or lock authority in this
topology. Production composition rejects SQLite, cache/memory locks and queue, and
local artifact/attachment/source storage.

All migrations 18 through 29 were applied in the end-to-end topology. Migration 29 is
expand-only. Eighteen WP26 tables have forced RLS. The N-1 reader compatibility probe
passed. Rollback is writer-stop, admission cordon, lease drain, N-1 binary rollback;
WP26 tables and fence counters are never dropped during rollback.

## Commands and latest results

- `pnpm wp26:test`: 65 tests passed.
- `pnpm wp26:postgres`: passed; 18 forced-RLS tables, single claim, stale fence reject,
  RPO 0 ms, recovery 12 ms.
- `WP26_CODEX_BIN=... pnpm wp26:scheduler`: passed; real Codex plus two-worker live
  fairness and four-attempt poison evidence.
- `WP26_CODEX_BIN=... pnpm wp26:ha`: passed with `productionHaEvidence:true`, node drain,
  dependency loss and measured RTO above.
- `WP26_IO_DEVICE=/dev/vda pnpm wp26:capacity`: passed on Linux cgroup v2.
- `WP26_CODEX_BIN=... pnpm wp26:browser`: passed with
  `productionHaEvidence:true` in Chromium.

`wp26:accept` requires both `WP26_CODEX_BIN` and `WP26_IO_DEVICE`; absence fails closed.
The aggregate gate passed with `accepted:true` and `productionHaEvidence:true`. The
final `pnpm verify` passed (36 files, 345 tests, typecheck, build and SSR HTTP smoke).
The commit hash is recorded in the delivery handoff.

## Cleanup and disclosure boundary

Every successful gate removed its named containers, PostgreSQL volume, child processes,
browser namespace and isolated Codex home. No `wp26-*` container remains. Evidence and
diagnostics contain opaque IDs and typed codes only; secrets, prompts, outputs and
tenant content are not logged. External active/passive region failover and a bare-metal
Linux host were not used, so this report makes no active/active, multi-region consistency
or cloud-production SLO claim.
