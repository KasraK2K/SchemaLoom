'use client';

import type { Entity, Field, Id, Link } from '@schemaloom/schema-model';
import { TabsContent, X } from '@schemaloom/ui';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useEngine, useEngineUi, useTerminology } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { projectShellQueryOptions } from '@/features/change-requests/change-requests-api';
import { deleteLinkOp, postOps } from '@/features/canvas/schema-ops';
import { ColumnRow, EntityEditor } from './column-editor';
import { useCanvasStore } from '@/features/canvas/store';

/**
 * What the canvas selection is, in words.
 *
 * The entity and field tabs edit through `column-editor.tsx` (core IR only: names, types,
 * nullability, primary key). The engine's `PropertyPanelSection`s for `engineProps` are
 * still not mounted; they need the same ops path wired to their `onChange`.
 *
 * Nouns come from `useTerminology`: "Select a table to see its details" for PostgreSQL,
 * "Select a collection…" for MongoDB, from one string in the core catalogue.
 */
export function InspectorBody({ projectId }: { readonly projectId: Id }) {
  const { data: model } = useSuspenseQuery(irQueryOptions(projectId));
  const facet = useEngine();
  const t = useTerminology();
  const selection = useCanvasStore((state) => state.selection);
  const selectedFieldId = useCanvasStore((state) => state.selectedFieldId);
  // Phase 10c §1: a protected project shows details, not editors, for everyone. Read-only
  // until the shell answers, as the canvas is.
  const shell = useQuery(projectShellQueryOptions(projectId));
  const readOnly = !shell.isError && shell.data?.requireChangeRequests !== false;

  const only = selection.size === 1 ? [...selection][0] : undefined;
  const entity = only === undefined ? undefined : model.objects.entity[only];
  const field = selectedFieldId === null ? undefined : model.objects.field[selectedFieldId];
  const links =
    entity === undefined
      ? []
      : Object.values(model.objects.link).filter(
          (link) => link.from.entityId === entity.id || link.to.entityId === entity.id,
        );

  const fieldCount =
    entity === undefined
      ? 0
      : Object.values(model.objects.field).filter((f) => f.entityId === entity.id).length;

  const kindLabel = facet.capabilities.entityKinds.find((k) => k.id === entity?.kind)?.id ?? null;

  return (
    <>
      <TabsContent value="entity" className="space-y-2 overflow-auto text-sm">
        {selection.size === 0 ? (
          <Empty text={t.msg('inspector.noSelection', 'entity')} />
        ) : entity === undefined ? (
          <Empty text={t.msg('list.count', 'entity', { count: selection.size })} />
        ) : (
          <>
            {kindLabel === null ? null : (
              <p className="px-2 text-xs text-text-subtle">{kindLabel}</p>
            )}
            {entity.restricted === true || readOnly ? (
              <EntityDetails entity={entity} kindLabel={kindLabel} fieldCount={fieldCount} />
            ) : (
              <EntityEditor projectId={projectId} model={model} entity={entity} />
            )}
          </>
        )}
      </TabsContent>

      <TabsContent value="field" className="space-y-2 overflow-auto text-sm">
        {field === undefined ? (
          <Empty text={t.msg('inspector.noSelection', 'field')} />
        ) : entity === undefined ||
          field.restricted === true ||
          entity.restricted === true ||
          readOnly ? (
          <FieldDetails field={field} />
        ) : (
          <ul className="p-2">
            <ColumnRow projectId={projectId} model={model} entity={entity} field={field} />
          </ul>
        )}
      </TabsContent>

      <TabsContent value="link" className="space-y-2 overflow-auto text-sm">
        {links.length === 0 ? (
          <Empty text={t.msg('list.empty', 'link')} />
        ) : (
          <ul className="space-y-1">
            {links.map((link) => (
              <LinkRow
                key={link.id}
                projectId={projectId}
                link={link}
                entities={model.objects.entity}
                readOnly={readOnly}
              />
            ))}
          </ul>
        )}
      </TabsContent>
    </>
  );
}

const Empty = ({ text }: { readonly text: string }) => (
  <p className="p-2 text-sm text-text-muted">{text}</p>
);

/** A restricted object is named nowhere — same rule as the canvas stub. */
const Restricted = () => <p className="p-2 text-sm text-text-subtle">restricted</p>;

function EntityDetails({
  entity,
  kindLabel,
  fieldCount,
}: {
  readonly entity: Entity;
  readonly kindLabel: string | null;
  readonly fieldCount: number;
}) {
  const t = useTerminology();
  if (entity.restricted === true) return <Restricted />;
  return (
    <dl className="space-y-1 p-2">
      <Row label="Name" value={entity.name} />
      {kindLabel === null ? null : <Row label="Kind" value={kindLabel} />}
      <Row label={t.term('field').other} value={String(fieldCount)} />
      {entity.propsRedacted === true ? (
        <p className="pt-1 text-xs text-text-subtle">Some properties are hidden from you.</p>
      ) : null}
    </dl>
  );
}

function FieldDetails({ field }: { readonly field: Field }) {
  const facet = useEngine();
  const { TypeBadge } = useEngineUi();
  if (field.restricted === true) return <Restricted />;
  const resolved = facet.typeCatalog.resolve(field.type, { customTypes: [], namespaceName: null });
  return (
    <dl className="space-y-1 p-2">
      <Row label="Name" value={field.name} />
      <dt className="text-xs text-text-subtle">Type</dt>
      <dd>
        {TypeBadge === undefined ? (
          resolved.display
        ) : (
          <TypeBadge resolved={resolved} compact={false} />
        )}
      </dd>
      <Row label="Nullable" value={field.isNullable ? 'yes' : 'no'} />
    </dl>
  );
}

function LinkRow({
  projectId,
  link,
  entities,
  readOnly,
}: {
  readonly projectId: Id;
  readonly link: Link;
  readonly entities: Readonly<Record<Id, Entity>>;
  readonly readOnly: boolean;
}) {
  const t = useTerminology();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  // R19: no destructive affordance on a link touching a stub (the API 403s it).
  const touchesStub =
    link.restricted === true ||
    entities[link.from.entityId]?.restricted === true ||
    entities[link.to.entityId]?.restricted === true;
  const name = (id: Id): string => {
    const entity = entities[id];
    if (entity === undefined) return '?';
    return entity.restricted === true ? 'restricted' : entity.name;
  };
  return (
    <li className="flex items-center rounded border border-border px-2 py-1 text-xs text-text-muted">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono">{name(link.from.entityId)}</span>
        <span className="px-1 text-text-subtle">{link.cardinality}</span>
        <span className="font-mono">{name(link.to.entityId)}</span>
        {failed ? <span className="pl-1 text-danger-text">not deleted</span> : null}
      </span>
      {touchesStub || readOnly ? null : (
        <button
          type="button"
          aria-label={t.msg('action.delete', 'link')}
          title={t.msg('action.delete', 'link')}
          className="rounded p-0.5 text-text-subtle hover:bg-surface-hover hover:text-danger-text"
          onClick={() => {
            setFailed(false);
            postOps(queryClient, projectId, [deleteLinkOp(link)]).catch(() => {
              setFailed(true);
            });
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-xs text-text-subtle">{label}</dt>
      <dd className="truncate text-text">{value}</dd>
    </>
  );
}
