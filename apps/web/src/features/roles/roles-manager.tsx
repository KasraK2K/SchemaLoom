'use client';

import { PERMISSION_ATOMS, closeAtoms, type PermissionAtom } from '@schemaloom/contracts';
import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { RoleView } from './roles-api';

/**
 * Doc 05 §4 — the org's custom roles. Every write goes to the API, which re-applies
 * V1-V4; the checkboxes here only show R1's closure (every atom implies `schema:view`)
 * before the save rather than after it.
 *
 * After a write the Server Component re-renders (`router.refresh()`), so the list on
 * screen is always the API's, never a local copy that drifted.
 */
const ATOM_LABELS: Record<PermissionAtom, string> = {
  'schema:view': 'View the schema',
  'schema:edit': 'Edit the schema',
  'docs:edit': 'Edit docs',
  'comment:create': 'Comment',
  'ai:use': 'Use AI',
  'export:run': 'Export',
  'history:view': 'View history',
  'sharing:manage': 'Manage sharing',
  'field:viewRestricted': 'View restricted fields',
};

/** The stored array is a network payload; an atom this build does not know shows raw. */
function labelOf(atom: string): string {
  return (ATOM_LABELS as Partial<Record<string, string>>)[atom] ?? atom;
}

function messageOf(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.code === 'role_in_use') {
    const grants = (error.details as { grants?: number } | undefined)?.grants ?? 0;
    return `This role is used by ${String(grants)} grant${grants === 1 ? '' : 's'}. Archive it instead: existing access keeps working and nobody new can be given it.`;
  }
  if (error.code === 'role_name_taken') return 'Another role already has that name.';
  if (error.code === 'empty_role') return 'Pick at least one permission.';
  return error.message;
}

export function RolesManager({
  orgSlug,
  roles,
}: {
  readonly orgSlug: string;
  readonly roles: readonly RoleView[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<RoleView | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/organizations/${encodeURIComponent(orgSlug)}/roles`;

  const run = async (write: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await write();
      router.refresh();
      return true;
    } catch (caught) {
      setError(messageOf(caught));
      return false;
    }
  };

  const builtIns = roles.filter((role) => role.builtIn);
  const custom = roles.filter((role) => !role.builtIn);

  return (
    <div className="flex flex-col gap-6">
      {error !== null && (
        <p role="alert" className="rounded-md border border-danger px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Custom roles</h2>
          {editing === null && (
            <Button size="sm" onClick={() => { setEditing('new'); }}>
              New role
            </Button>
          )}
        </div>
        {editing === 'new' && (
          <RoleForm
            onCancel={() => { setEditing(null); }}
            onSave={async (body) => {
              if (await run(() => apiFetch(base, { method: 'POST', body }))) setEditing(null);
            }}
          />
        )}
        {custom.length === 0 && editing !== 'new' && (
          <p className="text-sm text-text-subtle">No custom roles yet.</p>
        )}
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {custom.map((role) =>
            editing !== null && editing !== 'new' && editing.id === role.id ? (
              <li key={role.id} className="p-3">
                <RoleForm
                  initial={role}
                  onCancel={() => { setEditing(null); }}
                  onSave={async (body) => {
                    if (await run(() => apiFetch(`${base}/${role.id}`, { method: 'PATCH', body }))) setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={role.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text">
                    {role.name}
                    {role.archived && (
                      <span className="ml-1.5 rounded bg-surface-sunken px-1 text-[10px] text-text-subtle">
                        Archived
                      </span>
                    )}
                  </p>
                  {role.description !== null && <p className="text-xs text-text-muted">{role.description}</p>}
                  <p className="mt-1 text-xs text-text-subtle">
                    {role.atoms.map(labelOf).join(', ')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(role); }}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void run(() => apiFetch(`${base}/${role.id}`, { method: 'PATCH', body: { archived: !role.archived } }));
                    }}
                  >
                    {role.archived ? 'Unarchive' : 'Archive'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`Delete the role "${role.name}"?`)) {
                        void run(() => apiFetch(`${base}/${role.id}`, { method: 'DELETE' }));
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-text">Built-in roles</h2>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {builtIns.map((role) => (
            <li key={role.id} className="p-3">
              <p className="text-sm text-text">{role.name}</p>
              <p className="mt-1 text-xs text-text-subtle">
                {role.atoms.map(labelOf).join(', ')}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface RoleBody {
  name: string;
  description: string | null;
  atoms: PermissionAtom[];
}

function RoleForm({
  initial,
  onSave,
  onCancel,
}: {
  readonly initial?: RoleView;
  readonly onSave: (body: RoleBody) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [picked, setPicked] = useState<Set<PermissionAtom>>(new Set(initial?.atoms as PermissionAtom[] | undefined));
  const [pending, setPending] = useState(false);
  const closed = closeAtoms(picked);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setPending(true);
    await onSave({ name: name.trim(), description: description.trim() === '' ? null : description.trim(), atoms: [...closed] });
    setPending(false);
  };

  return (
    <form className="flex flex-col gap-3 rounded-md border border-border p-3" onSubmit={(event) => { void submit(event); }}>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Name
        <input
          required
          maxLength={80}
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={name}
          onChange={(event) => { setName(event.target.value); }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Description
        <input
          maxLength={500}
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={description}
          onChange={(event) => { setDescription(event.target.value); }}
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-text-muted">Permissions</legend>
        {PERMISSION_ATOMS.map((atom) => {
          // R1: any permission implies viewing the schema, so that box locks on.
          const implied = atom === 'schema:view' && closed.has(atom) && [...picked].some((a) => a !== atom);
          return (
            <label key={atom} className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                className="size-3.5 accent-accent"
                checked={closed.has(atom)}
                disabled={implied}
                onChange={(event) => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(atom);
                  else next.delete(atom);
                  setPicked(next);
                }}
              />
              {ATOM_LABELS[atom]}
              {implied && <span className="text-xs text-text-subtle">(implied by the others)</span>}
            </label>
          );
        })}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || name.trim() === '' || closed.size === 0}>
          {initial === undefined ? 'Create role' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
