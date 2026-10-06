-- Roadmap 14b (docs/phase14/DIRECTORY-SYNC.md §1–§2): SCIM provisioning and groups from a
-- sign-in claim.

ALTER TABLE org_members ADD COLUMN scim_external_id TEXT;

ALTER TABLE user_groups
  ADD COLUMN managed_by TEXT,
  ADD COLUMN scim_external_id TEXT,
  -- One source per group (D4): pushed by SCIM, filled from a claim, or managed here.
  ADD CONSTRAINT user_groups_managed_by_ck CHECK (managed_by IN ('scim', 'claim'));

ALTER TABLE sso_connections ADD COLUMN groups_claim TEXT;

CREATE TABLE scim_tokens (
  id                TEXT PRIMARY KEY,
  sso_connection_id TEXT NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL,
  prefix            TEXT NOT NULL,
  created_by_id     TEXT,
  last_used_at      TIMESTAMPTZ(6),
  revoked_at        TIMESTAMPTZ(6),
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX scim_tokens_token_hash_key ON scim_tokens (token_hash);
CREATE INDEX scim_tokens_sso_connection_id_idx ON scim_tokens (sso_connection_id);
-- One live token per connection (§1.1): regenerating revokes the old one first.
CREATE UNIQUE INDEX scim_tokens_one_live_uq ON scim_tokens (sso_connection_id) WHERE revoked_at IS NULL;

CREATE TABLE sso_group_mappings (
  id                TEXT PRIMARY KEY,
  sso_connection_id TEXT NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  claim_value       TEXT NOT NULL,
  group_id          TEXT NOT NULL REFERENCES user_groups (id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sso_group_mappings_sso_connection_id_claim_value_key
  ON sso_group_mappings (sso_connection_id, claim_value);
CREATE INDEX sso_group_mappings_group_id_idx ON sso_group_mappings (group_id);
