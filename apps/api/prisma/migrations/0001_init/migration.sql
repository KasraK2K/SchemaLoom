-- CreateEnum
CREATE TYPE "org_role" AS ENUM ('owner', 'admin', 'member', 'guest');

-- CreateEnum
CREATE TYPE "resource_type" AS ENUM ('project', 'area', 'entity');

-- CreateEnum
CREATE TYPE "restricted_field_mode" AS ENUM ('mask', 'hide');

-- CreateEnum
CREATE TYPE "principal_type" AS ENUM ('user', 'group', 'email_invite', 'share_link');

-- CreateEnum
CREATE TYPE "target_type" AS ENUM ('project', 'area', 'entity', 'field');

-- CreateEnum
CREATE TYPE "link_cardinality" AS ENUM ('one_to_one', 'one_to_many', 'many_to_one', 'many_to_many');

-- CreateEnum
CREATE TYPE "access_request_status" AS ENUM ('pending', 'approved', 'denied', 'withdrawn');

-- CreateEnum
CREATE TYPE "verification_purpose" AS ENUM ('email_verification', 'password_reset', 'magic_link', 'email_change');

-- CreateEnum
CREATE TYPE "ai_message_role" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "snapshot_kind" AS ENUM ('manual', 'auto', 'import', 'restore');

-- CreateEnum
CREATE TYPE "doc_draft_status" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "theme_preference" AS ENUM ('light', 'dark', 'system');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "password_hash" TEXT,
    "theme" "theme_preference" NOT NULL DEFAULT 'system',
    "totp_secret" TEXT,
    "totp_confirmed_at" TIMESTAMPTZ(6),
    "notification_prefs" JSONB NOT NULL DEFAULT '{}',
    "perm_generation" INTEGER NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "token_type" TEXT,
    "scope" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT NOT NULL,
    "purpose" "verification_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "avatar_url" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "perm_generation" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_members" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "org_role" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "engine_id" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "engine_plugin_version" TEXT NOT NULL,
    "schema_revision" BIGINT NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "restricted_field_mode" "restricted_field_mode" NOT NULL DEFAULT 'mask',
    "perm_generation" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "namespaces" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "namespaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'indigo',
    "position" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "namespace_id" TEXT,
    "area_id" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'table',
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "color" TEXT,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fields" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "parent_field_id" TEXT,
    "name" TEXT NOT NULL,
    "data_type" TEXT NOT NULL,
    "custom_type_id" TEXT,
    "type_args" JSONB NOT NULL DEFAULT '[]',
    "type_dimensions" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_nullable" BOOLEAN NOT NULL DEFAULT true,
    "is_restricted" BOOLEAN NOT NULL DEFAULT false,
    "is_pii" BOOLEAN NOT NULL DEFAULT false,
    "is_deprecated" BOOLEAN NOT NULL DEFAULT false,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "links" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'foreign_key',
    "cardinality" "link_cardinality" NOT NULL DEFAULT 'many_to_one',
    "source_entity_id" TEXT NOT NULL,
    "target_entity_id" TEXT NOT NULL,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_endpoints" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_field_id" TEXT NOT NULL,
    "target_field_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "link_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexes" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'btree',
    "is_unique" BOOLEAN NOT NULL DEFAULT false,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "index_columns" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "index_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "field_id" TEXT,
    "expression" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'asc',
    "is_include" BOOLEAN NOT NULL DEFAULT false,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "index_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "constraints" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT NOT NULL,
    "expression" TEXT,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "constraints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "constraint_columns" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "constraint_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "field_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "constraint_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_types" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "namespace_id" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engine_props" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '{"entityIds":[],"fieldIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "docs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_type" "target_type" NOT NULL,
    "target_id" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{"type":"doc"}',
    "structured" JSONB,
    "plain_text" TEXT,
    "updated_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_type" "target_type" NOT NULL,
    "target_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "root_id" TEXT NOT NULL,
    "author_id" TEXT,
    "content" JSONB NOT NULL DEFAULT '{"type":"doc"}',
    "plain_text" TEXT,
    "mentioned_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_queries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "ai_thread_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "query_text" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'sql',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "identifiers_resolved" BOOLEAN NOT NULL DEFAULT false,
    "touched_entity_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "touched_field_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_query_entities" (
    "saved_query_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_query_entities_pkey" PRIMARY KEY ("saved_query_id","entity_id")
);

-- CreateTable
CREATE TABLE "ai_threads" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "selection" JSONB NOT NULL DEFAULT '{}',
    "last_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "role" "ai_message_role" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "query_text" TEXT,
    "model" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "touched_entity_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "touched_field_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "snapshot_kind" NOT NULL DEFAULT 'manual',
    "ir" JSONB NOT NULL,
    "ir_schema_version" INTEGER NOT NULL DEFAULT 1,
    "engine_plugin_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "atoms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grants" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "resource_type" "resource_type" NOT NULL,
    "resource_id" TEXT NOT NULL,
    "principal_type" "principal_type" NOT NULL,
    "principal_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "can_use_ai" BOOLEAN NOT NULL DEFAULT false,
    "can_view_restricted" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_by_id" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "label" TEXT,
    "token_hash" TEXT NOT NULL,
    "password_hash" TEXT,
    "created_by_id" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_accessed_at" TIMESTAMPTZ(6),
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "resource_type" "resource_type" NOT NULL,
    "resource_id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "requested_role_id" TEXT,
    "message" TEXT,
    "status" "access_request_status" NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "deny_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "org_role" "org_role" NOT NULL DEFAULT 'member',
    "access_grant_id" TEXT,
    "invited_by_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_user_id" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "target_type" "target_type",
    "target_id" TEXT,
    "target_name" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "organization_name" TEXT,
    "project_id" TEXT,
    "actor_user_id" TEXT,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "organization_id" TEXT,
    "project_id" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_drafts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_type" "target_type" NOT NULL,
    "target_id" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{"type":"doc"}',
    "structured" JSONB,
    "status" "doc_draft_status" NOT NULL DEFAULT 'pending',
    "job_id" TEXT,
    "created_by_id" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "doc_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "format" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "storage_key" TEXT,
    "size_bytes" INTEGER,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_family_id_created_at_idx" ON "sessions"("user_id", "family_id", "created_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_hash_key" ON "verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "verification_tokens_email_purpose_idx" ON "verification_tokens"("email", "purpose");

-- CreateIndex
CREATE INDEX "verification_tokens_expires_at_idx" ON "verification_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_used_at_idx" ON "recovery_codes"("user_id", "used_at");

-- CreateIndex
CREATE INDEX "organizations_deleted_at_idx" ON "organizations"("deleted_at");

-- CreateIndex
CREATE INDEX "org_members_user_id_idx" ON "org_members"("user_id");

-- CreateIndex
CREATE INDEX "org_members_organization_id_role_idx" ON "org_members"("organization_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "org_members_organization_id_user_id_key" ON "org_members"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "user_groups_organization_id_idx" ON "user_groups"("organization_id");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_group_id_user_id_key" ON "group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "workspaces_organization_id_position_idx" ON "workspaces"("organization_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_organization_id_slug_key" ON "workspaces"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "projects_organization_id_deleted_at_idx" ON "projects"("organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "projects_workspace_id_deleted_at_idx" ON "projects"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX "projects_engine_id_idx" ON "projects"("engine_id");

-- CreateIndex
CREATE INDEX "namespaces_project_id_idx" ON "namespaces"("project_id");

-- CreateIndex
CREATE INDEX "areas_project_id_position_idx" ON "areas"("project_id", "position");

-- CreateIndex
CREATE INDEX "entities_project_id_idx" ON "entities"("project_id");

-- CreateIndex
CREATE INDEX "entities_project_id_area_id_idx" ON "entities"("project_id", "area_id");

-- CreateIndex
CREATE INDEX "entities_namespace_id_idx" ON "entities"("namespace_id");

-- CreateIndex
CREATE INDEX "entities_project_id_name_idx" ON "entities"("project_id", "name");

-- CreateIndex
CREATE INDEX "fields_project_id_idx" ON "fields"("project_id");

-- CreateIndex
CREATE INDEX "fields_entity_id_position_idx" ON "fields"("entity_id", "position");

-- CreateIndex
CREATE INDEX "fields_parent_field_id_position_idx" ON "fields"("parent_field_id", "position");

-- CreateIndex
CREATE INDEX "fields_custom_type_id_idx" ON "fields"("custom_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "fields_id_entity_id_key" ON "fields"("id", "entity_id");

-- CreateIndex
CREATE INDEX "links_project_id_idx" ON "links"("project_id");

-- CreateIndex
CREATE INDEX "links_source_entity_id_idx" ON "links"("source_entity_id");

-- CreateIndex
CREATE INDEX "links_target_entity_id_idx" ON "links"("target_entity_id");

-- CreateIndex
CREATE INDEX "link_endpoints_source_field_id_idx" ON "link_endpoints"("source_field_id");

-- CreateIndex
CREATE INDEX "link_endpoints_target_field_id_idx" ON "link_endpoints"("target_field_id");

-- CreateIndex
CREATE INDEX "link_endpoints_project_id_idx" ON "link_endpoints"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "link_endpoints_link_id_ordinal_key" ON "link_endpoints"("link_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "link_endpoints_link_id_source_field_id_key" ON "link_endpoints"("link_id", "source_field_id");

-- CreateIndex
CREATE INDEX "indexes_project_id_idx" ON "indexes"("project_id");

-- CreateIndex
CREATE INDEX "indexes_entity_id_idx" ON "indexes"("entity_id");

-- CreateIndex
CREATE INDEX "index_columns_field_id_idx" ON "index_columns"("field_id");

-- CreateIndex
CREATE INDEX "index_columns_project_id_idx" ON "index_columns"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "index_columns_index_id_ordinal_key" ON "index_columns"("index_id", "ordinal");

-- CreateIndex
CREATE INDEX "constraints_project_id_idx" ON "constraints"("project_id");

-- CreateIndex
CREATE INDEX "constraints_entity_id_idx" ON "constraints"("entity_id");

-- CreateIndex
CREATE INDEX "constraints_entity_id_kind_idx" ON "constraints"("entity_id", "kind");

-- CreateIndex
CREATE INDEX "constraint_columns_field_id_idx" ON "constraint_columns"("field_id");

-- CreateIndex
CREATE INDEX "constraint_columns_project_id_idx" ON "constraint_columns"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "constraint_columns_constraint_id_ordinal_key" ON "constraint_columns"("constraint_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "constraint_columns_constraint_id_field_id_key" ON "constraint_columns"("constraint_id", "field_id");

-- CreateIndex
CREATE INDEX "custom_types_project_id_idx" ON "custom_types"("project_id");

-- CreateIndex
CREATE INDEX "custom_types_namespace_id_idx" ON "custom_types"("namespace_id");

-- CreateIndex
CREATE INDEX "docs_project_id_target_type_idx" ON "docs"("project_id", "target_type");

-- CreateIndex
CREATE UNIQUE INDEX "docs_target_type_target_id_key" ON "docs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "comments_target_type_target_id_created_at_idx" ON "comments"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_root_id_created_at_idx" ON "comments"("root_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_project_id_resolved_at_created_at_idx" ON "comments"("project_id", "resolved_at", "created_at");

-- CreateIndex
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");

-- CreateIndex
CREATE INDEX "saved_queries_project_id_updated_at_idx" ON "saved_queries"("project_id", "updated_at");

-- CreateIndex
CREATE INDEX "saved_queries_created_by_id_idx" ON "saved_queries"("created_by_id");

-- CreateIndex
CREATE INDEX "saved_queries_tags_idx" ON "saved_queries" USING GIN ("tags" array_ops);

-- CreateIndex
CREATE INDEX "saved_query_entities_entity_id_idx" ON "saved_query_entities"("entity_id");

-- CreateIndex
CREATE INDEX "saved_query_entities_project_id_idx" ON "saved_query_entities"("project_id");

-- CreateIndex
CREATE INDEX "ai_threads_project_id_last_message_at_idx" ON "ai_threads"("project_id", "last_message_at");

-- CreateIndex
CREATE INDEX "ai_threads_user_id_last_message_at_idx" ON "ai_threads"("user_id", "last_message_at");

-- CreateIndex
CREATE INDEX "ai_messages_project_id_created_at_idx" ON "ai_messages"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_thread_id_ordinal_key" ON "ai_messages"("thread_id", "ordinal");

-- CreateIndex
CREATE INDEX "snapshots_project_id_created_at_idx" ON "snapshots"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "roles_organization_id_idx" ON "roles"("organization_id");

-- CreateIndex
CREATE INDEX "access_grants_project_id_principal_type_principal_id_idx" ON "access_grants"("project_id", "principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "access_grants_principal_type_principal_id_idx" ON "access_grants"("principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "access_grants_project_id_resource_type_resource_id_idx" ON "access_grants"("project_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "access_grants_role_id_idx" ON "access_grants"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_grants_resource_type_resource_id_principal_type_prin_key" ON "access_grants"("resource_type", "resource_id", "principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");

-- CreateIndex
CREATE INDEX "share_links_project_id_revoked_at_idx" ON "share_links"("project_id", "revoked_at");

-- CreateIndex
CREATE INDEX "access_requests_project_id_status_created_at_idx" ON "access_requests"("project_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "access_requests_requester_id_status_idx" ON "access_requests"("requester_id", "status");

-- CreateIndex
CREATE INDEX "access_requests_resource_type_resource_id_idx" ON "access_requests"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_access_grant_id_key" ON "invitations"("access_grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_accepted_at_idx" ON "invitations"("organization_id", "accepted_at");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "activity_log_project_id_created_at_idx" ON "activity_log"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_project_id_target_type_target_id_created_at_idx" ON "activity_log"("project_id", "target_type", "target_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_actor_user_id_created_at_idx" ON "activity_log"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_organization_id_created_at_idx" ON "audit_log"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_organization_id_action_created_at_idx" ON "audit_log"("organization_id", "action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_resource_type_resource_id_created_at_idx" ON "audit_log"("resource_type", "resource_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "doc_drafts_project_id_status_idx" ON "doc_drafts"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "doc_drafts_target_type_target_id_status_key" ON "doc_drafts"("target_type", "target_id", "status");

-- CreateIndex
CREATE INDEX "export_jobs_project_id_created_at_idx" ON "export_jobs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "export_jobs_expires_at_idx" ON "export_jobs"("expires_at");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_parent_field_id_fkey" FOREIGN KEY ("parent_field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_custom_type_id_fkey" FOREIGN KEY ("custom_type_id") REFERENCES "custom_types"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "links" ADD CONSTRAINT "links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "links" ADD CONSTRAINT "links_source_entity_id_fkey" FOREIGN KEY ("source_entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "links" ADD CONSTRAINT "links_target_entity_id_fkey" FOREIGN KEY ("target_entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_endpoints" ADD CONSTRAINT "link_endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_endpoints" ADD CONSTRAINT "link_endpoints_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_endpoints" ADD CONSTRAINT "link_endpoints_source_field_id_fkey" FOREIGN KEY ("source_field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_endpoints" ADD CONSTRAINT "link_endpoints_target_field_id_fkey" FOREIGN KEY ("target_field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexes" ADD CONSTRAINT "indexes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexes" ADD CONSTRAINT "indexes_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_columns" ADD CONSTRAINT "index_columns_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_columns" ADD CONSTRAINT "index_columns_index_id_fkey" FOREIGN KEY ("index_id") REFERENCES "indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_columns" ADD CONSTRAINT "index_columns_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraints" ADD CONSTRAINT "constraints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraints" ADD CONSTRAINT "constraints_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_columns" ADD CONSTRAINT "constraint_columns_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_columns" ADD CONSTRAINT "constraint_columns_constraint_id_fkey" FOREIGN KEY ("constraint_id") REFERENCES "constraints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_columns" ADD CONSTRAINT "constraint_columns_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_types" ADD CONSTRAINT "custom_types_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_types" ADD CONSTRAINT "custom_types_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs" ADD CONSTRAINT "docs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs" ADD CONSTRAINT "docs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_ai_thread_id_fkey" FOREIGN KEY ("ai_thread_id") REFERENCES "ai_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_query_entities" ADD CONSTRAINT "saved_query_entities_saved_query_id_fkey" FOREIGN KEY ("saved_query_id") REFERENCES "saved_queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_query_entities" ADD CONSTRAINT "saved_query_entities_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_query_entities" ADD CONSTRAINT "saved_query_entities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "ai_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requested_role_id_fkey" FOREIGN KEY ("requested_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_access_grant_id_fkey" FOREIGN KEY ("access_grant_id") REFERENCES "access_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
