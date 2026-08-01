BEGIN;

ALTER TABLE persistent_codex.folder_audit_records
  DROP CONSTRAINT folder_audit_records_action_check;

ALTER TABLE persistent_codex.folder_audit_records
  ADD CONSTRAINT folder_audit_records_action_check CHECK (action IN (
    'folder.created','folder.deleted','invitation.created','invitation.accepted',
    'invitation.revoked','membership.role_changed','membership.revoked',
    'ownership.transferred','resource.moved','folder.exported'));

COMMIT;
