-- Roadmap 12c: org templates ("Save as template"), docs/phase12/ORG-TEMPLATES.md §2.
CREATE TABLE org_templates (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  summary           TEXT NOT NULL DEFAULT '',
  engine_id         TEXT NOT NULL,
  engine_major      INTEGER NOT NULL,
  engine_version    TEXT NOT NULL,
  model             JSONB NOT NULL,
  docs              JSONB NOT NULL DEFAULT '[]',
  table_count       INTEGER NOT NULL,
  source_project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  created_by_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL
);

CREATE INDEX org_templates_organization_id_idx ON org_templates (organization_id);
