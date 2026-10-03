'use client';

import {
  CONSTRAINT_KIND_PRIMARY_KEY,
  type Constraint,
  type Entity,
  type Field,
  type Id,
  type SchemaModel,
  type TypeRef,
} from '@schemaloom/schema-model';
import { Button, X } from '@schemaloom/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEngine, useEngineUi, useTerminology } from '@/engines';
import { irQueryKey } from '@/features/canvas/ir-query';
import { postOps } from '@/features/canvas/schema-ops';
import { ApiError } from '@/lib/api-client';

/**
 * The column editor: every edit is one op batch through `/schema/ops` (§8.2) carrying the
 * version the row was rendered from (C7), followed by an IR refetch.
 *
 * A row is disabled while its write is in flight. The next edit needs the version the
 * refetch brings back, and sending it early would 409 against our own previous write.
 *
 * ponytail: refetch-then-edit, no optimistic update; add one when realtime lands.
 */

const inputClass =
  'h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-xs text-text transition-colors hover:border-border-strong focus:border-accent-border disabled:opacity-50';

/** Nest's default messages ("Conflict Exception") say nothing; the codes do. */
function message(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Could not save. Try again.';
  if (caught.status === 409) return 'Someone else changed this. It has been refreshed; try again.';
  if (caught.code === 'duplicate_name') return 'That name is already used here.';
  if (caught.status === 403 || caught.status === 404)
    return 'You do not have permission to edit this.';
  return caught.message.endsWith('Exception') ? 'Could not save. Try again.' : caught.message;
}

/** One write at a time, with its error kept for display. */
function useOps(projectId: Id) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (ops: readonly unknown[]): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await postOps(queryClient, projectId, ops);
        return true;
      } catch (caught) {
        setError(message(caught));
        // A 409 means our copy is stale; refetch so the next attempt carries the new version.
        await queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [queryClient, projectId],
  );
  return { run, busy, error };
}

function primaryKeyOf(model: SchemaModel, entityId: Id): Constraint | undefined {
  return Object.values(model.objects.constraint).find(
    (c) => c.entityId === entityId && c.kind === CONSTRAINT_KIND_PRIMARY_KEY,
  );
}

function sameType(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A name input that commits on Enter or blur, and resets when the server copy changes. */
function NameInput({
  value,
  version,
  disabled,
  label,
  onCommit,
  title = false,
}: {
  readonly value: string;
  readonly version: number;
  /** The entity's own name, set as the inspector's title rather than as a field. */
  readonly title?: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value, version]);
  const commit = () => {
    const next = draft.trim();
    if (next === '' || next === value) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };
  return (
    <input
      aria-label={label}
      className={
        title
          ? 'h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[15px] font-semibold tracking-tight text-text transition-colors hover:border-border focus:border-accent-border disabled:opacity-50'
          : `${inputClass} flex-1 font-mono`
      }
      maxLength={255}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

export function ColumnRow({
  projectId,
  model,
  entity,
  field,
}: {
  readonly projectId: Id;
  readonly model: SchemaModel;
  readonly entity: Entity;
  readonly field: Field;
}) {
  const facet = useEngine();
  const { TypePicker } = useEngineUi();
  const t = useTerminology();
  const { run, busy, error } = useOps(projectId);

  const ctx = useMemo(
    () => ({
      customTypes: Object.values(model.objects.customType),
      namespaceName: model.objects.namespace[entity.namespaceId]?.name ?? null,
    }),
    [model, entity.namespaceId],
  );
  const options = useMemo(() => facet.typeCatalog.listPickerOptions(ctx), [facet, ctx]);

  // The type picker emits on every keystroke of `varchar(2…5…5)`; hold the draft and send
  // it once the user pauses, so one edit is one version bump.
  const [typeDraft, setTypeDraft] = useState<TypeRef>(field.type);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setTypeDraft(field.type);
  }, [field.type, field.version]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const pk = primaryKeyOf(model, entity.id);
  const supportsPk = facet.capabilities.constraintKinds.some(
    (k) => k.id === CONSTRAINT_KIND_PRIMARY_KEY,
  );
  const inPk = pk?.fieldIds.includes(field.id) === true;

  if (field.restricted === true) {
    return <li className="px-1 py-1 text-xs text-text-subtle">restricted</li>;
  }

  const update = (patch: Partial<Field>) =>
    run([{ op: 'update', type: 'field', id: field.id, expectedVersion: field.version, patch }]);

  const togglePk = (on: boolean) => {
    const ops: unknown[] = [];
    if (on) {
      // A primary-key column is NOT NULL; say so in the same gesture.
      if (field.isNullable) {
        ops.push({
          op: 'update',
          type: 'field',
          id: field.id,
          expectedVersion: field.version,
          patch: { isNullable: false },
        });
      }
      ops.push(
        pk === undefined
          ? {
              op: 'create',
              type: 'constraint',
              object: {
                id: crypto.randomUUID(),
                name: '',
                engineProps: {},
                entityId: entity.id,
                kind: CONSTRAINT_KIND_PRIMARY_KEY,
                fieldIds: [field.id],
              },
            }
          : {
              op: 'update',
              type: 'constraint',
              id: pk.id,
              expectedVersion: pk.version,
              patch: { fieldIds: [...pk.fieldIds, field.id] },
            },
      );
    } else if (pk !== undefined) {
      const rest = pk.fieldIds.filter((id) => id !== field.id);
      ops.push(
        rest.length === 0
          ? { op: 'delete', type: 'constraint', id: pk.id, expectedVersion: pk.version }
          : {
              op: 'update',
              type: 'constraint',
              id: pk.id,
              expectedVersion: pk.version,
              patch: { fieldIds: rest },
            },
      );
    }
    if (ops.length > 0) void run(ops);
  };

  const resolved = facet.typeCatalog.resolve(typeDraft, ctx);

  return (
    // Studio: soft cards. Blueprint and Compact: ruled rows. Float: wells without edges.
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-2 theme-blueprint:rounded-none theme-blueprint:border-x-0 theme-blueprint:border-t-0 theme-blueprint:bg-transparent theme-blueprint:px-0 theme-float:border-transparent theme-float:bg-surface-sunken theme-compact:rounded-none theme-compact:border-x-0 theme-compact:border-t-0 theme-compact:bg-transparent theme-compact:px-0 theme-compact:py-1.5">
      <div className="flex items-center gap-1">
        <NameInput
          label={t.msg('action.rename', 'field')}
          value={field.name}
          version={field.version}
          disabled={busy}
          onCommit={(name) => void update({ name })}
        />
        <button
          type="button"
          aria-label={t.msg('action.delete', 'field')}
          title={t.msg('action.delete', 'field')}
          disabled={busy}
          className="rounded p-1 text-text-subtle hover:bg-surface-hover hover:text-danger-text disabled:opacity-50"
          onClick={() => {
            void run([
              { op: 'delete', type: 'field', id: field.id, expectedVersion: field.version },
            ]);
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {TypePicker === undefined ? (
        <p className="font-mono text-xs text-text-muted">{resolved.display}</p>
      ) : (
        <TypePicker
          value={typeDraft}
          options={options}
          resolved={resolved}
          disabled={busy}
          onChange={(next) => {
            setTypeDraft(next);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              if (!sameType(next, field.type)) void update({ type: next });
            }, 600);
          }}
        />
      )}
      <div className="flex gap-3 text-xs text-text-muted">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            disabled={busy || inPk}
            checked={field.isNullable}
            onChange={(e) => void update({ isNullable: e.target.checked })}
          />
          Nullable
        </label>
        {supportsPk ? (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              disabled={busy}
              checked={inPk}
              onChange={(e) => {
                togglePk(e.target.checked);
              }}
            />
            Primary key
          </label>
        ) : null}
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </li>
  );
}

export function EntityEditor({
  projectId,
  model,
  entity,
}: {
  readonly projectId: Id;
  readonly model: SchemaModel;
  readonly entity: Entity;
}) {
  const facet = useEngine();
  const t = useTerminology();
  const entityOps = useOps(projectId);
  const addOps = useOps(projectId);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fields = Object.values(model.objects.field)
    .filter((f) => f.entityId === entity.id && f.parentFieldId === null)
    .sort((a, b) => a.ordinal - b.ordinal);
  const kind = facet.capabilities.entityKinds.find((k) => k.id === entity.kind);

  const addField = () => {
    const name = newName.trim();
    const ctx = {
      customTypes: Object.values(model.objects.customType),
      namespaceName: model.objects.namespace[entity.namespaceId]?.name ?? null,
    };
    // The engine orders its own picker; its first entry is the default until the user picks.
    const type = facet.typeCatalog.listPickerOptions(ctx)[0]?.value;
    if (name === '' || type === undefined) return;
    void addOps
      .run([
        {
          op: 'create',
          type: 'field',
          object: {
            id: crypto.randomUUID(),
            name,
            engineProps: {},
            entityId: entity.id,
            parentFieldId: null,
            type,
            isNullable: true,
            isRestricted: false,
            isPii: false,
            isDeprecated: false,
          },
        },
      ])
      .then((ok) => {
        if (ok) setNewName('');
      });
  };

  return (
    <div className="space-y-3 p-2">
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <NameInput
            label={t.msg('action.rename', 'entity')}
            title
            value={entity.name}
            version={entity.version}
            disabled={entityOps.busy}
            onCommit={(name) =>
              void entityOps.run([
                {
                  op: 'update',
                  type: 'entity',
                  id: entity.id,
                  expectedVersion: entity.version,
                  patch: { name },
                },
              ])
            }
          />
        </div>
        {entityOps.error !== null && (
          <p role="alert" className="text-xs text-danger-text">
            {entityOps.error}
          </p>
        )}
        {entity.propsRedacted === true ? (
          <p className="text-xs text-text-subtle">Some properties are hidden from you.</p>
        ) : null}
      </div>

      {kind?.hasFields === false ? null : (
        <>
          <h3 className="flex items-baseline gap-1.5 text-xs font-semibold text-text-muted">
            {t.term('field').other}
            <span className="font-mono font-normal text-text-subtle">{fields.length}</span>
          </h3>
          <ul className="space-y-1.5">
            {fields.map((field) => (
              <ColumnRow
                key={field.id}
                projectId={projectId}
                model={model}
                entity={entity}
                field={field}
              />
            ))}
          </ul>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              addField();
            }}
          >
            <input
              aria-label={t.msg('action.add', 'field')}
              placeholder={t.msg('action.add', 'field')}
              className={`${inputClass} flex-1 font-mono`}
              maxLength={255}
              disabled={addOps.busy}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
              }}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={addOps.busy || newName.trim() === ''}
            >
              Add
            </Button>
          </form>
          {addOps.error !== null && (
            <p role="alert" className="text-xs text-danger-text">
              {addOps.error}
            </p>
          )}
        </>
      )}

      <div className="border-t border-border pt-2">
        {confirmDelete ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-text-muted">Also removes its links.</span>
            <Button
              variant="danger"
              size="sm"
              disabled={entityOps.busy}
              onClick={() => {
                void entityOps.run([
                  { op: 'delete', type: 'entity', id: entity.id, expectedVersion: entity.version },
                ]);
              }}
            >
              {t.msg('action.delete', 'entity')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger-text"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            {t.msg('action.delete', 'entity')}
          </Button>
        )}
      </div>
    </div>
  );
}
