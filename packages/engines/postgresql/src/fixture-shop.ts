import type { SchemaModel } from '@schemaloom/engine-sdk';
import {
  column,
  constraint,
  customType,
  index,
  indexColumn,
  link,
  model,
  ns,
  table,
} from './fixture-model.js';

/** Phase 7 (`docs/phase7/DESIGN.md` §3): one model that touches every row of the mapping. */
export function shopModel(): SchemaModel {
  const id = (entityId: string, name: string, type: string, extra = {}) =>
    column({
      id: `${entityId}.${name}`,
      name,
      entityId,
      type: { name: type },
      isNullable: false,
      ...extra,
    });
  return model({
    namespaces: [
      ns({ id: 'public', name: 'public', isDefault: true }),
      ns({ id: 'sales', name: 'sales' }),
    ],
    customTypes: [
      customType({
        id: 'ct_role',
        name: 'user_role',
        engineProps: { labels: ['member', 'admin', 'super-admin'] },
      }),
      customType({
        id: 'ct_email',
        name: 'email',
        kind: 'domain',
        engineProps: { baseType: 'varchar(320)' },
      }),
    ],
    entities: [
      table({ id: 'users', name: 'users', doc: { id: 'd1', excerpt: 'People who sign in' } }),
      table({ id: 'posts', name: 'posts' }),
      table({ id: 'profiles', name: 'profiles' }),
      table({ id: 'audit', name: 'audit_log' }),
      table({ id: 'invoices', name: 'invoices', namespaceId: 'sales' }),
      table({
        id: 'v',
        name: 'recent_posts',
        kind: 'view',
        engineProps: { viewDefinition: 'SELECT 1' },
      }),
    ],
    fields: [
      id('users', 'id', 'uuid', { engineProps: { default: 'gen_random_uuid()' } }),
      id('users', 'email', 'email', {
        ordinal: 1,
        type: { name: 'email', customTypeId: 'ct_email' },
      }),
      column({
        id: 'users.name',
        name: 'name',
        entityId: 'users',
        ordinal: 2,
        type: { name: 'text' },
        doc: { id: 'd2', excerpt: 'Shown "as is"' },
      }),
      column({
        id: 'users.tags',
        name: 'tags',
        entityId: 'users',
        ordinal: 3,
        type: { name: 'text', dimensions: 1 },
      }),
      id('users', 'role', 'user_role', {
        ordinal: 4,
        type: { name: 'user_role', customTypeId: 'ct_role' },
        engineProps: { default: "'member'::user_role" },
      }),
      id('users', 'balance', 'numeric', {
        ordinal: 5,
        type: { name: 'numeric', args: [12, 2] },
        engineProps: { default: '0' },
      }),
      id('users', 'created_at', 'timestamptz', { ordinal: 6, engineProps: { default: 'now()' } }),
      column({
        id: 'users.display',
        name: 'Display Name',
        entityId: 'users',
        ordinal: 7,
        type: { name: 'varchar', args: [80] },
      }),
      column({
        id: 'users.manager',
        name: 'manager_id',
        entityId: 'users',
        ordinal: 8,
        type: { name: 'uuid' },
      }),
      column({
        id: 'users.span',
        name: 'active',
        entityId: 'users',
        ordinal: 9,
        type: { name: 'tstzrange' },
      }),
      // Nullable on purpose: that is what an import of an inline `PRIMARY KEY` produces.
      id('posts', 'id', 'bigserial', { isNullable: true }),
      id('posts', 'author_id', 'uuid', { ordinal: 1 }),
      column({
        id: 'posts.editor_id',
        name: 'editor_id',
        entityId: 'posts',
        ordinal: 2,
        type: { name: 'uuid' },
      }),
      column({
        id: 'posts.body',
        name: 'body',
        entityId: 'posts',
        ordinal: 3,
        type: { name: 'jsonb' },
      }),
      id('posts', 'status', 'smallint', { ordinal: 4, engineProps: { default: '1' } }),
      id('posts', 'title', 'text', {
        ordinal: 5,
        engineProps: { default: "'Untitled ''draft'''::text" },
      }),
      id('profiles', 'user_id', 'uuid'),
      column({
        id: 'profiles.bio',
        name: 'bio',
        entityId: 'profiles',
        ordinal: 1,
        type: { name: 'text' },
      }),
      column({ id: 'audit.at', name: 'at', entityId: 'audit', type: { name: 'timestamp' } }),
      id('invoices', 'id', 'integer', { engineProps: { identity: 'always' } }),
    ],
    constraints: [
      constraint({
        id: 'pk_u',
        name: 'users_pkey',
        entityId: 'users',
        kind: 'primaryKey',
        fieldIds: ['users.id'],
      }),
      constraint({
        id: 'uq_e',
        name: 'users_email_key',
        entityId: 'users',
        kind: 'unique',
        fieldIds: ['users.email'],
      }),
      constraint({
        id: 'ck_b',
        name: 'users_balance_check',
        entityId: 'users',
        kind: 'check',
        engineProps: { expression: 'balance >= 0' },
      }),
      constraint({
        id: 'pk_p',
        name: 'posts_pk',
        entityId: 'posts',
        kind: 'primaryKey',
        fieldIds: ['posts.id'],
      }),
      constraint({
        id: 'pk_pr',
        name: 'profiles_pkey',
        entityId: 'profiles',
        kind: 'primaryKey',
        fieldIds: ['profiles.user_id'],
      }),
      constraint({
        id: 'pk_i',
        name: 'invoices_pkey',
        entityId: 'invoices',
        kind: 'primaryKey',
        fieldIds: ['invoices.id'],
      }),
    ],
    indexes: [
      index({
        id: 'ix1',
        name: 'posts_author_id_idx',
        entityId: 'posts',
        columns: [indexColumn({ fieldId: 'posts.author_id' })],
      }),
      index({
        id: 'ix2',
        name: 'posts_body_gin',
        entityId: 'posts',
        kind: 'gin',
        columns: [indexColumn({ fieldId: 'posts.body' })],
      }),
      index({
        id: 'ix3',
        name: 'posts_status_title_idx',
        entityId: 'posts',
        columns: [
          indexColumn({ fieldId: 'posts.status', direction: 'desc' }),
          indexColumn({ ordinal: 1, fieldId: 'posts.title' }),
        ],
      }),
      index({
        id: 'ix4',
        name: 'users_lower_email',
        entityId: 'users',
        isUnique: true,
        columns: [indexColumn({ expression: 'lower(email)' })],
      }),
      index({
        id: 'ix5',
        name: 'posts_title_status_key',
        entityId: 'posts',
        isUnique: true,
        columns: [
          indexColumn({ fieldId: 'posts.title' }),
          indexColumn({ ordinal: 1, fieldId: 'posts.status' }),
        ],
      }),
    ],
    links: [
      link({
        id: 'l1',
        name: 'posts_author_id_fkey',
        from: { entityId: 'posts', fieldIds: ['posts.author_id'] },
        to: { entityId: 'users', fieldIds: ['users.id'] },
        engineProps: { onDelete: 'cascade' },
      }),
      link({
        id: 'l2',
        name: 'posts_editor_id_fkey',
        from: { entityId: 'posts', fieldIds: ['posts.editor_id'] },
        to: { entityId: 'users', fieldIds: ['users.id'] },
        engineProps: { onDelete: 'setNull', onUpdate: 'cascade' },
      }),
      link({
        id: 'l3',
        name: 'profiles_user_id_fkey',
        from: { entityId: 'profiles', fieldIds: ['profiles.user_id'] },
        to: { entityId: 'users', fieldIds: ['users.id'] },
      }),
      link({
        id: 'l4',
        name: 'users_manager_fk',
        from: { entityId: 'users', fieldIds: ['users.manager'] },
        to: { entityId: 'users', fieldIds: ['users.id'] },
      }),
    ],
  });
}
