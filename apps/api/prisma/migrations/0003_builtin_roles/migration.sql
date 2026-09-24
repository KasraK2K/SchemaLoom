-- 0003_builtin_roles. Re-runnable.
INSERT INTO roles (id, organization_id, key, name, atoms, is_built_in, is_archived,
                   created_at, updated_at) VALUES
  ('rl00000000000000000viewer', NULL, 'viewer', 'Viewer',
   ARRAY['schema:view','export:run'], true, false, now(), now()),
  ('rl0000000000000commenter', NULL, 'commenter', 'Commenter',
   ARRAY['schema:view','export:run','comment:create'], true, false, now(), now()),
  ('rl000000000000documenter', NULL, 'documenter', 'Documenter',
   ARRAY['schema:view','export:run','comment:create','docs:edit'], true, false, now(), now()),
  ('rl00000000000000000editor', NULL, 'editor', 'Editor',
   ARRAY['schema:view','export:run','comment:create','docs:edit','schema:edit',
         'history:view'], true, false, now(), now()),
  ('rl0000000000000000manager', NULL, 'manager', 'Manager',
   ARRAY['schema:view','export:run','comment:create','docs:edit','schema:edit',
         'history:view','sharing:manage'], true, false, now(), now())
ON CONFLICT (id) DO NOTHING;
