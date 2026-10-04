'use client';

import { cn } from '@schemaloom/ui';
import { ancestorChain, decidingOwnGrant } from './effective';
import { INERT_ORG_ADMIN_LABEL, isInertGrant, toggleState } from './grant-warnings';
import {
  AI_ATOM,
  RESTRICTED_ATOM,
  type AccessEntry,
  type ResourceNode,
  type RoleOption,
  type ToggleAtom,
} from './model';
import { grantLevelLabel, type ResourceNoun } from './resource-noun';

/**
 * One person (or group, or pending invite) in the "Who has access" list.
 *
 * Hook-free on purpose — `noun` is passed in rather than pulled from `useTerminology()`,
 * so this renders in a test without an `<EngineProvider>`, the same split the canvas uses
 * for `EntityBody`.
 *
 * A native `<select>` for the role. Radix's Select portals its options, which buys a
 * styled menu and costs server-rendered text; the role is a five-item list of words and
 * the platform control is already keyboard- and screen-reader-correct.
 */
export interface GrantRowProps {
  readonly entry: AccessEntry;
  readonly scope: ResourceNode;
  readonly resources: readonly ResourceNode[];
  readonly roles: readonly RoleOption[];
  readonly noun: ResourceNoun;
  readonly readOnly?: boolean;
  readonly onRoleChange: (roleKey: string) => void;
  readonly onToggle: (atom: ToggleAtom, on: boolean) => void;
  readonly onRemove: () => void;
}

export function GrantRow({
  entry,
  scope,
  resources,
  roles,
  noun,
  readOnly = false,
  onRoleChange,
  onToggle,
  onRemove,
}: GrantRowProps) {
  const inert = isInertGrant(entry);
  const chain = ancestorChain(resources, scope);
  const deciding = decidingOwnGrant(entry, chain);
  const direct = deciding?.resourceId === scope.id ? deciding : undefined;
  // An archived custom role is not offered by the picker but still decides existing
  // grants; show it as the current value rather than silently showing roles[0].
  const options =
    deciding !== undefined && !roles.some((option) => option.key === deciding.roleKey)
      ? [
          ...roles,
          {
            key: deciding.roleKey,
            name: `${deciding.roleName} (archived)`,
            atoms: deciding.atoms,
            builtIn: false,
          },
        ]
      : roles;
  const role = options.find((option) => option.key === deciding?.roleKey) ?? options[0];
  // A grant this principal holds higher up the chain. Editing it here would silently
  // create a NARROWING grant, so the toggles stay read-only until a role is set at this
  // scope and the row says where the access actually comes from.
  const inheritedFrom = direct === undefined ? deciding : undefined;

  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 border-b border-border py-2 last:border-b-0',
        inert && 'opacity-70',
      )}
      data-inert={inert ? 'true' : undefined}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm text-text', inert && 'line-through')}>
            {entry.principal.label}
            {entry.principal.kind === 'group' && (
              <span className="ml-1.5 rounded bg-surface-sunken px-1 text-[10px] text-text-subtle">
                Group
              </span>
            )}
            {entry.principal.kind === 'email_invite' && (
              <span className="ml-1.5 rounded bg-surface-sunken px-1 text-[10px] text-text-subtle">
                Invite pending
              </span>
            )}
          </p>
          {entry.email !== null && entry.principal.kind !== 'email_invite' && (
            <p className="truncate text-xs text-text-subtle">{entry.email}</p>
          )}
        </div>

        <select
          aria-label={`Role for ${entry.principal.label}`}
          className={cn(
            'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-50',
            inert && 'line-through',
          )}
          disabled={readOnly || inert}
          value={role?.key ?? ''}
          onChange={(event) => {
            onRoleChange(event.target.value);
          }}
        >
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="rounded-sm px-2 py-1 text-xs text-text-subtle hover:text-danger-text disabled:opacity-50"
          disabled={readOnly || direct === undefined}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      {inert ? (
        <p className="text-xs text-warning-text">{INERT_ORG_ADMIN_LABEL}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <GrantToggle
            label="Use AI"
            atom={AI_ATOM}
            role={role}
            on={direct?.canUseAi ?? false}
            lockedNote={
              inheritedFrom === undefined
                ? null
                : `inherited from ${grantLevelLabel(noun, inheritedFrom)}`
            }
            readOnly={readOnly}
            onToggle={onToggle}
          />
          <GrantToggle
            label="View restricted fields"
            atom={RESTRICTED_ATOM}
            role={role}
            on={direct?.canViewRestricted ?? false}
            lockedNote={inheritedFrom === undefined ? null : 'set at the level it comes from'}
            readOnly={readOnly}
            onToggle={onToggle}
          />
        </div>
      )}

      {entry.grants.length > 0 && (
        <details className="text-xs text-text-subtle">
          <summary className="cursor-pointer">Why</summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {entry.grants.map((grant) => (
              <li key={`${grant.id}-${grant.resourceId}`}>
                {grant.roleName} on {grantLevelLabel(noun, grant)}
                {grant.principal.kind === 'group' && ` via the group ${grant.principal.label}`}
                {grant.resourceId === deciding?.resourceId && ' — deciding level'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/**
 * ADDITIVE ONLY. A toggle whose atom the role already carries renders checked and
 * disabled with the reason — unchecking it would not have removed the atom, and a box
 * that appears to turn off a permission it cannot turn off is worse than no box.
 */
function GrantToggle({
  label,
  atom,
  role,
  on,
  lockedNote,
  readOnly,
  onToggle,
}: {
  readonly label: string;
  readonly atom: ToggleAtom;
  readonly role: RoleOption | undefined;
  readonly on: boolean;
  readonly lockedNote: string | null;
  readonly readOnly: boolean;
  readonly onToggle: (atom: ToggleAtom, on: boolean) => void;
}) {
  const state =
    role === undefined ? { checked: on, disabled: true, note: null } : toggleState(role, atom, on);
  const disabled = state.disabled || readOnly || lockedNote !== null;
  const note = state.note ?? (lockedNote !== null && !state.disabled ? lockedNote : null);

  return (
    <label className="flex items-center gap-1.5 text-xs text-text-muted">
      <input
        type="checkbox"
        className="size-3.5 accent-accent"
        checked={state.checked}
        disabled={disabled}
        onChange={(event) => {
          onToggle(atom, event.target.checked);
        }}
      />
      {label}
      {note !== null && <span className="text-text-subtle">({note})</span>}
    </label>
  );
}
