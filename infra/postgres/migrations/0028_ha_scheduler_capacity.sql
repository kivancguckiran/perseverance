BEGIN;

DO $$ BEGIN
  CREATE ROLE persistent_topology_scheduler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION persistent_codex.capacity_value(value jsonb, key text)
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE((value ->> key)::bigint, 0)
$$;

CREATE OR REPLACE FUNCTION persistent_codex.capacity_fits(available jsonb, requested jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT bool_and(persistent_codex.capacity_value(available,key) >=
                  persistent_codex.capacity_value(requested,key))
  FROM unnest(ARRAY[
    'cpuMillis','memoryBytes','pids','ioBytesPerSecond','diskBytes','diskInodes',
    'diskIops','egressBytesPerSecond','egressRequestsPerMinute',
    'eventBytesPerSecond','artifactBytes','outputBytes','corpusIndexBytes'
  ]) key
$$;

CREATE OR REPLACE FUNCTION persistent_codex.capacity_add(left_value jsonb, right_value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object(
    'schemaVersion',1,
    'cpuMillis',persistent_codex.capacity_value(left_value,'cpuMillis')+persistent_codex.capacity_value(right_value,'cpuMillis'),
    'memoryBytes',persistent_codex.capacity_value(left_value,'memoryBytes')+persistent_codex.capacity_value(right_value,'memoryBytes'),
    'pids',persistent_codex.capacity_value(left_value,'pids')+persistent_codex.capacity_value(right_value,'pids'),
    'ioBytesPerSecond',persistent_codex.capacity_value(left_value,'ioBytesPerSecond')+persistent_codex.capacity_value(right_value,'ioBytesPerSecond'),
    'diskBytes',persistent_codex.capacity_value(left_value,'diskBytes')+persistent_codex.capacity_value(right_value,'diskBytes'),
    'diskInodes',persistent_codex.capacity_value(left_value,'diskInodes')+persistent_codex.capacity_value(right_value,'diskInodes'),
    'diskIops',persistent_codex.capacity_value(left_value,'diskIops')+persistent_codex.capacity_value(right_value,'diskIops'),
    'egressBytesPerSecond',persistent_codex.capacity_value(left_value,'egressBytesPerSecond')+persistent_codex.capacity_value(right_value,'egressBytesPerSecond'),
    'egressRequestsPerMinute',persistent_codex.capacity_value(left_value,'egressRequestsPerMinute')+persistent_codex.capacity_value(right_value,'egressRequestsPerMinute'),
    'eventBytesPerSecond',persistent_codex.capacity_value(left_value,'eventBytesPerSecond')+persistent_codex.capacity_value(right_value,'eventBytesPerSecond'),
    'artifactBytes',persistent_codex.capacity_value(left_value,'artifactBytes')+persistent_codex.capacity_value(right_value,'artifactBytes'),
    'outputBytes',persistent_codex.capacity_value(left_value,'outputBytes')+persistent_codex.capacity_value(right_value,'outputBytes'),
    'corpusIndexBytes',persistent_codex.capacity_value(left_value,'corpusIndexBytes')+persistent_codex.capacity_value(right_value,'corpusIndexBytes'))
$$;

CREATE OR REPLACE FUNCTION persistent_codex.capacity_subtract(left_value jsonb, right_value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object(
    'schemaVersion',1,
    'cpuMillis',GREATEST(0,persistent_codex.capacity_value(left_value,'cpuMillis')-persistent_codex.capacity_value(right_value,'cpuMillis')),
    'memoryBytes',GREATEST(0,persistent_codex.capacity_value(left_value,'memoryBytes')-persistent_codex.capacity_value(right_value,'memoryBytes')),
    'pids',GREATEST(0,persistent_codex.capacity_value(left_value,'pids')-persistent_codex.capacity_value(right_value,'pids')),
    'ioBytesPerSecond',GREATEST(0,persistent_codex.capacity_value(left_value,'ioBytesPerSecond')-persistent_codex.capacity_value(right_value,'ioBytesPerSecond')),
    'diskBytes',GREATEST(0,persistent_codex.capacity_value(left_value,'diskBytes')-persistent_codex.capacity_value(right_value,'diskBytes')),
    'diskInodes',GREATEST(0,persistent_codex.capacity_value(left_value,'diskInodes')-persistent_codex.capacity_value(right_value,'diskInodes')),
    'diskIops',GREATEST(0,persistent_codex.capacity_value(left_value,'diskIops')-persistent_codex.capacity_value(right_value,'diskIops')),
    'egressBytesPerSecond',GREATEST(0,persistent_codex.capacity_value(left_value,'egressBytesPerSecond')-persistent_codex.capacity_value(right_value,'egressBytesPerSecond')),
    'egressRequestsPerMinute',GREATEST(0,persistent_codex.capacity_value(left_value,'egressRequestsPerMinute')-persistent_codex.capacity_value(right_value,'egressRequestsPerMinute')),
    'eventBytesPerSecond',GREATEST(0,persistent_codex.capacity_value(left_value,'eventBytesPerSecond')-persistent_codex.capacity_value(right_value,'eventBytesPerSecond')),
    'artifactBytes',GREATEST(0,persistent_codex.capacity_value(left_value,'artifactBytes')-persistent_codex.capacity_value(right_value,'artifactBytes')),
    'outputBytes',GREATEST(0,persistent_codex.capacity_value(left_value,'outputBytes')-persistent_codex.capacity_value(right_value,'outputBytes')),
    'corpusIndexBytes',GREATEST(0,persistent_codex.capacity_value(left_value,'corpusIndexBytes')-persistent_codex.capacity_value(right_value,'corpusIndexBytes')))
$$;

CREATE TABLE persistent_codex.regions (
  region_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('ready','cordoned','draining','drained','maintenance','failed')),
  control_plane_role text NOT NULL CHECK (control_plane_role IN ('active','passive','none')),
  placement_epoch bigint NOT NULL DEFAULT 1 CHECK (placement_epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE persistent_codex.runtime_nodes (
  region_id text NOT NULL REFERENCES persistent_codex.regions(region_id),
  node_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready','cordoned','draining','drained','maintenance','failed')),
  capacity_total jsonb NOT NULL,
  capacity_reserved jsonb NOT NULL,
  capacity_score numeric NOT NULL DEFAULT 0,
  heartbeat_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id,node_id),
  CHECK (persistent_codex.capacity_fits(capacity_total,capacity_reserved))
);

CREATE TABLE persistent_codex.tenant_scheduling_policies (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL DEFAULT '*',
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  algorithm text NOT NULL CHECK (algorithm='weighted-fair-v1'),
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 1000),
  tenant_concurrency integer NOT NULL CHECK (tenant_concurrency > 0),
  workspace_concurrency integer NOT NULL CHECK (workspace_concurrency=1),
  provider_concurrency jsonb NOT NULL,
  provider_requests_per_minute jsonb NOT NULL,
  starvation_age_ms bigint NOT NULL CHECK (starvation_age_ms > 0),
  retry_policy jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.scheduler_queue (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  queue_item_id text NOT NULL,
  run_id text NOT NULL,
  session_id text NOT NULL,
  provider_id text NOT NULL,
  idempotency_key text NOT NULL,
  required_region_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','leased','starting','running','retry_wait','completed','failed','poisoned','recovery_required')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  virtual_finish numeric NOT NULL CHECK (virtual_finish >= 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  not_before timestamptz NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  lease_owner_id text,
  fencing_token bigint,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,queue_item_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  UNIQUE (tenant_id,organization_id,workspace_id,run_id),
  FOREIGN KEY (organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(organization_id,workspace_id),
  FOREIGN KEY (required_region_id) REFERENCES persistent_codex.regions(region_id),
  FOREIGN KEY (tenant_id,organization_id)
    REFERENCES persistent_codex.tenant_scheduling_policies(tenant_id,organization_id),
  CHECK (tenant_id=organization_id)
);
CREATE INDEX scheduler_queue_claim_idx ON persistent_codex.scheduler_queue
  (state,not_before,virtual_finish,priority DESC,enqueued_at);
CREATE UNIQUE INDEX scheduler_one_active_workspace_idx ON persistent_codex.scheduler_queue
  (tenant_id,organization_id,workspace_id)
  WHERE state IN ('leased','starting','running');

CREATE TABLE persistent_codex.scheduler_provider_admissions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  admission_id bigint GENERATED ALWAYS AS IDENTITY,
  queue_item_id text NOT NULL,
  provider_id text NOT NULL,
  admitted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,admission_id),
  UNIQUE (tenant_id,organization_id,workspace_id,queue_item_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,queue_item_id)
    REFERENCES persistent_codex.scheduler_queue(tenant_id,organization_id,workspace_id,queue_item_id)
);
CREATE INDEX scheduler_provider_rate_idx ON persistent_codex.scheduler_provider_admissions
  (provider_id,admitted_at DESC);

CREATE TABLE persistent_codex.workspace_fence_counters (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  last_token bigint NOT NULL CHECK (last_token > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id),
  UNIQUE (tenant_id,organization_id,workspace_id,last_token),
  FOREIGN KEY (organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.workspace_leases (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  lease_id text NOT NULL,
  queue_item_id text NOT NULL,
  run_id text NOT NULL,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  state text NOT NULL CHECK (state IN ('active','released','expired','revoked')),
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,lease_id),
  UNIQUE (tenant_id,organization_id,workspace_id,queue_item_id,fencing_token),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,queue_item_id)
    REFERENCES persistent_codex.scheduler_queue(tenant_id,organization_id,workspace_id,queue_item_id),
  CHECK (expires_at>acquired_at)
);
CREATE UNIQUE INDEX workspace_one_active_lease_idx ON persistent_codex.workspace_leases
  (tenant_id,organization_id,workspace_id) WHERE state='active';

CREATE TABLE persistent_codex.workspace_placements (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  placement_id text NOT NULL,
  region_id text NOT NULL,
  node_id text NOT NULL,
  runtime_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation>0),
  state text NOT NULL CHECK (state IN ('requested','placed','starting','ready','checkpointing','rescheduling','recovering','drained','failed')),
  affinity jsonb NOT NULL,
  capacity jsonb NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,placement_id),
  UNIQUE (tenant_id,organization_id,workspace_id,runtime_id,generation),
  FOREIGN KEY (region_id,node_id) REFERENCES persistent_codex.runtime_nodes(region_id,node_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspace_fence_counters(tenant_id,organization_id,workspace_id)
);

CREATE TABLE persistent_codex.capacity_reservations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  reservation_id text NOT NULL,
  queue_item_id text NOT NULL,
  region_id text NOT NULL,
  node_id text NOT NULL,
  runtime_id text,
  state text NOT NULL CHECK (state IN ('held','bound','released','expired')),
  capacity jsonb NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token>0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,reservation_id),
  UNIQUE (tenant_id,organization_id,workspace_id,queue_item_id,fencing_token),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,queue_item_id)
    REFERENCES persistent_codex.scheduler_queue(tenant_id,organization_id,workspace_id,queue_item_id),
  FOREIGN KEY (region_id,node_id) REFERENCES persistent_codex.runtime_nodes(region_id,node_id)
);

CREATE OR REPLACE FUNCTION persistent_codex.release_node_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('held','bound') AND NEW.state IN ('released','expired') THEN
    UPDATE persistent_codex.runtime_nodes
    SET capacity_reserved=persistent_codex.capacity_subtract(capacity_reserved,OLD.capacity),
        updated_at=NEW.updated_at
    WHERE region_id=OLD.region_id AND node_id=OLD.node_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capacity_reservation_release
AFTER UPDATE OF state ON persistent_codex.capacity_reservations
FOR EACH ROW EXECUTE FUNCTION persistent_codex.release_node_capacity();

CREATE TABLE persistent_codex.drain_states (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  drain_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('region','node')),
  region_id text NOT NULL REFERENCES persistent_codex.regions(region_id),
  node_id text,
  state text NOT NULL CHECK (state IN ('accepting','cordoned','draining','drained','maintenance')),
  reason_code text NOT NULL,
  requested_at timestamptz NOT NULL,
  deadline_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,drain_id),
  FOREIGN KEY (region_id,node_id) REFERENCES persistent_codex.runtime_nodes(region_id,node_id),
  CHECK ((target_kind='region' AND node_id IS NULL) OR (target_kind='node' AND node_id IS NOT NULL))
);

CREATE TABLE persistent_codex.recovery_outcomes (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  recovery_id text NOT NULL,
  run_id text NOT NULL,
  previous_placement_id text,
  next_placement_id text,
  previous_fencing_token bigint NOT NULL CHECK (previous_fencing_token>=0),
  next_fencing_token bigint NOT NULL CHECK (next_fencing_token>0),
  checkpoint_id text,
  outcome text NOT NULL CHECK (outcome IN ('rescheduled','resumed','replayed','outcome_unknown','failed')),
  reason_code text NOT NULL,
  rpo_ms bigint NOT NULL CHECK (rpo_ms>=0),
  rto_ms bigint NOT NULL CHECK (rto_ms>=0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,recovery_id),
  UNIQUE (tenant_id,organization_id,workspace_id,run_id,next_fencing_token)
);

CREATE TABLE persistent_codex.dependency_readiness (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  instance_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('api','realtime','scheduler','workspace-agent')),
  mode text NOT NULL CHECK (mode IN ('development','production')),
  ready boolean NOT NULL,
  dependencies jsonb NOT NULL,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,instance_id)
);

CREATE TABLE persistent_codex.capacity_limit_outcomes (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  outcome_id text NOT NULL,
  run_id text NOT NULL,
  resource text NOT NULL CHECK (resource IN ('cpu','memory','pids','io','disk_bytes','disk_inodes','disk_iops','egress_bandwidth','egress_requests','event_bytes','artifact_bytes','output_bytes','corpus_index_bytes')),
  action text NOT NULL CHECK (action IN ('throttled','rejected','terminated','spilled')),
  limit_value bigint NOT NULL CHECK (limit_value>=0),
  observed_value bigint NOT NULL CHECK (observed_value>=0),
  reason_code text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,outcome_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_scheduling_policies','scheduler_queue','scheduler_provider_admissions','workspace_fence_counters',
    'workspace_leases','workspace_placements','capacity_reservations','drain_states',
    'recovery_outcomes','dependency_readiness','capacity_limit_outcomes'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY topology_tenant_isolation ON persistent_codex.%I
      FOR ALL USING (
        (tenant_id=current_setting(''app.tenant_id'',true)
         AND organization_id=current_setting(''app.organization_id'',true)
         AND workspace_id=current_setting(''app.workspace_id'',true))
        OR pg_has_role(current_user,''persistent_topology_scheduler'',''member'')
      ) WITH CHECK (
        (tenant_id=current_setting(''app.tenant_id'',true)
         AND organization_id=current_setting(''app.organization_id'',true)
         AND workspace_id=current_setting(''app.workspace_id'',true))
        OR pg_has_role(current_user,''persistent_topology_scheduler'',''member'')
      )',table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION persistent_codex.assert_workspace_fence(
  p_tenant text,p_organization text,p_workspace text,p_run text,p_token bigint
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,persistent_codex SET row_security=off AS $$
  SELECT EXISTS (
    SELECT 1 FROM persistent_codex.workspace_leases l
    WHERE l.tenant_id=p_tenant AND l.organization_id=p_organization
      AND l.workspace_id=p_workspace AND l.run_id=p_run
      AND l.fencing_token=p_token AND l.state='active' AND l.expires_at>now()
  ) AND EXISTS (
    SELECT 1 FROM persistent_codex.workspace_fence_counters f
    WHERE f.tenant_id=p_tenant AND f.organization_id=p_organization
      AND f.workspace_id=p_workspace AND f.last_token=p_token
  )
$$;
REVOKE ALL ON FUNCTION persistent_codex.assert_workspace_fence(text,text,text,text,bigint) FROM PUBLIC;

INSERT INTO persistent_codex.security_migrations(version)
VALUES (28) ON CONFLICT DO NOTHING;

COMMIT;
