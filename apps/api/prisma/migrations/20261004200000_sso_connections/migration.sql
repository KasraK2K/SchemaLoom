-- Roadmap 14: SSO connections (OIDC, SAML), one or more per organisation.
CREATE TYPE sso_protocol AS ENUM ('oidc', 'saml');

CREATE TABLE sso_connections (
  id                     TEXT PRIMARY KEY,
  organization_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  protocol               sso_protocol NOT NULL,
  name                   TEXT NOT NULL,
  domains                TEXT[] NOT NULL,
  oidc_issuer            TEXT,
  oidc_client_id         TEXT,
  oidc_client_secret_enc TEXT,
  saml_entry_point       TEXT,
  saml_idp_cert          TEXT,
  jit                    BOOLEAN NOT NULL DEFAULT false,
  default_org_role       org_role NOT NULL DEFAULT 'member',
  enforced               BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ(6) NOT NULL,
  -- A JIT member is a member or a guest: a connection never mints owners or admins.
  CONSTRAINT sso_connections_role_ck CHECK (default_org_role IN ('member', 'guest')),
  CONSTRAINT sso_connections_protocol_fields_ck CHECK (
    (protocol = 'oidc' AND oidc_issuer IS NOT NULL AND oidc_client_id IS NOT NULL)
    OR (protocol = 'saml' AND saml_entry_point IS NOT NULL AND saml_idp_cert IS NOT NULL)
  )
);

CREATE INDEX sso_connections_organization_id_idx ON sso_connections (organization_id);
