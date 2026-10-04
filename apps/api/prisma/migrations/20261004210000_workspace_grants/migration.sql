-- Roadmap 19: workspace-level grants. One row covers every project in the workspace.
CREATE TABLE workspace_grants (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  principal_type      principal_type NOT NULL,
  principal_id        TEXT NOT NULL,
  -- Deferred like access_grants.role_id (doc 02 section 8.6): deleting an organisation
  -- cascades roles and workspaces in one statement, in no promised order.
  role_id             TEXT NOT NULL REFERENCES roles (id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  can_use_ai          BOOLEAN NOT NULL DEFAULT false,
  can_view_restricted BOOLEAN NOT NULL DEFAULT false,
  note                TEXT,
  created_by_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ(6),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT workspace_grants_principal_ck CHECK (principal_type IN ('user', 'group'))
);

CREATE UNIQUE INDEX workspace_grants_workspace_id_principal_type_principal_id_key
  ON workspace_grants (workspace_id, principal_type, principal_id);
CREATE INDEX workspace_grants_principal_type_principal_id_idx
  ON workspace_grants (principal_type, principal_id);
CREATE INDEX workspace_grants_role_id_idx ON workspace_grants (role_id);
