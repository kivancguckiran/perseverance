BEGIN;

ALTER TABLE persistent_codex.organization_memberships
  DROP CONSTRAINT IF EXISTS organization_memberships_role_check;

ALTER TABLE persistent_codex.organization_memberships
  ADD CONSTRAINT organization_memberships_role_check
  CHECK (role IN (
    'owner',
    'admin',
    'developer',
    'viewer',
    'billing',
    'support',
    'operator',
    'security_approver',
    'kms_operator'
  ));

COMMIT;
