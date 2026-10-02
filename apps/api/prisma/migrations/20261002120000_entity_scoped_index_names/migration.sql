-- Roadmap 9 (docs/phase9/DESIGN.md §5.1): index and constraint names are unique per TABLE,
-- not per project. MySQL scopes them to the table (`idx_user_id` on several tables is normal,
-- and every primary key is named `PRIMARY`). PostgreSQL's wider rule (one name per schema)
-- is now the PostgreSQL validator's `duplicate-name` diagnostic.

DROP INDEX IF EXISTS indexes_name_uq;
DROP INDEX IF EXISTS constraints_name_uq;

CREATE UNIQUE INDEX indexes_name_uq
  ON indexes (entity_id, lower(name));

CREATE UNIQUE INDEX constraints_name_uq
  ON constraints (entity_id, lower(name)) WHERE name IS NOT NULL;
