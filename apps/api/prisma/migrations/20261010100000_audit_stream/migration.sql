-- Roadmap 14d (docs/phase14/AUDIT-STREAMING.md §2): streaming the audit log to a SIEM.

CREATE TABLE audit_streams (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  format             TEXT NOT NULL,
  auth_header_name   TEXT,
  auth_header_enc    TEXT,
  signing_secret_enc TEXT NOT NULL,
  cursor_at          TIMESTAMPTZ(6) NOT NULL,
  cursor_id          TEXT,
  paused             BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'ok',
  last_error         TEXT,
  failures           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ(6),
  last_delivered_at  TIMESTAMPTZ(6),
  failing_since      TIMESTAMPTZ(6),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT audit_streams_format_ck CHECK (format IN ('json', 'splunk_hec', 'datadog')),
  CONSTRAINT audit_streams_status_ck CHECK (status IN ('ok', 'failing'))
);

-- One stream per org (Q1).
CREATE UNIQUE INDEX audit_streams_organization_id_key ON audit_streams (organization_id);
