import { BadRequestException } from '@nestjs/common';

/**
 * Roadmap 14b §1 (`docs/phase14/DIRECTORY-SYNC.md`) — the pure half of SCIM 2.0 (RFC 7643/7644):
 * the `filter` subset Okta and Entra use, and PATCH operations in both their shapes, reduced
 * to plain change sets the service applies. No I/O here, so the recorded fixtures test it.
 */

export const SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

/** A 400 in the SCIM error shape (`ScimExceptionFilter` renders `scimType`). */
export const scimBadRequest = (scimType: string, detail: string): BadRequestException =>
  new BadRequestException({ code: 'scim_invalid', scimType, message: detail });

// -------------------------------------------------------------------------------- filter

export interface ScimFilter {
  /** lower-cased attribute name */
  readonly attribute: string;
  readonly value: string;
}

/**
 * `attr eq "value"` and nothing else: that is what Okta (`userName eq`) and Entra
 * (`userName eq`, `externalId eq`, `displayName eq`) send. Anything wider is a 400
 * `invalidFilter`, never a silently unfiltered list.
 */
export function parseFilter(raw: unknown, allowed: readonly string[]): ScimFilter | null {
  if (raw === undefined || raw === '') return null;
  const match =
    typeof raw === 'string'
      ? /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw)
      : null;
  const attribute = match?.[1]?.toLowerCase();
  if (match === null || attribute === undefined || !allowed.includes(attribute))
    throw scimBadRequest('invalidFilter', `Supported filters: ${allowed.join(', ')} eq "…"`);
  return { attribute, value: (match[2] ?? '').replace(/\\(.)/g, '$1') };
}

/** 1-based `startIndex` and `count` (RFC 7644 §3.4.2.4), clamped. */
export function parsePage(startIndex: unknown, count: unknown): { skip: number; take: number } {
  const int = (v: unknown, fallback: number) =>
    typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : fallback;
  const start = Math.max(1, int(startIndex, 1) || 1);
  const parsed = int(count, 100);
  const take = Math.min(200, Math.max(0, Number.isNaN(parsed) ? 100 : parsed));
  return { skip: start - 1, take };
}

// --------------------------------------------------------------------------------- PATCH

interface Operation {
  /** lower-cased: Entra sends `Replace`, Okta `replace` */
  readonly op: 'add' | 'replace' | 'remove';
  readonly path: string | undefined;
  readonly value: unknown;
}

function operations(body: unknown): Operation[] {
  const ops = (body as { Operations?: unknown } | null)?.Operations;
  if (!Array.isArray(ops)) throw scimBadRequest('invalidSyntax', 'Operations must be an array');
  return ops.map((raw: unknown) => {
    const o = (raw ?? {}) as { op?: unknown; path?: unknown; value?: unknown };
    const op = typeof o.op === 'string' ? o.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove')
      throw scimBadRequest('invalidSyntax', `Unsupported op: ${String(o.op)}`);
    return { op, path: typeof o.path === 'string' ? o.path : undefined, value: o.value };
  });
}

/** Entra sends booleans as `"True"`/`"False"`. */
function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value))
    return value.toLowerCase() === 'true';
  return undefined;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The primary email, or the first: `emails: [{ value, primary }]`. */
function emailOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return str(value);
  const list = value as { value?: unknown; primary?: unknown }[];
  return str((list.find((e) => e.primary === true) ?? list[0])?.value);
}

/** What a User PUT or PATCH asks for. Absent = unchanged. */
export interface UserChanges {
  active?: boolean;
  userName?: string;
  email?: string;
  externalId?: string;
  displayName?: string;
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

/** One `path → value` pair onto the change set. Unknown attributes are ignored (Entra
 *  sends title, department, addresses…): RFC 7644 lets a provider skip what it doesn't keep. */
function setUserAttribute(changes: UserChanges, path: string, value: unknown): void {
  const key = path.replace(new RegExp(`^${SCHEMA.user}:`, 'i'), '').toLowerCase();
  switch (key) {
    case 'active': {
      const active = bool(value);
      if (active === undefined) throw scimBadRequest('invalidValue', 'active must be a boolean');
      changes.active = active;
      return;
    }
    case 'username':
      changes.userName = str(value);
      return;
    case 'externalid':
      changes.externalId = str(value);
      return;
    case 'displayname':
      changes.displayName = str(value);
      return;
    case 'name.formatted':
      changes.formatted = str(value);
      return;
    case 'name.givenname':
      changes.givenName = str(value);
      return;
    case 'name.familyname':
      changes.familyName = str(value);
      return;
    case 'name': {
      const name = (value ?? {}) as Record<string, unknown>;
      for (const part of ['formatted', 'givenName', 'familyName'])
        if (part in name) setUserAttribute(changes, `name.${part}`, name[part]);
      return;
    }
    case 'emails':
      changes.email = emailOf(value);
      return;
    default:
      // `emails[type eq "work"].value` (Entra) and `emails[primary eq true].value`
      if (/^emails\[.*\]\.value$/.test(key)) changes.email = str(value);
  }
}

/** A full User resource (POST, PUT) as a change set. */
export function userResource(body: unknown): UserChanges {
  const changes: UserChanges = {};
  const resource = (body ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(resource)) setUserAttribute(changes, key, value);
  return changes;
}

/**
 * User PATCH. Okta: `{ op: "replace", value: { active: false } }` (no path). Entra:
 * `{ op: "Replace", path: "active", value: "False" }`. A `remove` clears nothing we keep
 * (a name or email can't be blank), so it is accepted and ignored.
 */
export function userPatch(body: unknown): UserChanges {
  const changes: UserChanges = {};
  for (const { op, path, value } of operations(body)) {
    if (op === 'remove') continue;
    if (path === undefined) {
      if (typeof value !== 'object' || value === null)
        throw scimBadRequest('invalidSyntax', 'A patch without a path needs an object value');
      for (const [key, inner] of Object.entries(value)) setUserAttribute(changes, key, inner);
    } else setUserAttribute(changes, path, value);
  }
  return changes;
}

/** The display name a change set implies, or `undefined` when it names none. */
export function nameOf(changes: UserChanges): string | undefined {
  const parts = [changes.givenName, changes.familyName].filter(Boolean).join(' ');
  return changes.displayName ?? changes.formatted ?? (parts === '' ? undefined : parts);
}

/** What a Group PUT or PATCH asks for. Member ids are SchemaLoom user ids. */
export interface GroupChanges {
  displayName?: string;
  externalId?: string;
  add: string[];
  remove: string[];
  /** set: the whole member list is this (PUT, `replace members`, `remove members` with no value) */
  replace?: string[];
}

function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list
    .map((m: unknown) => str((m as { value?: unknown } | null)?.value))
    .filter((id): id is string => id !== undefined);
}

/** A full Group resource (POST, PUT) as a change set. */
export function groupResource(body: unknown): GroupChanges {
  const resource = (body ?? {}) as Record<string, unknown>;
  return {
    displayName: str(resource.displayName),
    externalId: str(resource.externalId),
    add: [],
    remove: [],
    replace: memberIds(resource.members),
  };
}

/**
 * Group PATCH, both vendors:
 * - Okta: `{ op: "add", path: "members", value: [{ value }] }`,
 *   `{ op: "remove", path: "members[value eq \"id\"]" }`,
 *   `{ op: "replace", value: { id, displayName } }`.
 * - Entra: `{ op: "Add" | "Remove", path: "members", value: [{ value }] }`,
 *   `{ op: "Replace", path: "displayName", value: "…" }`.
 */
export function groupPatch(body: unknown): GroupChanges {
  const changes: GroupChanges = { add: [], remove: [] };
  const setReplace = (ids: string[]) => {
    changes.replace = ids;
    changes.add = [];
    changes.remove = [];
  };
  for (const { op, path, value } of operations(body)) {
    const key = path?.toLowerCase();
    const filtered =
      path === undefined ? null : /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (filtered !== null) {
      if (op !== 'remove') throw scimBadRequest('invalidPath', `Unsupported path: ${path ?? ''}`);
      changes.remove.push(filtered[1] ?? '');
    } else if (key === 'members') {
      const ids = memberIds(value);
      if (op === 'add') changes.add.push(...ids);
      else if (op === 'replace') setReplace(ids);
      else if (ids.length > 0) changes.remove.push(...ids);
      else setReplace([]);
    } else if (key === 'displayname') {
      if (op !== 'remove') changes.displayName = str(value);
    } else if (key === 'externalid') {
      if (op !== 'remove') changes.externalId = str(value);
    } else if (key === undefined) {
      if (op === 'remove' || typeof value !== 'object' || value === null)
        throw scimBadRequest('invalidSyntax', 'A patch without a path needs an object value');
      const v = value as Record<string, unknown>;
      if ('displayName' in v) changes.displayName = str(v.displayName);
      if ('externalId' in v) changes.externalId = str(v.externalId);
      if ('members' in v) {
        if (op === 'add') changes.add.push(...memberIds(v.members));
        else setReplace(memberIds(v.members));
      }
    } else throw scimBadRequest('invalidPath', `Unsupported path: ${path ?? ''}`);
  }
  return changes;
}
