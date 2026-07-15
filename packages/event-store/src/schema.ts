import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 9

export const CREATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_folders (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, folder_id)
  );
  CREATE INDEX IF NOT EXISTS conversation_folders_workspace_idx
    ON conversation_folders(tenant_id, workspace_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    folder_id TEXT,
    title TEXT NOT NULL DEFAULT 'Yeni konuşma',
    provider TEXT NOT NULL DEFAULT 'codex',
    requested_policy_json TEXT NOT NULL DEFAULT '{"alias":"sol","reasoningEffort":"medium"}',
    resolved_model TEXT,
    reasoning_effort TEXT,
    capability_snapshot_json TEXT,
    codex_thread_id TEXT,
    status TEXT NOT NULL,
    recovery_error_code TEXT,
    last_resumed_at TEXT,
    runtime_generation INTEGER,
    last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, session_id),
    FOREIGN KEY (tenant_id, workspace_id, folder_id)
      REFERENCES conversation_folders(tenant_id, workspace_id, folder_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_codex_thread_idx
    ON sessions(tenant_id, workspace_id, codex_thread_id)
    WHERE codex_thread_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS sessions_workspace_status_idx
    ON sessions(tenant_id, workspace_id, status);

  CREATE TABLE IF NOT EXISTS turns (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_turn_id TEXT,
    provider TEXT NOT NULL,
    requested_policy_json TEXT NOT NULL,
    resolved_model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    capability_snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (tenant_id, workspace_id, session_id, turn_id),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS turns_session_started_idx
    ON turns(tenant_id, workspace_id, session_id, started_at);

  CREATE TABLE IF NOT EXISTS usage_ledger (
    ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    request_id TEXT,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    entry_kind TEXT NOT NULL,
    report_kind TEXT,
    dedupe_key TEXT NOT NULL,
    reported_json TEXT NOT NULL,
    effective_json TEXT NOT NULL,
    outcome TEXT,
    completeness TEXT NOT NULL,
    reconciliation_status TEXT NOT NULL,
    price_catalog_version TEXT,
    estimated_cost_micros INTEGER,
    official_cost_micros INTEGER,
    source_reference TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, workspace_id, session_id, dedupe_key),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS usage_ledger_session_turn_idx
    ON usage_ledger(tenant_id, workspace_id, session_id, turn_id, ledger_id);

  CREATE TABLE IF NOT EXISTS usage_cursors (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    accounted_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, session_id, turn_id, request_id),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS workspace_sequence (
    workspace_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS raw_events (
    raw_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ingest_key TEXT NOT NULL,
    checksum TEXT NOT NULL,
    inline_json TEXT,
    artifact_pointer TEXT,
    source_method TEXT NOT NULL,
    source_version TEXT NOT NULL,
    source_metadata_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, workspace_id, ingest_key),
    CHECK ((inline_json IS NOT NULL) != (artifact_pointer IS NOT NULL)),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS raw_events_session_created_idx
    ON raw_events(tenant_id, workspace_id, session_id, raw_event_id);
  CREATE INDEX IF NOT EXISTS raw_events_checksum_idx
    ON raw_events(tenant_id, workspace_id, checksum);

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    type TEXT NOT NULL,
    source_method TEXT NOT NULL,
    source_version TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    raw_event_id INTEGER UNIQUE,
    UNIQUE(workspace_id, sequence),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id),
    FOREIGN KEY (raw_event_id) REFERENCES raw_events(raw_event_id)
  );
  CREATE INDEX IF NOT EXISTS events_session_sequence_idx
    ON events(tenant_id, workspace_id, session_id, sequence);

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    response_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, scope, key)
  );
  CREATE INDEX IF NOT EXISTS idempotency_session_status_idx
    ON idempotency_keys(tenant_id, workspace_id, session_id, status);

  CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
    request_id_json TEXT NOT NULL, runtime_instance_id TEXT NOT NULL,
    process_generation INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    context_json TEXT NOT NULL, available_decisions_json TEXT NOT NULL,
    requested_at TEXT NOT NULL, resolved_at TEXT, resolving_user_id TEXT,
    selected_decision TEXT, version INTEGER NOT NULL DEFAULT 1,
    upstream_response_status TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(tenant_id, workspace_id, runtime_instance_id, process_generation, request_id_json),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS approvals_scope_status_idx
    ON approvals(tenant_id, workspace_id, status, requested_at);

  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
    kind TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    sha256 TEXT, chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0), finalized INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'writing',
    metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, finalized_at TEXT,
    FOREIGN KEY (tenant_id, workspace_id, session_id) REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS artifacts_scope_idx ON artifacts(tenant_id, workspace_id, session_id, turn_id, item_id);

  CREATE TABLE IF NOT EXISTS git_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
    turn_id TEXT, phase TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL, captured_at TEXT NOT NULL,
    UNIQUE(tenant_id, workspace_id, session_id, idempotency_key),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS git_snapshots_scope_idx
    ON git_snapshots(tenant_id, workspace_id, session_id, captured_at DESC);

  CREATE TABLE IF NOT EXISTS audit_records (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    correlation_id TEXT,
    request_id TEXT,
    trace_id TEXT,
    idempotency_key TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK(length(metadata_json) <= 2048),
    metadata_bytes INTEGER NOT NULL CHECK(metadata_bytes >= 2 AND metadata_bytes <= 2048),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, workspace_id, idempotency_key),
    FOREIGN KEY (tenant_id, workspace_id, session_id)
      REFERENCES sessions(tenant_id, workspace_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS audit_records_scope_cursor_idx
    ON audit_records(tenant_id, workspace_id, session_id, audit_id DESC);
  CREATE INDEX IF NOT EXISTS audit_records_retention_idx
    ON audit_records(created_at, audit_id);
`

interface TableInfoRow {
  name: string
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table),
  )
}

function hasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  const rows = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as TableInfoRow[]
  return rows.some((row) => row.name === column)
}

export function bootstrapSchema(database: DatabaseSync, now: string): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const hasLegacyEvents =
      tableExists(database, 'events') &&
      !hasColumn(database, 'events', 'tenant_id')

    if (hasLegacyEvents) {
      database.exec(`
        DROP INDEX IF EXISTS events_session_sequence_idx;
        ALTER TABLE events RENAME TO events_legacy_wp2;
      `)
    }

    database.exec(CREATE_SCHEMA_SQL)

    if (!hasColumn(database, 'sessions', 'recovery_error_code'))
      database.exec(`ALTER TABLE sessions ADD COLUMN recovery_error_code TEXT`)
    if (!hasColumn(database, 'sessions', 'last_resumed_at'))
      database.exec(`ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT`)
    if (!hasColumn(database, 'sessions', 'runtime_generation'))
      database.exec(
        `ALTER TABLE sessions ADD COLUMN runtime_generation INTEGER`,
      )
    if (!hasColumn(database, 'sessions', 'folder_id'))
      database.exec(`ALTER TABLE sessions ADD COLUMN folder_id TEXT`)
    if (!hasColumn(database, 'sessions', 'title'))
      database.exec(
        `ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT 'Yeni konuşma'`,
      )
    if (!hasColumn(database, 'sessions', 'provider'))
      database.exec(
        `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'`,
      )
    if (!hasColumn(database, 'sessions', 'requested_policy_json'))
      database.exec(
        `ALTER TABLE sessions ADD COLUMN requested_policy_json TEXT NOT NULL DEFAULT '{"alias":"sol","reasoningEffort":"medium"}'`,
      )
    if (!hasColumn(database, 'sessions', 'resolved_model'))
      database.exec(`ALTER TABLE sessions ADD COLUMN resolved_model TEXT`)
    if (!hasColumn(database, 'sessions', 'reasoning_effort'))
      database.exec(`ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT`)
    if (!hasColumn(database, 'sessions', 'capability_snapshot_json'))
      database.exec(
        `ALTER TABLE sessions ADD COLUMN capability_snapshot_json TEXT`,
      )
    if (
      tableExists(database, 'conversation_folders') &&
      !hasColumn(database, 'conversation_folders', 'archived_at')
    )
      database.exec(
        `ALTER TABLE conversation_folders ADD COLUMN archived_at TEXT`,
      )
    if (
      tableExists(database, 'artifacts') &&
      !hasColumn(database, 'artifacts', 'status')
    )
      database.exec(
        `ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'writing'`,
      )

    if (hasLegacyEvents) {
      database.exec(`
        INSERT OR IGNORE INTO sessions (
          tenant_id, workspace_id, session_id, status, last_sequence,
          created_at, updated_at
        )
        SELECT
          json_extract(payload_json, '$.tenantId'),
          workspace_id,
          session_id,
          'active',
          MAX(sequence),
          MIN(occurred_at),
          MAX(occurred_at)
        FROM events_legacy_wp2
        GROUP BY json_extract(payload_json, '$.tenantId'), workspace_id, session_id;

        INSERT OR IGNORE INTO workspace_sequence (
          workspace_id, tenant_id, last_sequence, updated_at
        )
        SELECT
          workspace_id,
          json_extract(payload_json, '$.tenantId'),
          MAX(sequence),
          MAX(occurred_at)
        FROM events_legacy_wp2
        GROUP BY workspace_id;

        INSERT INTO events (
          event_id, tenant_id, workspace_id, session_id, sequence, type,
          source_method, source_version, payload_json, occurred_at, received_at
        )
        SELECT
          event_id,
          json_extract(payload_json, '$.tenantId'),
          workspace_id,
          session_id,
          sequence,
          type,
          json_extract(payload_json, '$.sourceMethod'),
          json_extract(payload_json, '$.sourceVersion'),
          payload_json,
          occurred_at,
          json_extract(payload_json, '$.receivedAt')
        FROM events_legacy_wp2;

        DROP TABLE events_legacy_wp2;
      `)
      database.exec(CREATE_SCHEMA_SQL)
    }

    database
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, applied_at)
         VALUES (?, ?)`,
      )
      .run(CURRENT_SCHEMA_VERSION, now)
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
