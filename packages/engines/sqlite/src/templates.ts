import type { ProjectTemplate } from '@schemaloom/engine-sdk';

/**
 * Phase 13 §4.6 — two small starting schemas, written the way SQLite apps are: INTEGER
 * PRIMARY KEY rowids, TEXT dates, CHECK lists in place of enums, foreign keys declared in the
 * table. `templates/import-cleanly` fails if any statement stops applying.
 */

const TODO = `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
  due_on TEXT,
  done_at TEXT
);

CREATE INDEX tasks_list_status ON tasks (list_id, status);
CREATE INDEX tasks_due ON tasks (due_on) WHERE status = 'open';
`;

const BLOG = `CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors (id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
) WITHOUT ROWID;

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX posts_published ON posts (published_at DESC) WHERE published_at IS NOT NULL;
CREATE INDEX comments_post ON comments (post_id);
`;

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'todo',
    title: 'Todo app',
    summary: 'Users, lists and tasks, the classic first SQLite app.',
    tableCount: 3,
    importFormat: 'ddl',
    source: TODO,
    areas: [{ name: 'Tasks', color: 'area-2', tables: ['lists', 'tasks'] }],
  },
  {
    id: 'blog',
    title: 'Blog',
    summary: 'Authors, posts, tags and comments.',
    tableCount: 5,
    importFormat: 'ddl',
    source: BLOG,
    areas: [
      { name: 'Content', color: 'area-5', tables: ['posts', 'tags', 'post_tags', 'comments'] },
      { name: 'People', color: 'area-1', tables: ['authors'] },
    ],
  },
];
