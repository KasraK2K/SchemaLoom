-- Roadmap 24 (docs/phase24/DESIGN.md §2)
CREATE TABLE "ai_integrations" (
  "id"              TEXT PRIMARY KEY,
  "organization_id" TEXT REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id"   TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "source"          TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "base_url"        TEXT,
  "api_key_enc"     TEXT,
  "key_hint"        TEXT,
  "allowed_models"  TEXT[] NOT NULL DEFAULT '{}',
  "status"          TEXT NOT NULL DEFAULT 'unchecked',
  "last_error"      TEXT,
  "last_checked_at" TIMESTAMPTZ(6),
  "created_by_id"   TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ai_integrations_one_owner_ck" CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL)),
  CONSTRAINT "ai_integrations_source_ck" CHECK ("source" IN ('server', 'custom')),
  CONSTRAINT "ai_integrations_provider_ck" CHECK ("provider" IN ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  CONSTRAINT "ai_integrations_server_ck" CHECK ("source" = 'custom' OR ("organization_id" IS NOT NULL AND "provider" = 'anthropic' AND "api_key_enc" IS NULL)),
  CONSTRAINT "ai_integrations_base_url_ck" CHECK ("base_url" IS NULL OR "provider" = 'openai_compatible'),
  CONSTRAINT "ai_integrations_key_ck" CHECK ("source" = 'server' OR "provider" = 'openai_compatible' OR "api_key_enc" IS NOT NULL),
  CONSTRAINT "ai_integrations_status_ck" CHECK ("status" IN ('unchecked', 'ok', 'failing'))
);
CREATE INDEX "ai_integrations_organization_id_idx" ON "ai_integrations"("organization_id");
CREATE INDEX "ai_integrations_owner_user_id_idx" ON "ai_integrations"("owner_user_id");
CREATE UNIQUE INDEX "ai_integrations_server_uq" ON "ai_integrations"("organization_id") WHERE "source" = 'server';

CREATE TABLE "ai_integration_grants" (
  "id"             TEXT PRIMARY KEY,
  "integration_id" TEXT NOT NULL REFERENCES "ai_integrations"("id") ON DELETE CASCADE,
  "project_id"     TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"        TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by_id"  TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "ai_integration_grants_integration_id_idx" ON "ai_integration_grants"("integration_id");
CREATE UNIQUE INDEX "ai_integration_grants_scope_uq" ON "ai_integration_grants"("integration_id", "project_id", "user_id") NULLS NOT DISTINCT;

CREATE TABLE "ai_ability_choices" (
  "id"              TEXT PRIMARY KEY,
  "ability"         TEXT NOT NULL,
  "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id"      TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"         TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "integration_id"  TEXT NOT NULL REFERENCES "ai_integrations"("id") ON DELETE CASCADE,
  "model"           TEXT NOT NULL,
  "locked"          BOOLEAN NOT NULL DEFAULT false,
  "updated_by_id"   TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ai_ability_choices_lock_ck" CHECK (NOT "locked" OR "user_id" IS NULL)
);
CREATE INDEX "ai_ability_choices_organization_id_ability_idx" ON "ai_ability_choices"("organization_id", "ability");
CREATE UNIQUE INDEX "ai_ability_choices_scope_uq" ON "ai_ability_choices"("organization_id", "ability", "project_id", "user_id") NULLS NOT DISTINCT;

ALTER TABLE "ai_messages" ADD COLUMN "integration_id" TEXT REFERENCES "ai_integrations"("id") ON DELETE SET NULL;

-- §6: every existing org gets its server row and a `*` grant, so a deploy with
-- ANTHROPIC_API_KEY behaves exactly as before.
INSERT INTO "ai_integrations" ("id", "organization_id", "source", "provider", "name", "updated_at")
SELECT 'aii_srv_' || "id", "id", 'server', 'anthropic', 'Server default', now() FROM "organizations";
INSERT INTO "ai_integration_grants" ("id", "integration_id")
SELECT 'aig_srv_' || "id", 'aii_srv_' || "id" FROM "organizations";
