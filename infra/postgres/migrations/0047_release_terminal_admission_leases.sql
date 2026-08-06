BEGIN;

-- A run that is already terminal cannot consume concurrency. Older scheduler
-- versions omitted billing completion on the poisoned retry-exhaustion path,
-- leaving these leases open indefinitely and eventually denying every turn.
UPDATE persistent_codex.commercial_admission_leases AS lease
SET released_at = COALESCE(run.terminal_at, now())
FROM persistent_codex.ha_runs AS run
WHERE lease.tenant_id = run.tenant_id
  AND lease.organization_id = run.organization_id
  AND lease.workspace_id = run.workspace_id
  AND lease.resource_id = run.run_id
  AND lease.operation = 'turn.start'
  AND lease.released_at IS NULL
  AND run.state IN ('completed', 'failed', 'poisoned', 'outcome_unknown')
  AND run.terminal_at IS NOT NULL;

COMMIT;
