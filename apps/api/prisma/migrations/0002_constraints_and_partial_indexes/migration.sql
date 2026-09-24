-- =========================================================================
-- 0002_constraints_and_partial_indexes
-- =========================================================================

-- -------------------------------------------------------------------------
-- 2.1 Case-insensitive, soft-delete-aware uniqueness
-- -------------------------------------------------------------------------

-- Email identity. The database, not a convention, owns the normalisation: an
-- OAuth callback that hands us Bob@Example.com must not be able to create a
-- second account for the same human, and the invitation lookup must find the
-- same row the login found. This replaces the Prisma @unique on users.email.
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

ALTER TABLE invitations
  ADD CONSTRAINT invitations_email_lower_ck CHECK (email = lower(email));
ALTER TABLE verification_tokens
  ADD CONSTRAINT verification_tokens_email_lower_ck CHECK (email = lower(email));

CREATE UNIQUE INDEX organizations_slug_uq
  ON organizations (lower(slug)) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX projects_slug_uq
  ON projects (workspace_id, lower(slug)) WHERE deleted_at IS NULL;

-- Live projects of an org, newest first. Partial so the soft-deleted tail never
-- enters the index.
CREATE INDEX projects_live_org_idx
  ON projects (organization_id, updated_at DESC) WHERE deleted_at IS NULL;

-- -------------------------------------------------------------------------
-- 2.2 Schema-object naming rules (case-insensitive, nullable-parent aware)
-- coalesce(<nullable text>, '') is IMMUTABLE, so one index replaces the usual
-- pair of partial indexes.
-- -------------------------------------------------------------------------
CREATE UNIQUE INDEX namespaces_name_uq
  ON namespaces (project_id, lower(name));

CREATE UNIQUE INDEX namespaces_one_default_uq
  ON namespaces (project_id) WHERE is_default;

CREATE UNIQUE INDEX entities_name_uq
  ON entities (project_id, coalesce(namespace_id, ''), lower(name));

CREATE UNIQUE INDEX custom_types_name_uq
  ON custom_types (project_id, coalesce(namespace_id, ''), lower(name));

-- A field name is unique among its siblings: among the entity's top-level
-- fields when parent_field_id IS NULL, among the parent's children otherwise.
CREATE UNIQUE INDEX fields_name_uq
  ON fields (entity_id, coalesce(parent_field_id, ''), lower(name));

-- Index and constraint names are unique per namespace in PostgreSQL, but the
-- IR is engine-neutral, so we enforce the weaker per-project rule and let the
-- engine validator enforce the stricter one.
CREATE UNIQUE INDEX indexes_name_uq
  ON indexes (project_id, lower(name));

CREATE UNIQUE INDEX constraints_name_uq
  ON constraints (project_id, lower(name)) WHERE name IS NOT NULL;

-- -------------------------------------------------------------------------
-- 2.3 Field nesting integrity (section 9)
-- -------------------------------------------------------------------------
-- There is no `depth` column and no depth CHECK. See section 9.2: a materialised
-- depth is a derived value the application has to maintain correctly, and it was
-- the single point of failure for the cycle argument. The ceiling is enforced in
-- createField / reparentField by the descendant check those paths already run.
ALTER TABLE fields
  ADD CONSTRAINT fields_not_self_ck     CHECK (parent_field_id IS DISTINCT FROM id),
  ADD CONSTRAINT fields_position_ck     CHECK (position >= 0);

-- A nested field must live in the same entity as its parent. Prisma's generated
-- single-column FK cannot say this; a composite FK can. Target is the
-- @@unique([id, entityId]) index Prisma already created on fields.
ALTER TABLE fields
  ADD CONSTRAINT fields_parent_same_entity_fk
  FOREIGN KEY (parent_field_id, entity_id)
  REFERENCES fields (id, entity_id)
  ON DELETE CASCADE;

-- -------------------------------------------------------------------------
-- 2.4 Index / constraint column integrity
-- -------------------------------------------------------------------------
ALTER TABLE index_columns
  ADD CONSTRAINT index_columns_target_ck CHECK (num_nonnulls(field_id, expression) = 1),
  ADD CONSTRAINT index_columns_dir_ck    CHECK (direction IN ('asc', 'desc')),
  ADD CONSTRAINT index_columns_ordinal_ck CHECK (ordinal >= 0);

ALTER TABLE constraint_columns
  ADD CONSTRAINT constraint_columns_ordinal_ck CHECK (ordinal >= 0);

ALTER TABLE link_endpoints
  ADD CONSTRAINT link_endpoints_ordinal_ck CHECK (ordinal >= 0),
  ADD CONSTRAINT link_endpoints_distinct_ck CHECK (source_field_id <> target_field_id);

-- -------------------------------------------------------------------------
-- 2.5 access_grants — the polymorphism guard rails (section 4)
-- -------------------------------------------------------------------------
-- A project-scoped grant must point at its own project.
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_project_self_ck
  CHECK (resource_type <> 'project' OR resource_id = project_id);

-- An email_invite principal is a normalised email address, never an id.
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_email_shape_ck
  CHECK (
    principal_type <> 'email_invite'
    OR (principal_id = lower(principal_id)
        AND principal_id ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  );

-- A cuid principal is a cuid, not an email typed into the wrong box. This is a
-- shape smoke-test, NOT an integrity constraint: a user grant carrying a group id
-- passes it and still fails closed at lookup. Widened past cuid()'s exact alphabet
-- and length so that switching the id generator does not start rejecting every new
-- grant with an error message that points at a regex instead of at the generator.
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_id_shape_ck
  CHECK (
    principal_type NOT IN ('user', 'group', 'share_link')
    OR principal_id ~ '^[A-Za-z0-9_-]{16,64}$'
  );

-- A share link is one link to one resource. Without this you can hand the same
-- token two different scopes.
CREATE UNIQUE INDEX access_grants_one_per_share_link_uq
  ON access_grants (principal_id) WHERE principal_type = 'share_link';

-- Expiring grants are swept by a job; index the tail it scans.
CREATE INDEX access_grants_expiring_idx
  ON access_grants (expires_at) WHERE expires_at IS NOT NULL;

-- -------------------------------------------------------------------------
-- 2.6 docs / comments / access_requests
-- -------------------------------------------------------------------------
-- The project case only. For area/entity/field targets the writer DERIVES
-- project_id from the target row (sections 5 and 6) — the database cannot check a
-- polymorphic parent without a trigger per target type.
ALTER TABLE docs
  ADD CONSTRAINT docs_project_self_ck
  CHECK (target_type <> 'project' OR target_id = project_id);

ALTER TABLE comments
  ADD CONSTRAINT comments_project_self_ck
  CHECK (target_type <> 'project' OR target_id = project_id),
  ADD CONSTRAINT comments_resolved_pair_ck
  CHECK ((resolved_at IS NULL) = (resolved_by_id IS NULL)),
  ADD CONSTRAINT comments_root_not_child_ck
  CHECK (parent_id IS NOT NULL OR root_id = id);

-- One open request per (resource, requester). Re-requesting after a denial is
-- allowed; spamming a manager with five pending rows is not.
CREATE UNIQUE INDEX access_requests_pending_uq
  ON access_requests (resource_type, resource_id, requester_id)
  WHERE status = 'pending';

-- Unread badge + notification centre.
CREATE INDEX notifications_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- Open threads on a target: what the comment sidebar actually asks for.
CREATE INDEX comments_open_target_idx
  ON comments (target_type, target_id, created_at) WHERE resolved_at IS NULL;

-- -------------------------------------------------------------------------
-- 2.7 roles — built-in vs custom uniqueness
-- -------------------------------------------------------------------------
CREATE UNIQUE INDEX roles_builtin_key_uq
  ON roles (key) WHERE organization_id IS NULL;

CREATE UNIQUE INDEX roles_custom_key_uq
  ON roles (organization_id, key) WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX roles_custom_name_uq
  ON roles (organization_id, lower(name)) WHERE organization_id IS NOT NULL;

-- A built-in role is not editable per-org; belt and braces.
ALTER TABLE roles
  ADD CONSTRAINT roles_builtin_global_ck
  CHECK (is_built_in = (organization_id IS NULL));

-- -------------------------------------------------------------------------
-- 2.8 Orphan sweeping for the polymorphic tables (section 4/5/6)
-- One trigger function, three triggers. This is the price of (targetType,
-- targetId) and it is paid here, in the database, not in every service that
-- happens to delete an area.
-- -------------------------------------------------------------------------
CREATE FUNCTION purge_polymorphic_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM docs
    WHERE target_type::text = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM comments
    WHERE target_type::text = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM access_grants
    WHERE resource_type::text = TG_ARGV[0] AND resource_id = OLD.id;
  DELETE FROM access_requests
    WHERE resource_type::text = TG_ARGV[0] AND resource_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER areas_purge_refs    AFTER DELETE ON areas
  FOR EACH ROW EXECUTE FUNCTION purge_polymorphic_refs('area');
CREATE TRIGGER entities_purge_refs AFTER DELETE ON entities
  FOR EACH ROW EXECUTE FUNCTION purge_polymorphic_refs('entity');
CREATE TRIGGER fields_purge_refs   AFTER DELETE ON fields
  FOR EACH ROW EXECUTE FUNCTION purge_polymorphic_refs('field');

-- A share link is a PRINCIPAL, not a resource, so purge_polymorphic_refs (which
-- keys on resource_type) does not cover it. Hard-deleting a share_links row would
-- otherwise leave a grant whose principal does not exist.
CREATE FUNCTION purge_share_link_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access_grants
    WHERE principal_type = 'share_link' AND principal_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER share_links_purge_grants AFTER DELETE ON share_links
  FOR EACH ROW EXECUTE FUNCTION purge_share_link_grants();

-- -------------------------------------------------------------------------
-- 2.9 Parents that stop making sense when their last child dies
-- An index with zero columns is not an index; a keyed constraint with no columns
-- and no expression is not a constraint. Deleting a field must take them with it.
--
-- Two plain functions, four lines each, no dynamic SQL. The earlier version was a
-- generic format()/EXECUTE/TG_ARGV[0..2] function serving three call sites of three
-- different shapes: no cached plan, the hardest thing in the file to read at 3am,
-- and TG_ARGV[2] was a raw SQL-fragment escape hatch. Same total line count, and
-- each function now reads as exactly what it does.
--
-- There is deliberately NO purge trigger on link_endpoints. A link with zero
-- endpoints is a legal entity-level link (see the Link model comment and doc 04
-- section 8.6), not an edge to nowhere.
-- -------------------------------------------------------------------------
CREATE FUNCTION purge_empty_index() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM indexes i
    WHERE i.id = OLD.index_id
      AND NOT EXISTS (SELECT 1 FROM index_columns c WHERE c.index_id = i.id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER index_columns_purge_index AFTER DELETE ON index_columns
  FOR EACH ROW EXECUTE FUNCTION purge_empty_index();

-- The predicate is ENGINE-NEUTRAL: `expression IS NULL`, not a list of PostgreSQL
-- constraint kinds. A constraint with no columns and no expression is meaningless in
-- any paradigm, and the constraints that legitimately have no columns (CHECK,
-- EXCLUDE) are exactly the ones carrying an expression. Enumerating
-- ('primary_key','unique','exclusion') here would put engine vocabulary in a core
-- migration, which is the thing C4 exists to prevent, and a future engine that spells
-- its keyed kind differently would silently leave zero-column constraints behind.
CREATE FUNCTION purge_empty_keyed_constraint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM constraints p
    WHERE p.id = OLD.constraint_id
      AND p.expression IS NULL
      AND NOT EXISTS (SELECT 1 FROM constraint_columns c WHERE c.constraint_id = p.id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER constraint_columns_purge_constraint AFTER DELETE ON constraint_columns
  FOR EACH ROW EXECUTE FUNCTION purge_empty_keyed_constraint();

-- -------------------------------------------------------------------------
-- 2.10 Deferred referential actions (section 8.6)
-- Five FKs must not fire while a cascade above them is still running. Prisma
-- declares them `NoAction`; Prisma cannot express DEFERRABLE, so the deferral is
-- added here. Without this, whether `DELETE FROM organizations` or a project purge
-- succeeds depends on the order Prisma happened to emit ADD CONSTRAINT in 0001 —
-- and for namespaces vs entities that order is against us.
-- -------------------------------------------------------------------------
ALTER TABLE projects
  DROP CONSTRAINT projects_workspace_id_fkey,
  ADD CONSTRAINT projects_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE entities
  DROP CONSTRAINT entities_namespace_id_fkey,
  ADD CONSTRAINT entities_namespace_id_fkey
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE custom_types
  DROP CONSTRAINT custom_types_namespace_id_fkey,
  ADD CONSTRAINT custom_types_namespace_id_fkey
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE fields
  DROP CONSTRAINT fields_custom_type_id_fkey,
  ADD CONSTRAINT fields_custom_type_id_fkey
    FOREIGN KEY (custom_type_id) REFERENCES custom_types(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Deleting an organization cascades `roles` and, through `projects`,
-- `access_grants`. `roles` is created first, so its cascade fires first.
ALTER TABLE access_grants
  DROP CONSTRAINT access_grants_role_id_fkey,
  ADD CONSTRAINT access_grants_role_id_fkey
    FOREIGN KEY (role_id) REFERENCES roles(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
