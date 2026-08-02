BEGIN;

CREATE TABLE IF NOT EXISTS persistent_codex.workspace_membership_overrides (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  access text NOT NULL CHECK (access IN ('allow', 'deny')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, issuer, subject),
  FOREIGN KEY (organization_id, issuer, subject)
    REFERENCES persistent_codex.organization_memberships
      (organization_id, issuer, subject)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_membership_overrides_principal_idx
  ON persistent_codex.workspace_membership_overrides
    (organization_id, issuer, subject, access, workspace_id);

-- Preserve the effective organization-wide access of existing memberships.
INSERT INTO persistent_codex.workspace_membership_overrides
  (organization_id, workspace_id, issuer, subject, access)
SELECT m.organization_id, w.workspace_id, m.issuer, m.subject, 'allow'
FROM persistent_codex.organization_memberships m
JOIN persistent_codex.workspaces w
  ON w.organization_id = m.organization_id
WHERE m.status = 'active'
ON CONFLICT DO NOTHING;

COMMIT;
